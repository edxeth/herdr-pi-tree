'use strict';

// The sidebar line for each agent pane, and the grouping around it.
//
// Everything a pane shows is packed into ONE token, because Herdr joins
// adjacent row cells with `·` and there is no way to turn that off. One token
// also means one colour per line — which is exactly what is wanted here, since
// the colour carries the state.
//
// State is encoded in *which* token name is set (`state_working`,
// `state_done`, …), because Herdr's row styles are static: a style is bound to
// a token name, not to its value, so "turn red when blocked" is only
// expressible as "publish a differently-named token that the row paints red".
// The names not in use must be cleared explicitly or the old one keeps
// rendering beside the new.

const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');

const herdr = require('./herdr');
const config = require('./config');
const hook = require('./hook');
const { stateRoot, ensureDir } = require('./paths');
const { logoFor, stateGlyph } = require('./logos');
const palette = require('./palette');
const GIT_FIELDS = ['branch','added','removed','ahead'];
const GIT_LEGACY = ['git_summary','git_counts','space_git_inline','space_git_line','heading_git_inline','heading_git_line','git_behind'];

// Pi's session_info name is the real session title; a pane whose terminal
// title is a bare tool label ('subagent') still knows its session.
const sessionNameCache = new Map();
// The sessions root, where readSessionName's id-form refs are resolved.
function sessionsRoot() {
  return process.env.PI_CODING_AGENT_DIR
    ? path.join(process.env.PI_CODING_AGENT_DIR, 'sessions')
    : path.join(require('node:os').homedir(), '.pi', 'agent', 'sessions');
}

// Names are cached against the file's revision — bigint mtimeNs, inode and
// size; a plain statSync does not expose mtimeNs on this runtime, which once
// left the revision tracking size alone — and not for the daemon's life:
// session titles are renamed at runtime, by the user or by an auto-titling
// extension mid-conversation, and a pinned name would freeze the row on
// whatever the file said when the pane was first seen. A re-read is
// conditional: an unchanged file costs a stat, a grown one reads only the
// bytes appended since the last look (a rename appends a session_info at
// the tail), so a multi-megabyte transcript is scanned in full once and
// never slurped again on the refresh path — whole 40 MB sessions exist. A
// pane whose file does not exist yet retries after NAME_RETRY_MS, and so
// does a FAILED read: the error is never recorded as a revision, the last
// name stays up, and the next window tries again.
const NAME_RETRY_MS = 5000;
const NAME_CHUNK_BYTES = 1024 * 1024;

// Parses complete JSONL lines out of `file` starting at byte `from`,
// carrying a known `name` forward: the last session_info.name wins, and an
// unnamed session falls back to its first user message — the task the
// subagent was actually given. Chunks go through a StringDecoder so a
// multi-byte character split across a read boundary cannot corrupt a name;
// a trailing partial line fails to parse and is read again next time.
// Returns the advanced byte offset alongside the name.
function scanSessionFile(file, from, name) {
  const fd = fs.openSync(file, 'r');
  try {
    const decoder = new StringDecoder('utf8');
    const chunk = Buffer.allocUnsafe(NAME_CHUNK_BYTES);
    let offset = from;
    let pending = '';
    const consume = (text) => {
      for (const line of text.split('\n')) {
        if (!line.includes('session_info') && name === null && !line.includes('\"role\":\"user\"')) continue;
        if (!line.includes('session_info') && (name !== null || !line.includes('\"role\":\"user\"'))) continue;
        try {
          const obj = JSON.parse(line);
          if (line.includes('session_info')) {
            const candidate = obj.name ?? obj.session?.name;
            if (typeof candidate === 'string' && candidate.trim()) name = candidate.trim();
          } else if (name === null) {
            const content = obj.message?.content;
            const body = typeof content === 'string' ? content
              : Array.isArray(content) ? content.map((part) => typeof part?.text === 'string' ? part.text : '').join(' ') : '';
            const first = body.split('\n')[0].trim();
            if (first) name = first;
          }
        } catch { /* partial or non-JSON line */ }
      }
    };
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, offset);
      if (read <= 0) break;
      offset += read;
      pending += decoder.write(chunk.subarray(0, read));
      const whole = pending.lastIndexOf('\n');
      if (whole >= 0) {
        consume(pending.slice(0, whole));
        pending = pending.slice(whole + 1);
      }
    }
    pending += decoder.end();
    if (pending) consume(pending);
    return { name, offset };
  } finally {
    fs.closeSync(fd);
  }
}

function readSessionName(ref, now = Date.now()) {
  if (!ref || typeof ref !== 'string') return null;
  const hit = sessionNameCache.get(ref);
  const fresh = now - (hit?.at ?? -Infinity) < NAME_RETRY_MS;
  if (hit && fresh && hit.file === undefined) return hit.name;
  const file = hit?.file ?? resolveSessionFile(ref);
  if (!file) {
    sessionNameCache.set(ref, { at: now, name: hit?.name ?? null });
    return hit?.name ?? null;
  }
  let st;
  try {
    st = fs.statSync(file, { bigint: true });
  } catch {
    sessionNameCache.set(ref, { at: now, name: hit?.file === file ? hit.name : null });
    return hit?.file === file ? hit.name : null;
  }
  const rev = `${st.mtimeNs}:${st.ino}:${st.size}`;
  if (hit && hit.file === file && hit.rev === rev) {
    hit.at = now;
    return hit.name;
  }
  if (hit && fresh) return hit.name; // changed, but the window is still open
  // Same inode and strictly grown: only the appended bytes are new. A
  // same-size or smaller file was rewritten in place, so nothing carries.
  const carry = hit && hit.file === file && hit.ino === st.ino && st.size > hit.offset;
  try {
    const scan = scanSessionFile(file, carry ? hit.offset : 0, carry ? hit.name : null);
    sessionNameCache.set(ref, { at: now, name: scan.name, rev, file, ino: st.ino, offset: scan.offset });
    return scan.name;
  } catch {
    sessionNameCache.set(ref, { at: now, name: hit?.file === file ? hit.name : null });
    return hit?.file === file ? hit.name : null;
  }
}

