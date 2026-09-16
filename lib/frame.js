'use strict';

// One frame of the sidebar, and the memory that carries between frames.
//
// A frame takes a fresh agent-list snapshot (the only source of truth; events
// are wake hints), decides what every pane should display, and writes the
// tokens that changed. What it remembers from frame to frame — which badge is
// held on which pane, what each pane last showed, when each pane last worked —
// lives on the Frame instance. The daemon (lib/daemon.js) owns the clock and
// the scheduler; this module owns the picture.

const herdr = require('./herdr');
const config = require('./config');
const state = require('./state');
const activity = require('./activity');
const view = require('./view');
const hook = require('./hook');

// One spinner step. The spinner ahead of a working title turns at this rate;
// faster reads as a blur, slower as a stutter. It is also how often the daemon
// wakes while anything works — the price of motion.
// One animation frame. Deliberately equal to the scheduler's POLL_MS
// (lib/daemon.js): our own token writes echo back as pane.updated events, and
// a wake inside the frame floor is refused and re-aimed at lastTick + POLL_MS.
// With any other cadence the animation lands on whichever of the two comes
// later, frame after frame, which is a stutter you can see — 140ms measured
// out as 150, 307, 247, 280.
const SPIN_MS = 1000; // One working-dot update per second; no spinner or blocked animation.
// One-pass title slide on the newly focused agent: readable speed, then stop.
// The longest a frame may sleep with nothing scheduled; watchers and events
// are accelerators, this is the guarantee.
const CATCH_ALL_MS = 30000;
const DONE_HOLD_FOREVER = Number.POSITIVE_INFINITY;
// A tick of the frame counter at minute grain: a working pane then costs one
// sort-key write a minute, and equal minutes compare as strings.
const NO_STAMP = '000000000000';
// One tree level for a nested subagent row: three columns, held past Herdr's
// leading-whitespace trim by a zero-width space. Deeper rows add guide cells
// in front — │ where an ancestor still has siblings below, spaces where the
// ancestor closed its branch — so every corner sits under its parent's.
const SUB_LEVEL = '​   ';

class Frame {
  constructor(source) {
    this.src = source;

    // Badges and holds.
    this.doneUntil = new Map(); // pane -> when its done badge expires (or forever)
    this.previous = new Map(); // pane -> the status it had last frame
    // Panes that asked something and have not gone back to work since, and
    // whether that pane had ever worked when it asked.
    this.blockedSince = new Map();
    this.blockedHeldWork = new Map();

    // Pane -> when it was last seen `working`. Herdr's screen-pattern
    // detection can misread a redraw gap as `idle` for a second or two
    // mid-turn (observed on macOS; Windows paces differently and does not
    // flap). Without a grace window every blip synthesises a done badge, so
    // the sidebar strobes green/spinner. Loaded rather than empty: the stamps
    // outlive any one daemon.
    this.lastWorkingAt = activity.load();
    // Panes whose missing activity stamp was already looked up once. Sessions
    // older than this plugin have no stamp, but the CLI's own session file
    // does remember them — recover it so they shade honestly instead of all
    // reading as plain idle. The lookup walks directories, so once per pane.
    this.recovered = new Set();

    // What each target last showed, so only changes are written.
    this.lastLine = new Map();
    // pane -> the token map last accepted, so a frame can send only the keys
    // that moved.
    this.lastTokens = new Map();
    this.lastSort = new Map();
    this.lastLogo = new Map();
    this.lastSpace = new Map();
    this.members = ''; // fingerprint of the last group layout written

    // Write-failure backoff, per target. A pane whose writes always fail must
    // not keep the daemon awake retrying every wake — that is a self-inflicted
    // busy loop. Failures back off exponentially to a minute.
    this.failedAt = new Map();
  }

  /* ------------------------------------------------------- write backoff */

  writable(key, now) {
    const failure = this.failedAt.get(key);
    return !failure || now >= failure.until;
  }

  settled(key, ok) {
    if (ok) {
      this.failedAt.delete(key);
      return true;
    }
    const failure = this.failedAt.get(key) ?? { count: 0, until: 0 };
    failure.count += 1;
    failure.until = Date.now() + Math.min(60000, 1000 * 2 ** Math.min(failure.count, 6));
    this.failedAt.set(key, failure);
    return false;
  }

  // Persist the activity stamps unconditionally; the daemon calls this on
  // its way out.
  flush() {
    activity.save(this.lastWorkingAt, Date.now(), { force: true });
  }

  /* ------------------------------------------------------------- render */