// Session file per ref, cached on success only: a pane's ref is stable while
// its agent lives, but a just-spawned pane's file may not exist yet, and a
// cached miss would pin that pane outside the tree forever.
const sessionFileCache = new Map();
function resolveSessionFile(ref) {
  if (!ref || typeof ref !== 'string') return null;
  if (sessionFileCache.has(ref)) return sessionFileCache.get(ref);
  let file = null;
  try {
    if (ref.endsWith('.jsonl') && fs.existsSync(ref)) file = ref;
    else {
      const root = sessionsRoot();
      for (const dir of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
        if (!dir.isDirectory()) continue;
        const match = fs.readdirSync(path.join(root, dir.name)).find((f) => f.endsWith('_' + ref + '.jsonl'));
        if (match) { file = path.join(root, dir.name, match); break; }
      }
    }
  } catch { /* degrade to no file */ }
  if (file) sessionFileCache.set(ref, file);
  return file;
}

// The parent session a subagent's own session header names: the spawner
// stamps "parentSession" into the first line at spawn, re-stamped per level,
// so grandchild chains are complete without any depth counter. First line
// only — session files grow without bound and the header never moves.
// null = header read, no parent; undefined = not readable (not cached, so a
// file that appears later is still picked up).
const parentSessionCache = new Map();
function readParentSession(file) {
  if (!file || typeof file !== 'string') return undefined;
  if (parentSessionCache.has(file)) return parentSessionCache.get(file);
  let parent = undefined;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(64 * 1024);
      const read = fs.readSync(fd, head, 0, head.length, 0);
      const end = head.indexOf(10, 0, 'utf8');
      const line = head.toString('utf8', 0, end >= 0 && end < read ? end : read);
      const candidate = JSON.parse(line)?.parentSession;
      parent = typeof candidate === 'string' && candidate.endsWith('.jsonl') ? candidate : null;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  parentSessionCache.set(file, parent);
  return parent;
}

// Child pane -> parent pane among live entries, from session headers. Only
// edges that stay inside one workspace count: a subagent re-homed to another
// workspace is a peer there, not a branch. Cycles drop the walking child's
// edge (headers are machine-written, but a corrupt chain must not hang the
// frame); a dropped edge degrades to the workspace's fallback nesting.
//
// `sameWorkspace: false` keeps the re-homed edges. Nesting must not use them,
// but counting must: that child still draws a row of its own, wherever it
// ended up, so its parent's badge must not count it a second time.
function parentEdges(entries, { sameWorkspace = true } = {}) {
  const bySession = new Map();
  const byPane = new Map();
  for (const entry of entries) {
    byPane.set(entry.pane, entry);
    const file = resolveSessionFile(entry.session);
    if (file) bySession.set(file, entry.pane);
  }
  const edges = new Map();
  for (const entry of entries) {
    const own = resolveSessionFile(entry.session);
    if (!own) continue;
    const parentPath = readParentSession(own);
    if (!parentPath) continue;
    const parentPane = bySession.get(parentPath);
    if (!parentPane || parentPane === entry.pane) continue;
    const parent = byPane.get(parentPane);
    if (!parent) continue;
    if (sameWorkspace && (!entry.workspace || parent.workspace !== entry.workspace)) continue;
    edges.set(entry.pane, parentPane);
  }
  for (const child of [...edges.keys()]) {
    const seen = new Set([child]);
    let at = edges.get(child);
    while (at !== undefined && !seen.has(at)) {
      seen.add(at);
      at = edges.get(at);
    }
    if (at !== undefined) edges.delete(child);
  }
  return edges;
}

// `idle_fresh` and `idle_stale` are idle split by how long ago the pane last
// worked (lib/activity.js). Herdr knows nothing about them — they exist only as
// token names, which is exactly how this plugin colours anything (quirks §1).
const STATES = ['working', 'done', 'blocked', 'idle_fresh', 'idle', 'idle_stale', 'unknown'];

// Three names for one glyph. Herdr 0.9 colours a token by its VALUE, and a
// logo's value IS the vendor's glyph, so the vendor's colour needs no name of
// its own: the sidebar block carries a rule per vendor instead of the
// duplicated row per vendor `rows_by_agent` used to cost. What a rule cannot
// read is the state, which is not in the value — working is bold, and a stale
// row's logo leaves the brand behind to grey out with the rest of the row.
const LOGO_TOKENS = ['logo', 'logo_working', 'logo_stale'];

// The corner that hangs a split pane off the one it was split from. Its own
// token because a cell is one colour: sharing the logo's cell painted the
// corner in the vendor's brand, and structure should not read as loud as the
// thing it holds. The cost is the separator Herdr puts between two cells.
const SPLIT_TOKEN = 'split_mark';
const BADGE_TOKEN = 'bg_count';
const HEADING_BADGE_TOKEN = 'bg_heading';

// The per-state logo names this plugin published before 2.0. A pane that was
// last painted by an older version still carries one; the daemon clears them
// once at startup (lib/daemon.js) so an upgrade does not leave a second logo
// sitting in the row.
const LEGACY_LOGO_TOKENS = [
  ...STATES.map((state) => `logo_${state}`),
  'logo_working_dim',
];

// Each idle shade has its own mark (● ○ ·), so nothing collapses here. Shape
// carries the distinction rather than colour alone, because a colour's meaning
// flips with the background — the same grey that reads as prominent on a dark
// terminal reads as faded on a light one, which is exactly how the first
// attempt at this came out backwards.
function baseState(display) {
  return display;
}

// Herdr trims leading whitespace off a token value, so a plain-space indent
// disappears. A zero-width space is a format character rather than whitespace:
// it survives the trim and protects the spaces after it.
const INDENT =
  config.groupIndentWidth > 0 ? `​${' '.repeat(config.groupIndentWidth)}` : '';

// A worktree's sessions sit one level deeper than the checkout they hang off,
// so the branch drawn on their header has something to enclose. One zero-width
// space and double the spaces — not INDENT twice, which would bury a second
// format character mid-string for no reason.
const CHILD_INDENT =
  config.groupIndentWidth > 0 ? `​${' '.repeat(config.groupIndentWidth * 2)}` : '';

// The panes of one tab are one split screen: they were opened together, they
// are looked at together, and the sidebar lists them as unrelated siblings
// unless something says otherwise. The first of them keeps its place in the
// group and the rest hang under it, which needs one level deeper than a
// worktree's sessions already use.
const SPLIT_INDENT =
  config.groupIndentWidth > 0 ? `​${' '.repeat(config.groupIndentWidth * 3)}` : '';

// Indent by depth, so a caller adds levels instead of naming them.
const INDENTS = ['', INDENT, CHILD_INDENT, SPLIT_INDENT];

// Signal files live in stateRoot, not the system temp dir: the daemon watches
// one directory for every self-owned signal (stop marker, view flag), and
// temp-cleaning tools that delete a watched directory kill the watcher
// silently. stateRoot is ours and nobody sweeps it.
const LOCK = () => path.join(ensureDir(stateRoot), 'animator.pid');
const STOP = () => path.join(ensureDir(stateRoot), 'animator.stop');

function pidAlive(pid) {
  try {
    process.kill(pid, 0); // signal 0 only tests for existence
    return true;
  } catch (error) {
    return error.code === 'EPERM'; // alive, just not ours to signal
  }
}

function animatorRunning() {
  try {
    return pidAlive(Number.parseInt(fs.readFileSync(LOCK(), 'utf8').trim(), 10));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------- collection */

// Codex animates its own attention marker into the terminal title while it
// waits for an answer, alternating `[ ! ]` with `[ . ]` about once a second.
// Herdr strips the spinner it puts there itself, but this one is the agent's,
// so it arrives in the title.
//
// Nothing on this side blinks: the row marks the state with a static `?`,
// so keeping the bracket would make the agent's spinner the only moving thing
// in the line — the arrangement this plugin avoided when it moved the spinner
// off the logo. It also rewrites the title token every second for a change
// that says nothing new. The words after the bracket are real ("Action
// Required | <plugin>"), so only the bracket goes.
const VENDOR_PULSE = /^\[\s*[!.·]\s*]\s*/;

function stripVendorPulse(title) {
  return typeof title === 'string' ? title.replace(VENDOR_PULSE, '') : '';
}

// The spawner owns lifecycle facts; this plugin alone owns display tokens.
// Session equality excludes reused panes/foreign parents. The timestamp also
// bounds cached or malformed metadata independently of Herdr's source TTL.
// Allow one extra TTL for collection latency relative to the frame timestamp.
// Delegations this pane's session still owes; 0 when the metadata is absent,
// expired, malformed or written for another session.
function delegatedCount(agent, tokens, now) {
  if (agent.agent !== 'pi') return 0;
  const identity = agent.agent_session;
  if (identity?.agent !== 'pi' || identity.kind !== 'path' || typeof identity.value !== 'string' || !identity.value) return 0;
  const token = tokens.pi_subagents_work_v1;
  if (typeof token !== 'string') return 0;
  const work = /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/.exec(token);
  if (!work) return 0;
  const [, sessionHash, rawCount, rawExpiry] = work;
  const count = Number(rawCount);
  const expiresAt = Number(rawExpiry);
  if (!Number.isSafeInteger(count) || count <= 0) return 0;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + 60000) return 0;
  if (sessionHash !== createHash('sha256').update(identity.value, 'utf8').digest('base64url')) return 0;
  return count;
}

function delegatedStatus(agent, tokens, now) {
  const native = agent.agent_status;
  if (!['idle', 'done'].includes(native) || agent.agent !== 'pi') return native;
  return delegatedCount(agent, tokens, now) > 0 ? 'working' : native;
}

// One entry per live agent pane, with everything a frame needs. Null when the
// list could not be fetched at all — which is not the same as no agents.
async function snapshot(now = Date.now()) {
  const agents = await herdr.agentsAsync();
  if (agents === null) return null;
  return agents.flatMap((a) => {
    const pane = a.pane_id;
    const status = a.agent_status;
    if (typeof pane !== 'string' || typeof status !== 'string') return [];
    const tokens = a.tokens && typeof a.tokens === 'object' ? a.tokens : {};
    return [
      {
        pane,
        status: delegatedStatus(a, tokens, now),
        subs: delegatedCount(a, tokens, now),
        name: hook.apply('agent', a.agent ?? '', pane),
        session: a.agent_session?.value ?? '',
        cwd: a.foreground_cwd ?? a.cwd ?? '',
        seq: a.state_change_seq ?? 0,
        git: Object.fromEntries(GIT_FIELDS.map(field=>[field, tokens[`git_${field}`] ?? null])),
        sub: handleTag((a.terminal_title_stripped ?? '').replace(/^(?:π|pi)\s*[·|\-—]\s*/i, '')) !== null,
        title: hook.apply('title', stripVendorPulse(a.terminal_title_stripped), pane),
        focused: Boolean(a.focused),
        tab: a.tab_id ?? '',
        workspace: a.workspace_id ?? '',
        // What the sidebar is showing right now. A held "done" cannot live in
        // this process — the animator exits as soon as nothing is animating —
        // so the published token doubles as the record.
        showing: Object.keys(tokens)
          .find((key) => key.startsWith('state_'))
          ?.slice('state_'.length),
        // The sort keys the panel's view is ordering rows on, straight from
        // the server. A settled write is not a promise it still holds them:
        // Herdr can restart under a living daemon (an update does it) and
        // pane metadata dies with the old process. The frame compares these
        // with what it would write and republishes on disagreement, so the
        // panel's row order cannot drift from the indices it is showing.
        sort: { sort_key: tokens.sort_key ?? null, ws_key: tokens.ws_key ?? null, tab_key: tokens.tab_key ?? null },
      },
    ];
  });
}

const cache = {
  at: 0,
  tabs: new Map(),
  workspaces: new Map(),
  parents: new Map(),
  worktrees: new Map(),
};
const LABEL_TTL_MS = 5000;

// Which workspaces are Git worktrees cut from another open one, child -> parent.
//
// Herdr draws that tree in the Spaces panel natively and offers the Agents
// panel nothing: its rows take a fixed set of built-in cells plus our `$`
// tokens, and there is no depth among them. So the tree over there has to be
// drawn, and this is the input — free, because `workspace.list` already
// carries a `worktree` object per workspace and this function already calls it
// for the labels. Members of one repo share `repo_key`; the one that is not a
// linked worktree is the checkout the others were cut from.
//
// A repo whose main checkout is not open as a workspace yields no parent at
// all: its worktrees are top-level here, which is what they look like.
function worktreeParents(list) {
  const byRepo = new Map();
  // Every linked worktree, with the repo it was cut from. `repo_name` is on the
  // worktree object itself, so this survives the case the parents map cannot
  // cover: a worktree whose main checkout is not open as a workspace at all.
  const worktrees = new Map();
  for (const ws of list) {
    const key = ws.worktree?.repo_key;
    if (typeof key !== 'string' || typeof ws.workspace_id !== 'string') continue;
    if (ws.worktree.is_linked_worktree === true) {
      worktrees.set(ws.workspace_id, ws.worktree.repo_name ?? null);
    }
    if (!byRepo.has(key)) byRepo.set(key, []);
    byRepo.get(key).push(ws);
  }
  const parents = new Map();
  for (const members of byRepo.values()) {
    if (members.length < 2) continue;
    const parent = members.find((ws) => ws.worktree.is_linked_worktree === false);
    if (!parent) continue;
    for (const ws of members) {
      if (ws.workspace_id !== parent.workspace_id) parents.set(ws.workspace_id, parent.workspace_id);
    }
  }
  const families=new Set([...byRepo.entries()].filter(([,members])=>members.length>=2).map(([key])=>key));
  return { parents, worktrees, families };
}

// Tab and workspace labels, cached. A tab's label cannot be derived from its
// id: ids are unique per session (`w4:t5`) while labels restart per workspace,
// so `w4:t5` can be labelled 1.
async function labels(now) {
  if (now - cache.at < LABEL_TTL_MS && cache.tabs.size > 0) return cache;
  const tabs = new Map();
  for (const tab of await herdr.tabsAsync()) {
    if (typeof tab.tab_id === 'string' && typeof tab.label === 'string') tabs.set(tab.tab_id, tab.label);
  }
  const list = await herdr.workspacesAsync();
  const workspaces = new Map();
  for (const ws of workspaceOrder(list)) {
    if (typeof ws.workspace_id === 'string' && typeof ws.label === 'string') {
      // A linked worktree's label is its branch name; the two go through
      // different hook functions because they read differently.
      const kind = ws.worktree?.is_linked_worktree === true ? 'branch' : 'workspace';
      workspaces.set(ws.workspace_id, hook.apply(kind, ws.label, ws.workspace_id));
    }
  }
  const { parents, worktrees, families } = worktreeParents(list);
  const info = new Map();
  for (const ws of list) {
    if (typeof ws.workspace_id === 'string') info.set(ws.workspace_id, {git: Object.fromEntries(GIT_FIELDS.map(field=>[field, ws.tokens?.[`git_${field}`] ?? null])), linked: ws.worktree?.is_linked_worktree === true});
  }
  if (tabs.size > 0) Object.assign(cache, { at: now, tabs, workspaces, parents, worktrees, families, info });
  return cache;
}

// Mirror Herdr's expanded Spaces order: a checkout and its linked worktrees
// remain together even when their raw workspace positions are interleaved.
function workspaceOrder(list) {
  const families=new Map();
  for (const ws of list) {
    const key=ws.worktree?.repo_key;
    if (key) {
      if (!families.has(key)) families.set(key,[]);
      families.get(key).push(ws);
    }
  }
  const emitted=new Set(),result=[];
  for (const ws of list) {
    const key=ws.worktree?.repo_key, members=families.get(key) ?? [];
    const parent=members.find(w=>w.worktree.is_linked_worktree===false);
    if (members.length<2 || !parent) {result.push(ws);continue;}
    if (emitted.has(key)) continue;
    emitted.add(key);result.push(parent,...members.filter(w=>w!==parent));
  }
  return result;
}

// Titles that begin with the workspace's own name, under a group header that
// already says it: the name is written twice on every row and eats the width
// the rest of the title needs. Claude Code used to compose titles that way and
// Herdr's own fallback title still does (`<workspace> · <prompt> · <session>`),
// so this is not one agent's quirk to wait out.
//
// Only an exact header match followed by a separator is dropped, and only when
// something is left over — `billing · billing` keeps its tail, `api-gateway`
// under a header of `api` is untouched because the boundary is not there. The
// caller passes an empty label in the flat view, where no header exists and the
// workspace name is the only context a row carries.
const PREFIX_SEPARATOR = /^(?:\s*[·・‧|»]\s*|\s*:\s+|\s+[-—–]\s+)/;

function trimGroupPrefix(title, label) {
  if (!label || !title.startsWith(label)) return title;
  const rest = title.slice(label.length);
  const separator = rest.match(PREFIX_SEPARATOR);
  if (!separator) return title;
  return rest.slice(separator[0].length).trim() || title;
}

// The pane's terminal title is a status line, not a name. Pi's own shape is
// 'π - <session> - <cwd>', but before a session is named it is just the cwd,
// and a pane-title extension (the ghostty one did) rewrites it several times
// a second: a spinner frame and the running tool while working, the model id
// whenever idle. Every one of those shapes reached the sidebar as a "title",
// so the pane title is no longer a source of row text. The session file is
// the only thing that holds the real one — the spawner seeds its child
// sessions with the task itself — so a row shows the session's recorded name
// (its first user message, when it was never named) or Untitled. The one
// thing still read off the pane title is a leading [handle], the spawner's
// own mark, so a subagent row keeps reading 'handle: task'.

// The spawner's [handle] tag at the head of a pane title, a session name or
// a tab label. Word-like tags only — [designer] is a subagent, [7bc11997] is
// a commit — and the inside is checked too: a hash that starts with a letter
// ([e49336a7], in a session the user named after a commit) spells a word to
// the tag shape, so a run of pure hex of git hash length is a commit ref,
// never a handle. `tail` is what must follow the closing bracket: a pane
// title and a tab label need a separator, a session name may end at its tag.
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i;
function handleTag(text, tail = /(\s|$)/) {
  const tag = /^\[([a-z][a-z0-9_-]{0,31})\]/i.exec(text);
  return tag && tail.test(text.slice(tag[0].length)) && !COMMIT_HASH.test(tag[1]) ? tag : null;
}

function compactTitle(entry, header = '', cap = 28) {
  let title = (readSessionName(entry.session) ?? '').trim();
  // The spawner seeds the child's session NAME with its own [handle] tag, and
  // the pane title carries the same tag; each is a handle source and the row
  // says it once.
  const nameTag = handleTag(title, /\s*/);
  if (nameTag) title = title.slice(nameTag[0].length).trim();
  const paneTag = handleTag(
    // Detection only, never display: tolerate a spinner frame a pane-title
    // extension wrote ahead of pi's own header.
    String(entry.title ?? '').replace(/^(?:[◐◓◑◒●○]\s*)?(?:π|pi)\s*[·|\-—]\s*/i, ''),
  );
  const handle = paneTag?.[1] ?? nameTag?.[1];
  if (handle) title = title ? `${handle}: ${title}` : handle;
  // A session record is a pi thing; another agent's kind stands in.
  title = trimGroupPrefix(title, header).trim() || (entry.name && entry.name !== 'pi' ? entry.name : 'Untitled');
  const characters = [...title];
  return characters.length > cap ? characters.slice(0,cap-1).join('').trimEnd() + '…' : title;
}


/* ---------------------------------------------------------------- writing */

// The line, split where its colours want to split: the state mark carries the
// freshness tier, the label carries the vendor. They are two tokens because a
// token is one colour — the cost is the ` · ` Herdr puts between any two
// visible cells in a row, which is the same trade the Spaces list already
// makes to keep each vendor's logo in its own brand colour.
function composeLine(entry, display, tabLabel, indent, step = 0, corner = '') {
  const glyph = stateGlyph(baseState(display));
  if (!glyph) return null;

  const mark = [];
  if (tabLabel) mark.push(tabLabel);
  mark.push(glyph);

  // An entry is ONE row: `logo · title`. Everything else was repetition —
  // the vendor's name says what its logo already said, and a state mark says
  // what the title's own colour now says. Two rows per session cost sixty
  // rows for thirty sessions, and the second one carried no information the
  // first did not.
  //
  // The mark is still composed, and still published: it is not rendered, but
  // `snapshot()` reads which `state_*` name is set to recover a held done
  // badge or an unanswered question after the daemon restarts.
  //
  // The indent belongs to whichever cell comes first, because Herdr only
  // hangs its own indent on an entry's continuation rows — and with one row
  // per entry, a member pane's row IS the first row.
  const logo = '';

  // Motion rides in front of the TITLE, not on the mark. A logo in a terminal
  // cell can only move a few pixels, and a few pixels of moving leg or eye is
  // a twitch you have to already be looking at; a spinner ahead of a sentence
  // has the whole row to be noticed from. It is also where the agents that
  // announce themselves put it — grok writes "- Thinking -" into its terminal
  // title — except doing it here covers every agent instead of the ones whose
  // CLI happens to.
  // Which states earn a mark in front of the title. The three idle tiers do
  // not: their colour already says how long ago, and a mark on every row is a
  // column of marks, which is no signal at all. The rest are events — still
  // running, finished and unseen, waiting on an answer, unrecognised — and an
  // event deserves something the eye catches without reading the colour.
  // Motion rides in front of the TITLE, not on the logo. A logo in a terminal
  // cell can only move a few pixels, and a few pixels of moving leg or eye is
  // a twitch you have to already be looking at; a spinner ahead of a sentence
  // has the whole row to be noticed from. Animating the logo itself was built
  // and dropped: the mark turned, one glyph baked per angle, and what stopped
  // it was not the drawing but the cadence — a token change that alters what
  // is rendered waits about 100ms for Herdr to answer, so nothing can run
  // faster than roughly six frames a second, which a turning shape shows as a
  // stagger and a spinner does not.
  // Fully static marks, nothing animates. Shape carries blocked apart from
  // working — their hues are near neighbours — and color carries the rest.
  const lead = display === 'working' ? '●' : display === 'blocked' ? '?' : display === 'done' ? '✓' : '○';
  const leadCell = lead ? `${lead} ` : '';
  // The tab label, when asked for, rides in front of the title too: the mark
  // that used to carry it is published but no longer rendered.
  const tab = tabLabel ? `${tabLabel} ` : '';
  return {
    mark: mark.join(' '),
    // The corner carries the indent when it is there, because it is drawn
    // first; without one the logo carries it, as before.
    split: corner ? indent + corner : '',
    logo: logo ? (corner ? '' : indent) + logo : '',
    titlePrefix: (logo || corner ? '' : indent) + tab + leadCell,
  };
}

// The mark and the count, or '' when there is nothing to say. `where` is the
// placement this badge is for; it draws only when the configured placement
// matches, so each caller asks for its own and the rest collapse.
function composeBadge(count, where, indent = '') {
  if (!(count > 0) || config.bgBadge !== where) return '';
  return `${indent}${config.STATIC_GLYPH.delegated}${count}`;
}

// The title travels the same one-token-per-state road as the state line
// (`title_working`, `title_idle_stale`, …), for the same reason: row styles
// are static per token name, so "dim the title when its session is stale" is
// only expressible as a differently-named token the row paints dim. The value
// is Herdr's own terminal title, republished under a state-coloured name.
// Both resolve to whether the write actually landed. Callers cache "what this
// pane shows" to skip redundant writes, and caching a FAILED write pins the
// pane to a token it never got — a transient socket timeout then reads as a
// permanently wrong (or missing) line until the value happens to change.
// Three token families, all keyed by state: the vendor label, the state mark,
// the title. Keying the LABEL by state as well is what lets a stale session
// recede as a whole — its logo and name fade with its mark and title instead
// of staying in full brand colour, which is the entry's loudest ink. Only one
// member of each family is ever set, so a row holding a whole family still
// renders a single cell and pays no separator.
// One report may carry at most 16 tokens — the whole patch is rejected past
// that, not truncated, and a rejected patch is silent from the sidebar's side:
// the row simply never appears. Three seven-member families plus the sort keys
// is 21, so every write here goes out in chunks.
const MAX_TOKENS_PER_REPORT = 16;

function reportChunked(source, pane, tokens) {
  const names = Object.keys(tokens);
  const chunks = [];
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) patch[name] = tokens[name];
    chunks.push(herdr.reportMetadataAsync(pane, source, patch));
  }
  return Promise.all(chunks).then((results) => results.every(Boolean));
}