  // Draw one frame. Returns when the next one is due, or null when the
  // snapshot failed — a failed fetch is not an empty session, and acting on
  // it as one would clear every token and delete every activity stamp.
  async render(now) {
    const entries = await state.snapshot(now);
    if (entries === null) return null;
    // Labels are always needed: the workspace list drives the Spaces marks.
    const { tabs, workspaces, parents, worktrees, info } = await state.labels(now);
    // Deadlines this frame discovers; the scheduler sleeps to the earliest.
    const deadlines = [];
    // Every write this frame goes into one parallel batch.
    const jobs = [];

    // The spawner names the TAB `[agent] task`; a pane under such a tab is a
    // child of its workspace's main agent. Which pane is the parent — and how
    // deep the chain runs — comes from session headers: each child session's
    // first line carries `parentSession`, its parent's own path, re-stamped
    // at every level.
    const edges = state.parentEdges(entries);
    for (const entry of entries) {
      const tabLabel = (tabs.get(entry.tab) ?? '').replace(/^\d+:\s*/, '');
      if (!entry.sub && /^\[[^\]\r\n]+\]\s/.test(tabLabel)) entry.sub = true;
      if (!entry.sub && edges.has(entry.pane)) entry.sub = true;
    }
    const keys = this.sortKeys(entries, parents, worktrees, [...workspaces.keys()], edges);
    const viewMode = view.mode();
    // Which order the panel is actually displaying. The plugin's own views
    // outrank the config toggle (Herdr disables it while they are active);
    // with neither, the config's grouped/priority choice decides.
    const grouped = viewMode === 'grouped' || (viewMode === null && herdr.panelGrouped(now));
    const layout = this.subagentLayout(this.displayOrder(entries, viewMode, keys), [...workspaces.keys()], edges);
    const displayEntries = layout.order;
    // The badge counts delegations with no row of their own, so every child
    // that got a row is subtracted. Two sources, because neither sees all of
    // them: the drawn tree catches a child recognised only by its `[name]` tab
    // label or hung off the fallback parent, and the header edges catch one
    // re-homed to another workspace, which the tree draws elsewhere. A pane in
    // both is one row, hence a set per owner rather than two counts.
    const rowsOwned = new Map();
    const own = (owner, child) => {
      if (!rowsOwned.has(owner)) rowsOwned.set(owner, new Set());
      rowsOwned.get(owner).add(child);
    };
    for (const [child, owner] of layout.parent) own(owner, child);
    for (const [child, owner] of state.parentEdges(entries, { sameWorkspace: false })) own(owner, child);
    for (const entry of entries) {
      entry.bg = Math.max(0, (entry.subs ?? 0) - (rowsOwned.get(entry.pane)?.size ?? 0));
    }
    const indices = new Map(displayEntries.map((entry, index) => [entry.pane, index + 1]));
    // The spawner titles panes `[name] task`; those hang off the pane whose
    // session spawned theirs, the way worktree branches hang off their
    // checkout — to true depth, falling back to the workspace's first main
    // when parentage is not on record.
    // Every agent row carries a corner: ├─ for all but the last row of its
    // sibling run, └─ for the last — the tree starts at the index, no pad.
    const rowCorner = new Map(layout.corner);
    // Worktree children with agents that render after this workspace's agents:
    // the parent's last agent then keeps ├─ and a │ chains down to the branch.
    const chainedWs = new Set(entries.filter((e) => parents.has(e.workspace)).map((e) => parents.get(e.workspace)));
    for (const group of this.byWorkspace(displayEntries)) {
      // Top rows — mains, and orphaned subagent roots in a workspace with no
      // main left — sequence like the mains always did: └─ only for the
      // last, and only when no worktree branch follows it.
      const tops = group.filter((e) => !layout.depth.get(e.pane));
      tops.forEach((m, mi) => rowCorner.set(m.pane, mi === tops.length - 1 && !chainedWs.has(m.workspace) ? '└─ ' : '├─ '));
    }
    // Worktree families: stats go on their own row per member, never tree-wide.
    // Family membership comes from workspace metadata, not from which
    // workspaces happen to host agents right now — a child without an agent
    // still draws its branch in Spaces and keeps the parent on a stats row.
    const familyWs = new Set([...parents.keys(), ...parents.values(), ...keys.orphanRepo.keys()]);
    // Tree guides: children of the same parent draw ├─/└─ corners and their
    // sessions sit under a │ continuation (spaces under the last branch).
    const wsGuide = new Map();
    const spaceCorner = new Map();
    const siblingsByParent = new Map();
    for (const ws of workspaces.keys()) {
      const parent = parents.get(ws);
      if (!parent) continue;
      if (!siblingsByParent.has(parent)) siblingsByParent.set(parent, []);
      siblingsByParent.get(parent).push(ws);
    }
    for (const [, siblings] of siblingsByParent) {
      siblings.forEach((ws, at) => {
        const last = at === siblings.length - 1;
        wsGuide.set(ws, last ? '​   ' : '​  │');
        spaceCorner.set(ws, last ? '└─ ' : '├─ ');
      });
    }
    // Boundaries are needed now — the per-pane loop indents by them — but the
    // group furniture is WRITTEN after that loop, because a header fades with
    // its workspace and whether a workspace is entirely stale is only known
    // once every one of its panes has a display.
    const heads = grouped ? state.groupBoundaries(displayEntries).heads : new Set();

    const live = new Set();
    // workspace -> the display states of its live agents, for the Spaces marks.
    const wsAgents = new Map();
    const spinStep = Math.floor(now / SPIN_MS);