// Workspace twin: Spaces payloads also cross the 16-token ceiling.
function reportWorkspaceChunked(source, workspaceId, tokens) {
  const names = Object.keys(tokens);
  const chunks = [];
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) patch[name] = tokens[name];
    chunks.push(herdr.reportWorkspaceMetadataAsync(workspaceId, source, patch));
  }
  return Promise.all(chunks).then((results) => results.every(Boolean));
}

// Four token families, every one keyed by state: vendor logo, vendor name,
// state mark, title. Keying all four — not just the mark — is what lets a
// stale session recede as a WHOLE: logo, name and title fade together rather
// than the logo sitting there in full brand colour, which is an entry's
// loudest ink. Only one member of a family is ever set, so a row holding
// whole families still renders one cell per family.
// `working` publishes its logo under one of TWO names, alternating with the
// caller's `pulse` phase. The row config paints one plainly and the other
// with `dim`, so the mark breathes in its own brand colour — and it breathes
// by way of the terminal's dim rendering, which blends toward whatever is
// actually behind the panel. A hand-picked darker hex cannot: the direction
// that reads as "faded" flips between a light and a dark panel, and neither
// knows about a wallpaper showing through.
// The tokens a pane should be carrying for this frame, as a plain map. Split
// out from the write so a caller can compare it with what it sent last time:
// a frame of the working animation changes exactly two of these thirty-odd
// entries, and sending the other twenty-eight again costs a round trip Herdr
// answers in its own time — at four working panes that was fifty writes a
// second, which the server met with rising latency until the animation
// stuttered.
function stateTokens(display, line, title, badge = '') {
  const tokens = {};
  tokens[BADGE_TOKEN] = badge || null;
  // One logo, under whichever name carries the style this frame needs. The
  // other three are cleared: which name holds the glyph is the whole signal.
  for (const name of LOGO_TOKENS) tokens[name] = null;
  tokens[SPLIT_TOKEN] = line.split || null;
  if (line.logo) {
    const name =
      display === 'working'
        ? 'logo_working'
        : display === 'idle_stale'
          ? 'logo_stale'
          : 'logo';
    tokens[name] = line.logo;
  }
  for (const state of STATES) {
    const current = state === display;
    // The vendor's name is gone from the layout; keep nulling its old token
    // so a pane that has one from a previous version loses it.
    tokens[`name_${state}`] = null;
    tokens[`state_${state}`] = current ? line.mark : null;
    tokens[`title_${state}`] = current && title ? line.titlePrefix + title : null;
  }
  return tokens;
}

// Only what differs from `sent`. Null means clear, and a key that was already
// null is not worth clearing again.
function tokenDelta(tokens, sent) {
  const delta = {};
  for (const [name, value] of Object.entries(tokens)) {
    if ((sent?.[name] ?? null) !== (value ?? null)) delta[name] = value;
  }
  return delta;
}

function writeTokens(source, pane, tokens) {
  return reportChunked(source, pane, tokens);
}

function clearState(source, pane) {
  const tokens = { agent_index: null, sort_key: null, ws_key: null, tab_key: null, [SPLIT_TOKEN]: null, [BADGE_TOKEN]: null, [HEADING_BADGE_TOKEN]: null };
  for (const field of GIT_FIELDS) {tokens[`git_${field}`]=null;tokens[`heading_git_${field}`]=null;tokens[`gitline_${field}`]=null;}
  for (const name of LOGO_TOKENS) tokens[name] = null;
  for (const state of STATES) {
    tokens[`name_${state}`] = null;
    tokens[`state_${state}`] = null;
    tokens[`title_${state}`] = null;
  }
  return reportChunked(source, pane, tokens);
}

// The first pane of each workspace carries the name; the last carries a spacer.
// Herdr's Agents list has no group headers of its own — `agent_panel_sort =
// "spaces"` only orders entries — so a workspace with three tabs otherwise
// renders as three unrelated rows that each repeat the workspace name.
function groupBoundaries(entries) {
  // Walk them in the order Herdr gave us, which is the order the sidebar draws.
  // Sorting by pane id here looked equivalent and was not: ids are handed out
  // as p1..p9 then pA.., while the list follows layout, so a workspace ending
  // pN, pM, pK put the spacer on pN — three rows above the actual end, opening
  // a blank line through the middle of a group.
  const heads = new Set();
  const tails = new Map();
  for (const entry of entries) {
    if (!entry.workspace) continue;
    if (!tails.has(entry.workspace)) heads.add(entry.pane);
    tails.set(entry.workspace, entry.pane);
  }
  return { heads, tails: new Set(tails.values()) };
}