    for (const entry of entries) {
      live.add(entry.pane);
      const display = this.displayFor(entry, now, deadlines);
      if (entry.workspace) {
        if (!wsAgents.has(entry.workspace)) wsAgents.set(entry.workspace, []);
        wsAgents.get(entry.workspace).push({ display, name: entry.name });
      }
      // Herdr indents an entry's continuation rows for us. A head pane's state
      // line is row 2 and arrives indented already; a member's empty header
      // row collapses, so its state line IS row 1 and the indent has to be
      // ours. That asymmetry is why a worktree needs BOTH branches: give its
      // members the deeper indent without also adding one level for its head,
      // and the head sits a level shallower than the sessions it owns. An
      // orphan indents like a real child: its synthesised parent row puts its
      // own rows one level in, same as a child's explicit corner does. With no
      // headers at all (priority order) every line sits at the margin.
      // Depth: a group's first row sits at the margin, everything below it
      // one level in, a worktree's sessions one further. A split does not add
      // a level — its corner is the offset, and a fourth column of indent on
      // rows that are already the deepest in the list buys nothing.
      // Herdr indents a head's session rows by 3 cells (continuation) but a
      // member's by 1; compensate members so every corner shares one base
      // column, then nest subagents under their parent at true depth.
      // Worktree-child agents sit one level under their branch heading.
      const guide = wsGuide.get(entry.workspace);
      // Tree depth alone. The badge is always a continuation row, so it gets
      // Herdr's three cells whether or not its agent heads a group — adding the
      // member compensation on top would push it two columns past the row it
      // belongs to.
      const nesting = (layout.prefix.get(entry.pane) ?? '') + (guide ?? '');
      const indent = (heads.has(entry.pane) ? '' : state.INDENT) + nesting;
      // The other halves of a split screen hang off the pane they were split
      // from, drawn the way a worktree hangs off its checkout.
      const corner = ''; // Split panes are peers; only worktree headers form a tree.
      // The header text this row will sit under, for the prefix trim. Empty
      // in the flat view: nothing is repeated there.
      const header = grouped && config.trimGroupPrefix ? workspaces.get(entry.workspace) ?? '' : '';
      // Herdr adds 3 cells on continuation rows, 1 on first rows. Keep every
      // index at column 3 regardless of worktree depth; tree padding comes later.
      this.paneJobs(entry, display, { tabs, keys, indent, badgeIndent: nesting, corner, spinStep, header, index: indices.get(entry.pane), subCorner: rowCorner.get(entry.pane) ?? '├─ ' }, now, deadlines, jobs);
    }

    this.clearGone(live, now, jobs);
    this.spaceJobs(wsAgents, workspaces, info, familyWs, spaceCorner, now, jobs);
    await this.groupJobs(entries, displayEntries, viewMode, grouped, wsAgents, workspaces, keys, now, deadlines, familyWs);
    await Promise.all(jobs);