// `ok` reports whether every write landed; a caller that remembers "groups
// are current" off a partial failure leaves a header on the wrong pane until
// the membership happens to change again.
async function writeGroups(source, entries, wsLabels, staleWorkspaces = new Set(), tree = {}) {
  const parentOf = tree.parentOf ?? new Map();
  // Worktrees on the list whose parent checkout is NOT — either it has no agent
  // running or it was never opened as a workspace. There is no pane to hang a
  // parent header on, so there is no tree to draw; the repo name goes inline
  // instead, which keeps the one thing the tree was there to say.
  const orphanRepo = tree.orphanRepo ?? new Map();
  const { heads, tails } = groupBoundaries(entries);
  // Which worktree closes its family, in the order the panel draws: that one
  // gets the corner, its siblings get a tee. Reading it off the display order
  // rather than the topology is what keeps the drawing honest when a sort
  // change moves a sibling.
  const lastChild = new Map();
  const order = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry.workspace || seen.has(entry.workspace)) continue;
    seen.add(entry.workspace);
    order.push(entry.workspace);
    const parent = parentOf.get(entry.workspace);
    if (parent) lastChild.set(parent, entry.workspace);
  }
  // A family reads as one block, so the spacer is held back wherever the next
  // group down is a worktree of this one. Left in, it would open a blank line
  // between a checkout and the branch hanging off it and undo the tree.
  const noGap = new Set();
  for (let i = 0; i < order.length - 1; i += 1) {
    if (parentOf.get(order[i + 1]) === order[i]) noGap.add(order[i]);
  }
  const results = await Promise.all(
    entries.map((entry) => {
      const parent = parentOf.get(entry.workspace);
      // The branch is part of the label, not a cell of its own: Herdr gives us
      // one token per row here, and it trims leading whitespace off token
      // values — hence INDENT's zero-width space carrying the offset.
      const mark = config.worktreeMark ? `${config.worktreeMark} ` : '';
      // An orphan gets a SYNTHESISED parent: its repo name goes on a row of its
      // own (`$group_parent`), which is what lets the tree stand up without a
      // parent pane to hang a header on. Squeezing the repo into this row
      // instead was tried first and the sidebar truncated it — and what it cut
      // was the branch name, the session's own identity.
      //
      // No INDENT on an orphan's corner: with the parent row above it, this row
      // is Herdr's own continuation row and arrives indented, exactly where a
      // real child's explicit INDENT puts it.
      const orphan = orphanRepo.has(entry.workspace);
      // The corner stays inside the group value (separate cells would get a
      // middot); the row config greys any heading that carries a corner.
      // CHILD_INDENT on the row-0 heading aligns its corner with the session
      // rows' corner column (row-1 gives those 3 cells Herdr adds).
      // Corner at the agents' corner column; sessions sit one level deeper.
      const corner = parent
        ? `${INDENT}${lastChild.get(parent) === entry.workspace ? '└' : '├'}─ ${mark}`
        : orphan
          ? `└─ ${mark}`
          : '';
      const name = heads.has(entry.pane) ? wsLabels.get(entry.workspace) ?? entry.workspace : null;
      const label = name === null ? null : `${corner}${name}`;
      // A workspace whose every session has gone stale fades its own name
      // too. Otherwise a screen of dormant projects still carries a column of
      // headers at full strength, and the fading underneath reads as damage
      // rather than as the whole thing being asleep.
      const stale = label !== null && staleWorkspaces.has(entry.workspace);
      const child = tree.parentOf?.has(entry.workspace) || tree.orphanRepo?.has(entry.workspace);
      // Chunked: the heading payload (group + Git fields + legacy clears)
      // exceeds Herdr's 16-tokens-per-report ceiling.
      return reportChunked(source, entry.pane, {
        group: stale ? null : label,
        split_mark: null,
        group_stale: stale ? label : null,
        // Always inline on the name row; a worktree child's label is its
        // branch, so its branch token stays empty — counts only, its own.
        ...Object.fromEntries(GIT_FIELDS.flatMap(field=>[
          [`heading_git_${field}`, name !== null && (field !== 'branch' || !child) ? entry.git?.[field] ?? null : null],
          [`gitline_${field}`, null],
        ])),
        ...Object.fromEntries(GIT_LEGACY.map(legacy=>[legacy,null])),
        // Only an orphan's head carries it; everywhere else the row collapses,
        // the same way an empty `group` collapses on a group's members.
        group_parent: orphan && name !== null ? orphanRepo.get(entry.workspace) : null,
        // The workspace's background helpers, totalled on its heading.
        [HEADING_BADGE_TOKEN]:
          (name !== null && composeBadge(tree.bgByWorkspace?.get(entry.workspace) ?? 0, 'heading')) || null,
        // A lone zero-width space: non-empty so Herdr draws the row, zero-width
        // so it reads as blank. It goes on the LAST pane of a group — a spacer
        // above a header would make the header a continuation row, and Herdr
        // indents those away from the left margin.
        gap: config.groupGap && tails.has(entry.pane) && !noGap.has(entry.workspace) ? '​' : null,
      });
    }),
  );
  return { heads, ok: results.every(Boolean) };
}

// Take the group furniture down. In the panel's priority order entries no
// longer sit workspace-contiguous, so a header pinned to "the first pane of
// its workspace" surfaces wherever that pane got sorted — a workspace title
// floating mid-queue over sessions it has nothing to do with.
async function clearGroups(source, entries) {
  const results = await Promise.all(
    entries.map((entry) =>
      reportChunked(source, entry.pane, {
        group: null,
        ...Object.fromEntries([...GIT_FIELDS.flatMap(field=>[`heading_git_${field}`,`gitline_${field}`]), ...GIT_LEGACY].map(legacy=>[legacy,null])),
        ...Object.fromEntries(GIT_LEGACY.map(legacy=>[legacy,null])),
        group_parent: null,
        group_stale: null,
        gap: null,
        [HEADING_BADGE_TOKEN]: null,
      }),
    ),
  );
  return { heads: new Set(), ok: results.every(Boolean) };
}

// Every pane token the state path owns. `harness_logo` is deliberately not
// here: agent-icons.js writes it and manages its own lifecycle.
const OWNED_TOKENS = [
  ...GIT_FIELDS.flatMap(field=>[`gitline_${field}`,`sgit_${field}`,`wgit_${field}`]),
  'git_counts',
  'heading_git_inline',
  'heading_git_line',
  ...GIT_LEGACY,
  'agent_index',
  'group',
  'group_parent',
  'group_stale',
  'gap',
  'sort_key',
  'ws_key',
  'tab_key',
  SPLIT_TOKEN,
  BADGE_TOKEN,
  HEADING_BADGE_TOKEN,
  ...LOGO_TOKENS,
  ...STATES.map((s) => `name_${s}`),
  ...STATES.map((s) => `state_${s}`),
  ...STATES.map((s) => `title_${s}`),
];

// Clear our tokens from panes that are not in `live` but still carry them.
// The animator's own cleanup only covers panes it wrote itself — its record is
// in-memory — so a token written by an earlier animator, on a pane whose agent
// exited while no animator ran, outlives every writer. A leftover `group` is a
// duplicate workspace header in the sidebar. Only our source is touched: the
// clear is a no-op for a same-named token some other plugin set.
async function sweepOrphans(source, live, names = OWNED_TOKENS) {
  const jobs = [];
  for (const pane of await herdr.panesAsync()) {
    const id = pane.pane_id;
    if (typeof id !== 'string' || live.has(id)) continue;
    const tokens = pane.tokens && typeof pane.tokens === 'object' ? pane.tokens : {};
    if (!names.some((name) => name in tokens)) continue;
    const clear = {};
    for (const name of names) clear[name] = null;
    jobs.push(reportChunked(source, id, clear)); // 25 owned names, 16 per report
  }
  return (await Promise.all(jobs)).every(Boolean);
}