    // Sleep to the earliest thing that matters. Failure backoffs are
    // deadlines too — that is what retries them without a busy loop.
    for (const failure of this.failedAt.values()) deadlines.push(failure.until);
    const after = Date.now();
    let sleepUntil = after + CATCH_ALL_MS;
    for (const at of deadlines) {
      if (Number.isFinite(at) && at > after && at < sleepUntil) sleepUntil = at;
    }
    return sleepUntil;
  }

  /* ---------------------------------------------------------- sort keys */

  // Recency keys for the plugin's views, minute-grained. $sort_key ranks a
  // pane, $ws_key ranks its whole workspace (max over members, workspace id
  // as tiebreak so equal minutes never interleave two groups). Published every
  // tick regardless of mode, so flipping views never waits on keys. Stamps
  // written by this very loop land here one tick later — at minute grain that
  // window is invisible.
  // Stable ordinal keys: the expanded workspace order (family-grouped) plus
  // tab/pane position. The agent.view sorts on these ascending, so Herdr's
  // rendered row order matches the indices exactly and never reshuffles on
  // activity — unlike plain recency keys.
  sortKeys(entries, parents, worktrees, wsOrder = [], subEdges = new Map()) {
    const minuteKey = (pane) => {
      // The render hook may move a pane in time as well as in look; the views
      // sort on this, so a redacted sidebar keeps a sensible order.
      const at = hook.apply('activity', this.lastWorkingAt.get(pane), pane);
      return typeof at !== 'number' ? null : String(Math.floor(at / 60000)).padStart(12, '0');
    };
    const ownKeys = new Map();
    for (const entry of entries) {
      if (!entry.workspace) continue;
      const key = minuteKey(entry.pane) ?? NO_STAMP;
      const best = ownKeys.get(entry.workspace);
      if (best === undefined || key > best) ownKeys.set(entry.workspace, key);
    }

    // Git worktrees ride with the checkout they were cut from: a family ranks
    // by its most recent member and stays contiguous, parent first. The cost
    // is deliberate — a busy worktree sinks with a dormant parent — because a
    // tree that a sort can pull apart is not a tree.
    //
    // Only when the parent is on the list too. A branch hanging off empty air
    // is worse than no branch, so an orphaned worktree stays top-level here
    // and in writeGroups, which reads the same map.
    const present = new Set(entries.map((entry) => entry.workspace));
    const parentOf = new Map();
    for (const [child, parent] of parents) {
      if (present.has(child) && present.has(parent)) parentOf.set(child, parent);
    }
    // A worktree can be on the list with its parent nowhere on it — the parent
    // has no agent running, or was never opened as a workspace. Herdr's Spaces
    // panel still nests it (it lists workspaces, not agents), so the Agents
    // panel calling it a plain top-level project is the odd one out. No pane
    // means no header to hang a branch off, so writeGroups puts the repo name
    // inline instead of drawing a corner under nothing.
    const orphanRepo = new Map();
    for (const ws of present) {
      const repo = worktrees.get(ws);
      if (repo && !parentOf.has(ws)) orphanRepo.set(ws, repo);
    }
    // Both shapes of worktree sit one level in: the ones hanging off a real
    // parent group, and the ones hanging off a synthesised parent row.
    const nested = (ws) => parentOf.has(ws) || orphanRepo.has(ws);
    const familyOf = (ws) => parentOf.get(ws) ?? ws;

    const familyKeys = new Map();
    for (const [ws, key] of ownKeys) {
      const family = familyOf(ws);
      const best = familyKeys.get(family);
      if (best === undefined || key > best) familyKeys.set(family, key);
    }
    // Sorted descending, so the depth digit runs parent(1) before child(0).
    // It is compared at the same offset for every member of a family because
    // the family id ahead of it is identical across them; the trailing own
    // key then ranks siblings among themselves.
    const pad = (n) => String(n).padStart(6, '0');
    const wsOrdinal = new Map([...new Set([...wsOrder, ...entries.map((e) => e.workspace).filter(Boolean)])].map((ws, at) => [ws, pad(at)]));
    const wsKeys = new Map(entries.filter((e) => e.workspace).map((e) => [e.workspace, wsOrdinal.get(e.workspace)]));
    // Panes that share a tab share a split screen. They rank as one unit —
    // by their most recent member, like a worktree family — and inside the
    // unit the pane the others were split from comes first, then the rest by
    // their own activity. Without this the panel's own sort walks straight
    // through a split, putting an unrelated project between two halves of one
    // screen.
    const tabPanes = new Map();
    for (const entry of entries) {
      if (!entry.tab) continue;
      if (!tabPanes.has(entry.tab)) tabPanes.set(entry.tab, []);
      tabPanes.get(entry.tab).push(entry.pane);
    }
    const tabBest = new Map();
    for (const entry of entries) {
      if (!entry.tab) continue;
      const key = minuteKey(entry.pane) ?? NO_STAMP;
      const best = tabBest.get(entry.tab);
      if (best === undefined || key > best) tabBest.set(entry.tab, key);
    }
    // Herdr lists panes in layout order, so the first one seen for a tab is
    // the one the others were split off from.
    const tabHead = new Map();
    for (const [tab, panes] of tabPanes) tabHead.set(tab, panes[0]);
    const tabOrdinal = new Map();
    for (const entry of entries) {
      if (!entry.tab || tabOrdinal.has(entry.tab)) continue;
      tabOrdinal.set(entry.tab, pad(tabOrdinal.size));
    }
    const paneOrdinal = new Map();
    for (const entry of entries) {
      if (!entry.tab) continue;
      const k = `${entry.tab}:${entry.pane}`;
      if (!paneOrdinal.has(k)) paneOrdinal.set(k, pad(paneOrdinal.size));
    }
    const tabKeys = new Map();
    for (const entry of entries) {
      if (!entry.tab) continue;
      tabKeys.set(entry.pane, `${tabOrdinal.get(entry.tab)}-${paneOrdinal.get(`${entry.tab}:${entry.pane}`)}`);
    }
    // Only a tab holding more than one pane is a split; a lone pane is just a
    // pane and hangs off nothing.
    const split = (entry) => Boolean(entry.tab) && (tabPanes.get(entry.tab)?.length ?? 0) > 1;
    const splitChild = (entry) => split(entry) && tabHead.get(entry.tab) !== entry.pane;

    // Nested subagents must sort INSIDE their parent's subtree, or the row
    // Herdr renders stops matching the index numbers: a grandchild spawned
    // after its uncle's tab ranks past him on raw tab order alone. A child's
    // key is its anchor's key plus its rank among that anchor's children
    // (raw tab order), so an ascending sort reproduces the forest walk —
    // parent, children, grandchildren — exactly, because '-' sorts below
    // every digit. The anchor is the live session parent, else the
    // workspace's first main. Panes sharing a tab keep their raw key: a
    // split screen is one unit and must not be pulled apart.
    const anchorOf = new Map();
    for (const [, group] of this.byWorkspaceIterable(entries)) {
      const firstMain = group.find((e) => !e.sub);
      for (const entry of group) {
        if (!entry.sub || !entry.tab || split(entry)) continue;
        const up = subEdges.get(entry.pane);
        const anchor = up !== undefined && group.some((e) => e.pane === up) ? up : firstMain?.pane;
        if (anchor !== undefined && anchor !== entry.pane && tabKeys.has(anchor)) anchorOf.set(entry.pane, anchor);
      }
    }
    if (anchorOf.size) {
      const kids = new Map();
      for (const [child, anchor] of anchorOf) {
        if (!kids.has(anchor)) kids.set(anchor, []);
        kids.get(anchor).push(child);
      }
      const rank = new Map();
      for (const list of kids.values()) {
        list.sort((a, b) => ((tabKeys.get(a) ?? '') < (tabKeys.get(b) ?? '') ? -1 : 1));
        list.forEach((pane, at) => rank.set(pane, at));
      }
      const treeKey = (pane, guard = new Set()) => {
        if (guard.has(pane)) return tabKeys.get(pane); // unreachable; belt and braces
        guard.add(pane);
        return anchorOf.has(pane) ? `${treeKey(anchorOf.get(pane), guard)}-${pad(rank.get(pane))}` : tabKeys.get(pane);
      };
      for (const pane of anchorOf.keys()) tabKeys.set(pane, treeKey(pane));
    }

    return { minuteKey, wsKeys, parentOf, orphanRepo, nested, tabKeys, splitChild };
  }

  // The order the panel shows. Group furniture follows the displayed order:
  // for the plugin's grouped view that means predicting the view's sort —
  // same keys, same stable sort, same missing-last rule — and pinning headers
  // to ITS first and last panes, not the agent list's.
  displayOrder(entries, viewMode, { wsKeys, minuteKey, tabKeys }) {
    if (config.stableOrder) {
      // Same ordinal keys as the active agent.view: expanded family order.
      return [...entries].sort((a, b) => {
        const wa = wsKeys.get(a.workspace) ?? '';
        const wb = wsKeys.get(b.workspace) ?? '';
        if (wa !== wb) return wa < wb ? -1 : 1;
        const ta = tabKeys.get(a.pane) ?? '';
        const tb = tabKeys.get(b.pane) ?? '';
        if (ta !== tb) return ta < tb ? -1 : 1;
        return 0;
      });
    }
    if (viewMode !== 'grouped') return entries;
    return [...entries].sort((a, b) => {
      const wa = wsKeys.get(a.workspace) ?? '';
      const wb = wsKeys.get(b.workspace) ?? '';
      if (wa !== wb) return wa > wb ? -1 : 1;
      const ta = tabKeys.get(a.pane) ?? '';
      const tb = tabKeys.get(b.pane) ?? '';
      if (ta !== tb) return ta > tb ? -1 : 1;
      const ka = minuteKey(a.pane);
      const kb = minuteKey(b.pane);
      if (ka === kb) return 0;
      if (ka === null) return 1;
      if (kb === null) return -1;
      return ka > kb ? -1 : 1;
    });
  }

  byWorkspace(entries) {
    const groups = new Map();
    for (const entry of entries) {
      if (!entry.workspace) continue;
      if (!groups.has(entry.workspace)) groups.set(entry.workspace, []);
      groups.get(entry.workspace).push(entry);
    }
    return groups.values();
  }

  // Main agents keep native order; each one's subagents follow it
  // immediately. Without parentage every sub is an orphan, which collapses
  // to the old one-level shape: all subs after the first main, or flat
  // siblings in a workspace with no main.
  subagentOrder(entries, wsOrder = [], edges = new Map()) {
    return this.subagentLayout(entries, wsOrder, edges).order;
  }

  // The subagent forest for one frame: display order plus the drawing facts
  // that follow from it — each nested row's parent, depth, level prefix and
  // corner. Parentage comes from session headers (state.parentEdges). A sub
  // whose parent is not live nests one level under the workspace's first
  // main; with no main left it roots at the top level and keeps its own
  // children. Depth is unlimited.
  subagentLayout(entries, wsOrder = [], edges = new Map()) {
    const groups = this.byWorkspaceIterable(entries);
    const order = [];
    const parent = new Map();
    const childrenOf = new Map();
    for (const ws of new Set([...wsOrder, ...groups.keys()])) {
      const group = groups.get(ws);
      if (!group) continue;
      const native = new Map(group.map((entry, at) => [entry.pane, at]));
      const orphans = [];
      for (const entry of group) {
        if (!entry.sub) continue;
        const up = edges.get(entry.pane);
        if (up !== undefined && native.has(up)) {
          if (!childrenOf.has(up)) childrenOf.set(up, []);
          childrenOf.get(up).push(entry);
        } else {
          orphans.push(entry);
        }
      }
      // Fallback orphans join the first main's own children; merged, both
      // render by spawn order.
      const firstMain = group.find((entry) => !entry.sub);
      if (firstMain && orphans.length) {
        childrenOf.set(firstMain.pane, [...(childrenOf.get(firstMain.pane) ?? []), ...orphans]);
      }
      for (const kids of childrenOf.values()) kids.sort((a, b) => native.get(a.pane) - native.get(b.pane));
      const emit = (entry) => {
        order.push(entry);
        for (const child of childrenOf.get(entry.pane) ?? []) {
          parent.set(child.pane, entry.pane);
          emit(child);
        }
      };
      const tops = firstMain ? group.filter((entry) => !entry.sub) : orphans;
      for (const top of tops) emit(top);
    }
    for (const entry of entries) if (!entry.workspace) order.push(entry);

    const byPane = new Map(order.map((entry) => [entry.pane, entry]));
    const depth = new Map();
    const depthOf = (pane) => {
      if (!depth.has(pane)) {
        depth.set(pane, parent.has(pane) ? 1 + depthOf(parent.get(pane)) : 0);
      }
      return depth.get(pane);
    };
    const lastChild = new Set();
    for (const kids of childrenOf.values()) lastChild.add(kids[kids.length - 1].pane);
    const prefix = new Map();
    const corner = new Map();
    for (const entry of order) {
      const d = depthOf(entry.pane);
      if (!d) {
        prefix.set(entry.pane, '');
        continue;
      }
      // The ancestor chain, outermost first: each level's guide cell sits
      // under that ancestor's corner — │ while it has siblings still to
      // come, spaces once its branch has closed.
      const chain = [];
      for (let at = entry; parent.has(at.pane); at = byPane.get(parent.get(at.pane))) chain.unshift(at);
      let guides = '';
      for (let j = 0; j < chain.length - 1; j += 1) guides += lastChild.has(chain[j].pane) ? '   ' : '│  ';
      prefix.set(entry.pane, SUB_LEVEL + guides);
      corner.set(entry.pane, lastChild.has(entry.pane) ? '└─ ' : '├─ ');
    }
    return { order, parent, depth, prefix, corner };
  }

  byWorkspaceIterable(entries) {
    const groups = new Map();
    for (const entry of entries) {
      if (!entry.workspace) continue;
      if (!groups.has(entry.workspace)) groups.set(entry.workspace, []);
      groups.get(entry.workspace).push(entry);
    }
    return groups;
  }

  /* ------------------------------------------------------- pane display */

  // What one pane shows this frame, given what Herdr reports and what this
  // instance remembers. Pushes the moments at which that answer would change
  // onto `deadlines`.
  displayFor(entry, now, deadlines) {
    const pane = entry.pane;

    if (!this.lastWorkingAt.has(pane) && !this.recovered.has(pane)) {
      this.recovered.add(pane);
      const at = activity.recover(entry.name, entry.session);
      if (at) {
        this.lastWorkingAt.set(pane, at);
        activity.save(this.lastWorkingAt, now);
      }
    }

    if (entry.status === 'working') {
      this.lastWorkingAt.set(pane, now);
      activity.save(this.lastWorkingAt, now);
    }

    // Recently working and now idle/done? Treat it as still working until
    // the grace window has fully elapsed — a genuine turn end survives it, a
    // detection blip does not. `blocked` bypasses it: that state is the agent
    // asking a question and must show immediately.
    const sinceWorking = now - (this.lastWorkingAt.get(pane) ?? -Infinity);
    const inGrace =
      (entry.status === 'idle' || entry.status === 'done') &&
      this.previous.has(pane) &&
      sinceWorking < config.idleGraceMs;
    const status = inGrace ? 'working' : entry.status;

    // working -> idle/done means a turn just finished.
    if (this.previous.get(pane) === 'working' && (status === 'idle' || status === 'done')) {
      this.doneUntil.set(pane, config.doneHoldUntilSeen ? DONE_HOLD_FOREVER : now + config.doneHoldSeconds * 1000);
    }
    this.previous.set(pane, status);

    // A question outlives the recognition that spotted it, and may outlive
    // this process — the published token is the record here just as it is
    // for the done badge. A question that arrives before the agent has ever
    // worked is a startup prompt — the trust dialog on a new directory.
    // Answering one of those drops straight back to idle without a turn, so
    // waiting for `working` would pin the mark until the agent happens to do
    // something else. Questions asked mid-work do reach `working` when
    // answered, and those are the ones worth holding: they are also the ones
    // you glance at and come back to.
    if (config.blockedHoldUntilAnswered) {
      if (status === 'blocked') {
        if (!this.blockedSince.has(pane)) {
          this.blockedSince.set(pane, now);
          this.blockedHeldWork.set(pane, this.lastWorkingAt.has(pane));
        }
      } else if (status === 'working' || this.blockedHeldWork.get(pane) === false) {
        this.blockedSince.delete(pane);
        this.blockedHeldWork.delete(pane);
      } else if (!this.blockedSince.has(pane) && entry.showing === 'blocked') {
        // Outlived the last daemon. Whether it had worked is not knowable from
        // a published token, so assume the holding kind — a mark that lingers
        // beats a reminder that vanished.
        this.blockedSince.set(pane, now);
        this.blockedHeldWork.set(pane, true);
      }
    }

    // Re-adopt a badge this process never set: it outlived the last daemon.
    if (config.doneHoldUntilSeen && !this.doneUntil.has(pane) && entry.showing === 'done' && entry.status !== 'working') {
      this.doneUntil.set(pane, DONE_HOLD_FOREVER);
    }

    // Looking at the pane is the acknowledgement.
    // Looking at a pane clears its held badge AND its freshness tier: a seen
    // agent should not keep advertising "worked recently" in light teal.
    if (entry.focused) {
      this.doneUntil.delete(pane);
      if (this.lastWorkingAt.has(pane)) {
        this.lastWorkingAt.delete(pane);
        activity.save(this.lastWorkingAt, now);
      }
    }

    let display;
    if (status === 'working') {
      this.doneUntil.delete(pane);
      this.blockedSince.delete(pane);
      this.blockedHeldWork.delete(pane);
      display = 'working';
    } else if (this.blockedSince.has(pane)) {
      // Answering is what clears it, and answering makes the agent work.
      this.doneUntil.delete(pane);
      display = 'blocked';
    } else if (now < (this.doneUntil.get(pane) ?? 0)) {
      display = 'done';
    } else {
      this.doneUntil.delete(pane);
      // Split idle by how long ago this pane last worked. Nothing else in the
      // sidebar distinguishes "you stepped away mid-thought" from "abandoned
      // on Tuesday", and with this many sessions that is the distinction that
      // actually matters.
      display = status === 'idle' ? activity.freshness(this.lastWorkingAt.get(pane), config, now) : status;
      // Tier crossings are deadlines: an idle pane turns fresh->idle->stale at
      // exact moments, and a sleeping daemon has to wake for them.
      if (status === 'idle') {
        const at = this.lastWorkingAt.get(pane);
        if (typeof at === 'number') {
          for (const crossing of [at + config.activityFreshMs, at + config.activityStaleMs]) {
            if (crossing > now) deadlines.push(crossing);
          }
        }
      }
    }
    if (!state.STATES.includes(display)) display = 'unknown';
    // Last word to the render hook, after every real computation; without a
    // hook this is the identity.
    const shown = hook.apply('state', display, pane);
    return state.STATES.includes(shown) ? shown : display;
  }

  /* --------------------------------------------------------- pane writes */

  // The three token families a pane carries — vendor logo, state line, sort
  // keys — each written only when it changed since the last successful write.
  paneJobs(entry, display, { tabs, keys, indent, badgeIndent = '', corner = '', spinStep, header = '', index, subCorner = '' }, now, deadlines, jobs) {
    const pane = entry.pane;
    const src = this.src;

    // The vendor logo rides along: this loop already knows the agent.
    const logo = null; // Clear legacy harness decoration; this installation uses only Pi.
    if (this.lastLogo.get(pane) !== logo && this.writable(`logo:${pane}`, now)) {
      jobs.push(
        herdr.reportMetadataAsync(pane, src, { harness_logo: logo }).then((ok) => {
          if (this.settled(`logo:${pane}`, ok)) this.lastLogo.set(pane, logo);
        }),
      );
    }

    const title = state.compactTitle(entry, header);
    const line = state.composeLine(entry, display, config.showTab ? tabs.get(entry.tab) ?? '' : '', indent, spinStep, corner);
    if (line && index) {
      const rest = indent && line.titlePrefix.startsWith(indent) ? line.titlePrefix.slice(indent.length) : line.titlePrefix;
      line.titlePrefix = `${indent}${subCorner}${index}: ${rest}`;
    }
    // A state with no line still has to clear the previous one: merely
    // skipping the write leaves the old token up — or, on a pane that had
    // none, no state row at all, which renders its bare title at the margin
    // looking like a group header.
    // Both placements share one token; only one of them is ever configured, so
    // the other returns ''. Only the own-row placement carries an indent — the
    // agent placement is a cell Herdr positions on the title row.
    const badge =
      state.composeBadge(entry.bg ?? 0, 'agent') || state.composeBadge(entry.bg ?? 0, 'row', badgeIndent);
    const key = line ? `${subCorner}${index}::${display}:${line.mark}:${line.split}:${line.logo}:${line.titlePrefix}:${title}:${badge}` : '';
    if (this.lastLine.get(pane) !== key && this.writable(`line:${pane}`, now)) {
      // Send the difference, not the whole set: see state.stateTokens.
      const tokens = line ? state.stateTokens(display, line, title, badge) : null;
      // The first write to a pane in this daemon's life sends the whole set,
      // nulls included: the pane may still carry names an earlier daemon left
      // on it — a title under a state it is no longer in, say — and a delta
      // against "nothing cached" reads those as already absent and never
      // clears them.
      const delta = tokens
        ? this.lastTokens.has(pane)
          ? state.tokenDelta(tokens, this.lastTokens.get(pane))
          : tokens
        : null;
      const write = tokens
        ? Object.keys(delta).length
          ? state.writeTokens(src, pane, delta)
          : Promise.resolve(true)
        : state.clearState(src, pane);
      jobs.push(
        write.then((ok) => {
          if (ok) {
            if (tokens) this.lastTokens.set(pane, tokens);
            else this.lastTokens.delete(pane);
          }
          if (this.settled(`line:${pane}`, ok)) this.lastLine.set(pane, key);
        }),
      );
    }

    // The views sort on these: last-active, minute-grained so a working pane
    // costs one write a minute, zero-padded so the string sort is the numeric
    // sort. Panes with no stamp publish no $sort_key and sort after every
    // stamped one — Herdr puts missing values last.
    const sortKey = keys.minuteKey(pane);
    const wsKey = entry.workspace ? keys.wsKeys.get(entry.workspace) ?? null : null;
    const tabKey = keys.tabKeys.get(pane) ?? null;
    const sortPair = `${sortKey}|${wsKey}`;
    if (this.lastSort.get(pane) !== sortPair && this.writable(`sort:${pane}`, now)) {
      jobs.push(
        herdr.reportMetadataAsync(pane, src, { sort_key: sortKey, ws_key: wsKey, tab_key: tabKey }).then((ok) => {
          if (this.settled(`sort:${pane}`, ok)) this.lastSort.set(pane, sortPair);
        }),
      );
    }

    if (!line) return;

    // A working spinner has to be repainted at the next step; a timed badge
    // at its expiry. Blocked and until-seen badges are static — an event
    // wakes us to clear or replace those.
    const hold = this.doneUntil.get(pane);
    if (display === 'working') deadlines.push((Math.floor(now / SPIN_MS) + 1) * SPIN_MS);
    else if (hold !== undefined && hold !== DONE_HOLD_FOREVER) deadlines.push(hold);
  }

  // Panes that left the agent list since we last painted them.
  clearGone(live, now, jobs) {
    for (const pane of [...this.lastLine.keys()]) {
      if (live.has(pane)) continue;
      if (!this.writable(`clear:${pane}`, now)) continue;
      jobs.push(
        state.clearState(this.src, pane).then((ok) => {
          if (ok) this.lastTokens.delete(pane);
          if (!this.settled(`clear:${pane}`, ok)) return; // retry after backoff
          this.lastLine.delete(pane);
          this.lastSort.delete(pane);
          this.lastLogo.delete(pane);
          this.previous.delete(pane);
          this.doneUntil.delete(pane);
          this.lastWorkingAt.delete(pane);
          this.blockedSince.delete(pane);
          this.blockedHeldWork.delete(pane);
        }),
      );
    }
  }

  /* -------------------------------------------------------- Spaces marks */

  // One aggregated glyph per workspace, published as a workspace token.
  // Priority is urgency: a question beats activity beats an unseen result
  // beats parked. The per-pane displays already carry the idle grace and the
  // held done badge, so the aggregate inherits both for free.
  spaceJobs(wsAgents, workspaces, info, familyWs, spaceCorner, now, jobs) {
    const src = this.src;
    const wsIds = new Set(workspaces.keys());
    for (const ws of wsAgents.keys()) wsIds.add(ws);
    for (const [offset, ws] of [...wsIds].entries()) {
      const index = offset + 1;
      const agents = wsAgents.get(ws) ?? [];
      let chosen = 'none';
      let vendor = '';
      for (const p of ['blocked', 'working', 'done', 'idle', 'unknown']) {
        const hit = agents.find((a) => a.display === p);
        if (hit) {
          chosen = p;
          vendor = hit.name;
          break;
        }
      }
      const token =
        chosen === 'working'
          ? `space_working_${['claude', 'codex', 'grok'].includes(vendor) ? vendor : 'other'}`
          : `space_${chosen}`;
      const glyph = state.spaceMark(chosen);
      const label = workspaces.get(ws) ?? ws;
      const meta = info?.get(ws);
      // Herdr already draws worktree corners in Spaces; only the index rides along.
      const corner = '';
      const git = meta?.git ?? {};
      const key = `${index}:${corner}:${token}:${glyph}:${label}:${JSON.stringify(git)}:${meta?.linked}`;
      if (this.lastSpace.get(ws) !== key && this.writable(`space:${ws}`, now)) {
        jobs.push(
          state.writeSpaceState(src, ws, token, glyph, label, index, git, meta?.linked).then((ok) => {
            if (this.settled(`space:${ws}`, ok)) this.lastSpace.set(ws, key);
          }),
        );
      }
    }
    for (const ws of [...this.lastSpace.keys()]) {
      if (wsIds.has(ws)) continue;
      if (!this.writable(`space:${ws}`, now)) continue;
      jobs.push(
        state.clearSpaceState(src, ws).then((ok) => {
          if (this.settled(`space:${ws}`, ok)) this.lastSpace.delete(ws);
        }),
      );
    }
  }

  /* ------------------------------------------------------ group furniture */

  // Headers, indents and spacers, rewritten only when the layout changed. A
  // workspace counts as stale when every session in it is — that is what lets
  // a whole dormant project recede, header included, instead of leaving a row
  // of bright names over faded contents.
  async groupJobs(entries, displayEntries, viewMode, grouped, wsAgents, workspaces, keys, now, deadlines, familyWs = new Set()) {
    const staleWorkspaces = new Set();
    for (const [ws, agents] of wsAgents) {
      if (agents.length > 0 && agents.every((a) => a.display === 'idle_stale')) staleWorkspaces.add(ws);
    }
    // Headers move when the panes, their displayed order, the mode, or a
    // workspace's collective staleness changes. Topology too: opening or
    // closing a worktree changes the branches drawn and which group holds
    // back its spacer, with the pane list untouched.
    const fingerprint =
      `${viewMode ?? (grouped ? 'grouped' : 'flat')}:` +
      `${[...staleWorkspaces].sort().join('+')}:` +
      `${[...keys.parentOf].map(([child, parent]) => `${child}<${parent}`).sort().join('+')}:` +
      `${[...keys.orphanRepo].map(([ws, repo]) => `${ws}@${repo}`).sort().join('+')}:` +
      `${[...familyWs].sort().join('+')}:` +
      `${displayEntries.map((e) => workspaces.get(e.workspace) ?? '').join('|')}:` +
      displayEntries.map((e) => `${e.workspace}/${e.pane}:${JSON.stringify(e.git ?? {})}:${e.sub ? 1 : 0}:${e.bg ?? 0}`).join(',');
    if (fingerprint === this.members) return;

    let ok = true;
    if (state.INDENT) {
      const wrote = grouped
        ? await state.writeGroups(this.src, displayEntries, workspaces, staleWorkspaces, {
            parentOf: keys.parentOf,
            orphanRepo: keys.orphanRepo,
            families: familyWs,
            bgByWorkspace: displayEntries.reduce(
              (acc, e) => acc.set(e.workspace, (acc.get(e.workspace) ?? 0) + (e.bg ?? 0)),
              new Map(),
            ),
          })
        : await state.clearGroups(this.src, entries);
      ok = wrote.ok;
    }
    // Membership changing is exactly when a pane may just have dropped out of
    // the agent list with our tokens still on it.
    ok = (await state.sweepOrphans(this.src, new Set(entries.map((e) => e.pane)))) && ok;
    // Remember this layout only if every write landed; a failed one left a
    // header or spacer on the wrong pane, and only a retry fixes that.
    if (ok) this.members = fingerprint;
    else deadlines.push(now + 2000);
  }
}

module.exports = { Frame, SPIN_MS };