/* ------------------------------------------------- workspace (Spaces) marks */

// The Spaces list gets the same glyph language as the agent rows: one mark per
// workspace, aggregated over its live agents. Colour is per token name, so
// `working` splits by vendor to keep the brand-colour scheme; every other
// state has one semantic token. A workspace with no live agent shows a
// neutral dot so its name stays aligned with the marked ones.
const SPACE_TOKENS = [
  'space_blocked',
  'space_working_claude',
  'space_working_codex',
  'space_working_grok',
  'space_working_other',
  'space_done',
  'space_idle',
  'space_unknown',
  'space_none',
  // Not states: the vendors alive in the workspace, as logo + name on their
  // own row. One token per vendor, so each keeps its brand colour — Herdr
  // separates the cells with `·`, which on a row of its own reads as a divider
  // rather than clutter. Packing them into a single cell would buy back those
  // few columns at the cost of painting every vendor the same grey.
  'space_logo_claude',
  'space_logo_codex',
  'space_logo_grok',
  'space_logo_other',
  // The workspace name; see writeSpaceState for why it is published at all.
  'space_label',
];

function spaceMark(display) {
  if (display === 'none') return '';
  if (display === 'done') return '✓';
  if (display === 'blocked') return '?';
  return display === 'working' ? '●' : '○';
}

// Which vendor tokens a workspace shows, as logo + name. They live on their
// own row under the workspace name, so there is room for the word — the logo
// alone reads as decoration until you have learned every mark.
//
// Exactly one named vendor → its own brand-coloured token. Anything else →
// everything packed into `multi` as one neutral cell, avoiding the forced `·`
// Herdr puts between cells.
function spaceLogoTokens(agents) {
  const out = {
    space_logo_claude: null,
    space_logo_codex: null,
    space_logo_grok: null,
    space_logo_other: null,
  };
  const seen = new Set();
  const others = [];
  for (const a of agents) {
    if (!a.name || seen.has(a.name)) continue;
    seen.add(a.name);
    const logo = logoFor(a.name);
    const label = logo ? `${logo} ${a.name}` : a.name;
    if (a.name === 'claude' || a.name === 'codex' || a.name === 'grok') {
      out[`space_logo_${a.name}`] = label;
    } else {
      others.push(label);
    }
  }
  if (others.length > 0) out.space_logo_other = others.join(' ');
  return out;
}

function writeSpaceState(source, workspaceId, tokenName, glyph, label = null, index = null, git = {}, linked = false) {
  const tokens = {};
  const mark = ['space_idle', 'space_none'].includes(tokenName) ? '' : glyph;
  const text=[index ? `${index}:` : null, mark, label].filter(Boolean).join(' ');
  for (const name of SPACE_TOKENS) tokens[name] = name === tokenName ? text : null;
  // The Spaces panel's name column. Herdr's built-in `workspace` cell always
  // draws the real label and a plugin cannot style it; publishing the label as
  // a token of our own puts the whole row under the managed sidebar block, so
  // it takes the same colour rules as everything else there.
  tokens.space_label = null;
  // Always inline: worktree members carry counts only (their label is the
  // branch), everything else shows branch plus counts.
  for (const field of GIT_FIELDS) {
    const value = field === 'branch' && linked ? null : git?.[field] ?? null;
    tokens[`sgit_${field}`] = value;
    tokens[`wgit_${field}`] = null;
  }
  return reportWorkspaceChunked(source, workspaceId, tokens);
}

function clearSpaceState(source, workspaceId) {
  const tokens = {};
  for (const name of SPACE_TOKENS) tokens[name] = null;
  return Promise.all([
    herdr.reportWorkspaceMetadataAsync(workspaceId, source, tokens),
    herdr.reportWorkspaceMetadataAsync(workspaceId, source, Object.fromEntries([...GIT_FIELDS.flatMap(f=>[`sgit_${f}`,`wgit_${f}`]), ...GIT_LEGACY].map(n=>[n,null]))),
  ]).then(results => results.every(Boolean));
}

// Everything this plugin painted, on every pane and workspace — the stop path.
// Two families stay: the title tokens, which the sidebar rows show the title
// THROUGH (clearing them blanks every entry, and a stopped plugin should leave
// a plain readable list, not an empty one), and the sort keys, which a view
// may still be ordering by (a frozen order beats a collapsed one). `purge`
// takes those too, plus the vendor logo agent-icons.js writes: the uninstall
// path, where the blocks that render them are about to go.
async function clearAll(source, { purge = false } = {}) {
  const names = purge
    ? [...OWNED_TOKENS, 'harness_logo']
    : OWNED_TOKENS.filter((name) => !name.startsWith('title_') && name !== 'sort_key' && name !== 'ws_key');
  await sweepOrphans(source, new Set(), names);
  await Promise.all(
    (await herdr.workspacesAsync())
      .filter((ws) => typeof ws.workspace_id === 'string')
      .map((ws) => clearSpaceState(source, ws.workspace_id)),
  );
}

module.exports = {
  clearAll,
  composeBadge,
  stateTokens,
  tokenDelta,
  writeTokens,
  STATES,
  LOGO_TOKENS,
  LEGACY_LOGO_TOKENS,
  baseState,
  SPACE_TOKENS,
  INDENT,
  CHILD_INDENT,
  SPLIT_INDENT,
  INDENTS,
  LOCK,
  STOP,
  pidAlive,
  animatorRunning,
  parentEdges,
  readSessionName,
  snapshot,
  labels,
  workspaceOrder,
  composeLine,
  clearState,
  spaceMark,
  spaceLogoTokens,
  writeSpaceState,
  clearSpaceState,
  groupBoundaries,
  trimGroupPrefix,
  compactTitle,
  handleTag,
  writeGroups,
  clearGroups,
  sweepOrphans,
  OWNED_TOKENS,
};
