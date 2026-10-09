'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-test-'));
for (const key of Object.keys(process.env)) {
  if (key.startsWith('HERDR_')) delete process.env[key];
}
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
process.env.XDG_STATE_HOME = path.join(root, 'xdg-state');
process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
process.env.PI_CODING_AGENT_DIR = path.join(root, 'pi');
process.env.HERDR_PLUGIN_CONFIG_DIR = root;
process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, 'state');
process.env.HERDR_CONFIG_PATH = path.join(root, 'herdr.toml');
process.env.HERDR_SOCKET_PATH = path.join(root, 'herdr.sock');
process.env.HERDR_BIN_PATH = path.join(root, 'no-live-herdr');
fs.writeFileSync(path.join(root, 'config.toml'), 'variant = "text"\nfollow_appearance = false\nauto_install_font = false\nstable_order = true\nworktree_mark = ""\n');
after(() => fs.rmSync(root, { recursive: true, force: true }));
const config = require('../lib/config');
const state = require('../lib/state');
const herdr = require('../lib/herdr');
const ipc = require('../lib/ipc');
const view = require('../lib/view');
const { Frame, SPIN_MS } = require('../lib/frame');
const activity = require('../lib/activity');

test('explicit config path and no automatic font changes', () => {
  assert.equal(require('../lib/paths').herdrConfigPath(), process.env.HERDR_CONFIG_PATH);
  assert.equal(config.autoInstallFont, false);
  assert.equal(config.autoInstallPiExtension, true);
  assert.equal(config.followAppearance, false);
});

test('stable view uses native workspace, tab and pane order', async (t) => {
  let request;
  t.mock.method(ipc, 'call', async (...args) => { request = args; return {}; });
  delete require.cache[require.resolve('../lib/view')];
  await require('../lib/view').apply('grouped');
  assert.equal(request[0], 'agent.view.set');
  assert.deepEqual(request[1].sort, [{ field: { token: 'ws_key' }, order: 'asc' }, { field: { token: 'tab_key' }, order: 'asc' }, { field: { token: 'sort_key' }, order: 'asc' }]);
  assert.equal(config.stableOrder, true);
  const frame = new Frame('test');
  const entries = [{ pane: 'w2:p9' }, { pane: 'w2:p1' }, { pane: 'w8:p1' }];
  assert.equal(view.resolve('grouped', { op: 'flip' }), 'grouped');
});

test('first-run setup never installs fonts when disabled', (t) => {
  const font = require('../lib/font');
  const managed = require('../lib/managed-config');
  t.mock.method(managed, 'inspect', () => ({ state: 'installed' }));
  t.mock.method(herdr, 'reloadConfig', () => {});
  t.mock.method(font, 'install', () => assert.fail('font installation is forbidden'));
  t.mock.method(font, 'configureTerminals', () => assert.fail('terminal edits are forbidden'));
  require('../lib/setup').ensure({ force: true });
});

test('a blocked row asks with its own shape, not the working dot', async (t) => {
  const entries = [{ pane: 'w1:p1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Waiting on you', status: 'blocked', seq: 1 }];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map(), parents: new Map(), worktrees: new Map() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  const frame = new Frame('test');
  frame.displayFor = () => 'blocked';
  frame.spaceJobs = () => {};
  frame.groupJobs = async () => {};
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.match(writes.get('w1:p1').title_blocked, /1: \? /);
});

test('a blocked Space asks with its own shape too', () => {
  assert.equal(state.spaceMark('blocked'), '?');
  assert.equal(state.spaceMark('done'), '✓');
  assert.equal(state.spaceMark('working'), '●');
  assert.equal(state.spaceMark('idle'), '○');
  assert.equal(state.spaceMark('none'), '');
});

test('render publishes shortcut indices across groups, renumbers after removal', async (t) => {
  let entries = Array.from({ length: 10 }, (_, i) => ({ pane: `w${i < 5 ? 1 : 2}:p${i + 1}`, workspace: i < 5 ? 'w1' : 'w2', tab: `t${i}`, name: 'pi', title: 'Task', status: 'idle' }));
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map(), parents: new Map(), worktrees: new Map() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  const frame = new Frame('test');
  frame.displayFor = () => 'idle';
  frame.spaceJobs = () => {};
  frame.groupJobs = async () => {};
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.match(writes.get('w1:p1').title_idle, /^├─ 1: ○ /);
  assert.match(writes.get('w2:p9').title_idle, /9: ○ /);
  assert.match(writes.get('w2:p10').title_idle, /10: ○ /);
  assert.equal(writes.get('w1:p2').title_idle, '\u200b  ├─ 2: ○ Untitled');
  assert.equal(writes.get('w1:p1').title_idle, '├─ 1: ○ Untitled');
  assert.equal(writes.get('w1:p2').title_idle, '\u200b  ├─ 2: ○ Untitled');
  entries = entries.slice(1);
  await frame.render(Date.now());
  assert.equal(writes.get('w1:p2').title_idle, '├─ 1: ○ Untitled');
  entries = [];
  await frame.render(Date.now());
});

test('bare tool-call titles fall back to the Pi session name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-'));
  const file = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'Fix signup flow'}) + '\n');
  assert.equal(state.compactTitle({name:'pi', cwd:'/x/tmp', title:'tmp', session:file}), 'Fix signup flow');
  assert.equal(state.compactTitle({name:'pi', title:'subagent', session:file}), 'Fix signup flow');
  const unnamed = path.join(dir, 'nope.jsonl');
  fs.writeFileSync(unnamed, JSON.stringify({type:'session'}) + '\n' + JSON.stringify({type:'message', message:{role:'user', content:'Build a memecoin site' + String.fromCharCode(10) + 'more'}}) + '\n');
  assert.equal(state.compactTitle({name:'pi', title:'subagent', session:unnamed}), 'Build a memecoin site');
  // No session record at all: the pane title is not a name, so Untitled.
  assert.equal(state.compactTitle({name:'pi', title:'subagent'}), 'Untitled');
});

test('workspace headings have no plugin-added left gutter', async (t) => {
  const writes = new Map();
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  await state.writeGroups('test', [{pane:'p1',workspace:'w1',git:{branch:'main',added:'+12',removed:'-3',ahead:'↑2'}},{pane:'p2',workspace:'w1',git:{branch:'other'}}], new Map([['w1','Project']]));
  assert.equal(writes.get('p1').group, 'Project');
  assert.equal(writes.get('p2').group, null);
  assert.equal(writes.get('p1').heading_git_branch,'main');
  assert.equal(writes.get('p1').heading_git_added,'+12');
  assert.equal(writes.get('p1').gitline_branch,null);
  await state.writeGroups('test', [{pane:'parent',workspace:'w1',git:{branch:'main',added:'+1'}},{pane:'child',workspace:'w2',git:{branch:'feat',added:'+2'}}], new Map([['w1','Project'],['w2','feat']]), new Set(), {parentOf:new Map([['w2','w1']]), families:new Set(['w1','w2'])});
  assert.equal(writes.get('parent').heading_git_branch,'main');
  assert.equal(writes.get('parent').heading_git_added,'+1');
  assert.equal(writes.get('parent').gitline_branch,null);
  assert.equal(writes.get('child').heading_git_branch,null);
  assert.equal(writes.get('child').heading_git_added,'+2');
});

test('same-tab agents are siblings, only real worktrees carry branch guides', async (t) => {
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => [1,2].map(n => ({ pane:`p${n}`, workspace:'w1', tab:'t1', name:'pi', title:'Task', status:'idle' })));
  t.mock.method(state, 'labels', async () => ({tabs:new Map(),workspaces:new Map(),parents:new Map(),worktrees:new Map()}));
  t.mock.method(herdr, 'reportMetadataAsync', async (id,src,tokens) => { writes.set(id,{...writes.get(id),...tokens});return true; });
  const frame = new Frame('test');
  frame.displayFor=()=> 'idle';frame.spaceJobs=()=>{};frame.groupJobs=async()=>{};frame.clearGone=()=>{};
  await frame.render(Date.now());
  assert.equal(writes.get('p2').split_mark,null);
  await state.writeGroups('test',[{pane:'parent',workspace:'w1'},{pane:'child',workspace:'w2'}],new Map([['w1','Project'],['w2','feature']]),new Set(),{parentOf:new Map([['w2','w1']])});
  assert.match(writes.get('child').group,/└─ feature/);
  assert.equal(writes.get('child').split_mark,null);
});

test('worktree-child agents follow their parent group and nest under the branch', async (t) => {
  // Child pane created LAST; family order must still place it right after the parent.
  const entries = [
    { pane:'other', workspace:'wX', tab:'tX', name:'pi', title:'Other', status:'idle' },
    { pane:'parentA', workspace:'wParent', tab:'tP', name:'pi', title:'Main', status:'idle' },
    { pane:'childLate', workspace:'wChild', tab:'tC', name:'pi', title:'Fix rewards', status:'idle' },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({tabs:new Map(),workspaces:new Map([['wParent','snake'],['wChild','fix-admin-rewards'],['wX','other']]),parents:new Map([['wChild','wParent']]),worktrees:new Map([['wChild','repo']]),info:new Map(),families:new Set(['wParent','wChild'])}));
  t.mock.method(herdr, 'reportMetadataAsync', async (id,src,tokens) => { writes.set(id,{...writes.get(id),...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.clearGone = () => {};
  await frame.render(Date.now());
  // The visible order is the rendered index: parent 1, child 2, others after.
  const idx = (id) => Number(/(\d+):/.exec(writes.get(id).title_idle)[1]);
  assert.equal(idx('childLate'), idx('parentA') + 1, 'child renders directly under its parent group');
  const title = writes.get('childLate').title_idle;
  assert.ok(title.includes('   └─') || title.includes('  │└─'), 'nested one level under the branch heading');
  assert.match(writes.get('childLate').group, /fix-admin-rewards/);
});

test('rows render the session title or Untitled, never the terminal status line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-title-'));
  const file = path.join(dir, 'abc123.jsonl');
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'Fix signup flow'}) + '\n');
  const entry = (title) => ({name:'pi', cwd:'/work/app', title, session:file});
  // A pane-title extension rewrote the terminal title as a status line: idle
  // ends in the model id (known vendor or not), working carries a spinner
  // frame and the running tool. None of it is a session title.
  assert.equal(state.compactTitle(entry('π · app · Fix signup flow · gpt-6-astra')),'Fix signup flow');
  assert.equal(state.compactTitle(entry('π · app · Fix signup flow · minimax-m2')),'Fix signup flow');
  assert.equal(state.compactTitle(entry('◐ π · app · Fix signup flow · exec')),'Fix signup flow');
  assert.equal(state.compactTitle(entry('π · app · thinking')),'Fix signup flow');
  // pi's native shape and its startup states are equally not a source.
  assert.equal(state.compactTitle(entry('π - Fix signup flow - app')),'Fix signup flow');
  assert.equal(state.compactTitle(entry('fix-admin-rewards')),'Fix signup flow');
  // Without a session record there is no title but Untitled.
  assert.equal(state.compactTitle({name:'pi', title:'π'}),'Untitled');
  assert.equal(state.compactTitle({name:'pi', title:'glm-5.3'}),'Untitled');
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'π · app · thinking'}),'Untitled');
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'◐ π · app · exec'}),'Untitled');
  assert.equal(state.compactTitle({name:'pi', cwd:'/x/fix-admin-rewards', title:'fix-admin-rewards'}),'Untitled');
  // A subagent keeps its handle prefix over the session's own name; a
  // commit-shaped tag is not a handle.
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'π · [designer] Fix signup flow · exec', session:file}),'designer: Fix signup flow');
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'π · [7bc11997] chore: fix · exec', session:file}),'Fix signup flow');
  // A hash that starts with a letter spells a word to the tag shape; the
  // session the user named after a commit keeps its brackets, unhandled.
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'π - [e49336a7] chore: fix - app', session:file}),'Fix signup flow');
  const commitNamed = path.join(dir, 'commit-named.jsonl');
  fs.writeFileSync(commitNamed, JSON.stringify({type:'session_info', name:'[e49336a7] chore: fix login'}) + '\n');
  assert.equal(state.compactTitle({name:'pi', cwd:'/x/app', title:'π - [e49336a7] chore: fix login - app', session:commitNamed}),'[e49336a7] chore: fix login');
  // A handle stands alone until the session names itself; another agent's
  // kind stands in for the record pi will never have.
  assert.equal(state.compactTitle({name:'pi', cwd:'/work/app', title:'◒ π · [designer]'}),'designer');
  assert.equal(state.compactTitle({name:'codex', cwd:'/work/app', title:'codex'}),'codex');
  // The spawner seeds the child's session name with its own [handle] tag;
  // the row says the handle once, whichever side it came from.
  const tagged = path.join(dir, 'tagged.jsonl');
  fs.writeFileSync(tagged, JSON.stringify({type:'session_info', name:'[tree-parent] Nested test'}) + '\n');
  assert.equal(state.compactTitle({name:'pi', cwd:'/x/herdr-pi-tree', title:'π - [tree-parent] Nested test - herdr-pi-tree', session:tagged}),'tree-parent: Nested test');
  assert.equal(state.compactTitle({name:'pi', cwd:'/x/herdr-pi-tree', title:'π - Nested test - herdr-pi-tree', session:tagged}),'tree-parent: Nested test');
  // Long session names still cap at the row width.
  const long = path.join(dir, 'long.jsonl');
  fs.writeFileSync(long, JSON.stringify({type:'session_info', name:'x'.repeat(100)}) + '\n');
  assert.ok([...state.compactTitle({name:'pi', title:'π · app · exec', session:long})].length<=28);
});

test('a session file that lands late still names its row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-late-'));
  const file = path.join(dir, 'late.jsonl');
  assert.equal(state.readSessionName(file, 1000), null);
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'Late name'}) + '\n');
  assert.equal(state.readSessionName(file, 2000), null); // inside the retry window
  assert.equal(state.readSessionName(file, 1000 + 5001), 'Late name');
  assert.equal(state.readSessionName(file, 9999999), 'Late name'); // named results stick
});

test('a recorded session path that is gone never triggers a sessions-root scan', (t) => {
  const readdir = t.mock.method(fs, 'readdirSync');
  state.readSessionName(path.join(os.tmpdir(), 'gone-session-dir', 'x_gone.jsonl'), 1000);
  state.parentEdges([{ pane: 'w1:p1', workspace: 'w1', session: path.join(os.tmpdir(), 'gone-session-dir', 'y_gone.jsonl') }]);
  assert.equal(readdir.mock.callCount(), 0);
});

test('a bare session id is found under the sessions root, and a miss is scanned once per window', (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-root-'));
  const project = path.join(agentDir, 'sessions', '--proj--');
  fs.mkdirSync(project, { recursive: true });
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });
  const id = 'abc123-late-id';
  const readdir = t.mock.method(fs, 'readdirSync');
  assert.equal(state.readSessionName(id, 1000), null);
  const scans = readdir.mock.callCount();
  assert.ok(scans > 0);
  fs.writeFileSync(path.join(project, `2026-01-01_${id}.jsonl`), JSON.stringify({type:'session_info', name:'By id'}) + '\n');
  assert.equal(state.readSessionName(id, 2000), null); // inside the window: no rescan
  assert.equal(readdir.mock.callCount(), scans);
  assert.equal(state.readSessionName(id, 1000 + 5001), 'By id');
});

test('parentEdges, which runs every frame, scans for a missing bare id once per window', (t) => {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-edges-'));
  fs.mkdirSync(path.join(agentDir, 'sessions', '--proj--'), { recursive: true });
  const saved = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => { if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved; });
  const readdir = t.mock.method(fs, 'readdirSync');
  const entries = [{ pane: 'w1:p1', workspace: 'w1', session: 'edges-missing-id' }];
  state.parentEdges(entries);
  const scans = readdir.mock.callCount();
  assert.ok(scans > 0);
  state.parentEdges(entries);
  state.parentEdges(entries, { sameWorkspace: false });
  assert.equal(readdir.mock.callCount(), scans);
});

test('a renamed session updates its row once the retry window passes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-rename-'));
  const file = path.join(dir, 'renamed.jsonl');
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'First name'}) + '\n');
  assert.equal(state.readSessionName(file, 1000), 'First name');
  // A rename lands as a later session_info record, the way pi appends it.
  fs.appendFileSync(file, JSON.stringify({type:'session_info', name:'Renamed mid-chat'}) + '\n');
  assert.equal(state.readSessionName(file, 2000), 'First name'); // window still open
  assert.equal(state.readSessionName(file, 1000 + 5001), 'Renamed mid-chat');
  assert.equal(state.readSessionName(file, 9999999), 'Renamed mid-chat'); // unchanged: stat only
});

test('a rename past the 4 MiB head still reaches the row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-huge-'));
  const file = path.join(dir, 'huge.jsonl');
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, JSON.stringify({type:'session_info', name:'Initial'}) + '\n');
  const filler = '{"filler":"' + 'x'.repeat(512) + '"}\n';
  for (let i = 0; i < 8 * 1024 + 4; i += 1) fs.writeSync(fd, filler); // past 4 MiB
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024);
  assert.equal(state.readSessionName(file, 1000), 'Initial');
  fs.appendFileSync(file, JSON.stringify({type:'session_info', name:'Renamed after cap'}) + '\n');
  assert.equal(state.readSessionName(file, 1000 + 5001), 'Renamed after cap');
});

test('a same-size rewrite is not mistaken for an unchanged file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-samesize-'));
  const file = path.join(dir, 'same.jsonl');
  const record = (name) => JSON.stringify({type:'session_info', name}).padEnd(64, ' ') + '\n';
  fs.writeFileSync(file, record('First name'));
  assert.equal(state.readSessionName(file, 1000), 'First name');
  fs.writeFileSync(file, record('Other name!!'));
  assert.equal(state.readSessionName(file, 1000 + 5001), 'Other name!!');
});

test('a failed read keeps the last name and retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-fail-'));
  const file = path.join(dir, 'fail.jsonl');
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'Before failure'}) + '\n');
  assert.equal(state.readSessionName(file, 1000), 'Before failure');
  fs.unlinkSync(file);
  fs.mkdirSync(file); // stats fine, opening for read throws EISDIR
  assert.equal(state.readSessionName(file, 1000 + 5001), 'Before failure');
  fs.rmdirSync(file);
  fs.writeFileSync(file, JSON.stringify({type:'session_info', name:'Recovered'}) + '\n');
  assert.equal(state.readSessionName(file, 20000), 'Recovered');
});

test('Spaces uses one label cell, no duplicate idle dots or vendor row', async (t) => {
  let tokens;
  t.mock.method(herdr,'reportWorkspaceMetadataAsync',async (id,src,t)=>{tokens={...tokens,...t};return true;});
  await state.writeSpaceState('test','w1','space_idle','·','Project',1,{branch:'main',added:'+2',removed:'-1'},false);
  assert.equal(tokens.space_idle,'1: Project');
  assert.equal(tokens.sgit_branch,'main');
  assert.equal(tokens.sgit_added,'+2');
  assert.equal(tokens.space_label,null);
  await state.writeSpaceState('test','w1','space_none','','Project',1,{branch:'feat',added:'+2'},true);
  assert.equal(tokens.space_none,'1: Project');
  assert.equal(tokens.sgit_branch,null);
  assert.equal(tokens.sgit_added,'+2');
});

test('ordinal order holds regardless of the grouped/priority toggle', t=>{
  // The active agent.view owns the order; the config toggle cannot reshuffle it.
  t.mock.method(herdr,'panelGrouped',()=>false);
  const entries=[{pane:'a',workspace:'w1',tab:'t1',status:'idle',seq:8},{pane:'b',workspace:'w1',tab:'t2',status:'working',seq:3},{pane:'c',workspace:'w2',tab:'t3',status:'blocked',seq:1}];
  const keys=new Frame('test').sortKeys(entries,new Map(),new Map(),['w1','w2']);
  assert.deepEqual(new Frame('test').displayOrder(entries,null,keys).map(e=>e.pane),['a','b','c']);
});

test('all state marks are static', () => {
  const entry={name:'pi'};
  assert.equal(state.composeLine(entry,'working','','',0).titlePrefix,'● ');
  assert.equal(state.composeLine(entry,'working','','',1).titlePrefix,'● ');
  assert.equal(state.composeLine(entry,'done','','',1).titlePrefix,'✓ ');
  for (const status of ['blocked','idle','done','unknown']) {
    assert.equal(state.composeLine(entry,status,'','',0).titlePrefix,state.composeLine(entry,status,'','',1).titlePrefix);
    assert.equal(state.composeLine(entry,status,'','',0).logo,'');
  }
});

test('focusing an agent clears its idle-fresh tier', async (t) => {
  const entries = [{ pane:'f1', workspace:'w1', tab:'t1', name:'pi', title:'T', status:'idle', focused:true }];
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({tabs:new Map(),workspaces:new Map(),parents:new Map(),worktrees:new Map(),info:new Map(),families:new Set()}));
  t.mock.method(herdr, 'reportMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(activity, 'save', () => {});
  const frame = new Frame('test');
  frame.clearGone = () => {};
  frame.lastWorkingAt.set('f1', Date.now() - 1000); // worked a second ago: fresh.
  const display = frame.displayFor(entries[0], Date.now(), []);
  assert.equal(display, 'idle');
  assert.equal(frame.lastWorkingAt.has('f1'), false);
});

test('terminal theme retains theme while choosing legible dark sidebar colors', () => {
  const file = process.env.HERDR_CONFIG_PATH;
  fs.writeFileSync(file, '[ui]\nagent_panel_sort = "spaces"\n[keys]\nprefix = "ctrl+space"\n[theme]\nname = "terminal"\nauto_switch = false\n');
  const managed = require('../lib/managed-config');
  assert.equal(managed.apply().ok, true);
  const result = fs.readFileSync(file, 'utf8');
  assert.match(result, /name = "terminal"/);
  assert.match(result, /\[theme\.custom\]\nselection_bg = "#3b4261"/);
  assert.match(result, /#cdd6f4/);
  assert.match(result,/token = "\$group_parent", fg = "#b4befe", bold = true, dim = false/);
  assert.match(result,/token = "\$group_stale", fg = "#585a64", bold = true, dim = true/);
  assert.doesNotMatch(result,/token = "\$logo(?:_working|_stale)?"/);
  assert.match(result,/\[ui.sidebar.spaces\]\s+(?:#[^\n]*\n)*row_gap = 0/);
  assert.match(result,/\[ui.sidebar.agents\]\s+(?:#[^\n]*\n)*row_gap = 0/);
  // Default layout: both Git summaries share the name's row.
  assert.match(result,/\{ token = "\$group_stale"[^\]]*\}, \{ token = "\$heading_git_branch"/);
  assert.match(result,/\{ token = "\$space_none"[^\n]*\n\s*\{ token = "\$sgit_branch"/);
  assert.match(result,/\{ token = "\$bg_heading", fg = "#f9e2af"/);
  assert.doesNotMatch(result,/token = "\$git_summary"/);
  assert.match(result,/token = "\$heading_git_branch", fg = "#ffffff"/);
  assert.match(result,/token = "\$heading_git_added", fg = "#a6e3a1"/);
  assert.match(result,/token = "\$heading_git_removed", fg = "#f38ba8"/);
  
  assert.match(result,/token = "\$sgit_ahead", fg = "#89b4fa"/);

  assert.doesNotMatch(result,/git_summary/);
});


test('Spaces indices follow expanded native workspace order including worktrees',async t=>{
  const list=[{workspace_id:'a',worktree:{repo_key:'repo',is_linked_worktree:false}},{workspace_id:'b'},{workspace_id:'child',worktree:{repo_key:'repo',is_linked_worktree:true}}];
  assert.deepEqual(state.workspaceOrder(list).map(w=>w.workspace_id),['a','child','b']);
  const writes=[];
  t.mock.method(herdr,'reportWorkspaceMetadataAsync',async(id,src,tokens)=>{writes.push({id,tokens});return true;});
  const jobs=[];
  new Frame('test').spaceJobs(new Map(),new Map([['a','Project'],['child','feature'],['b','Other']]),new Map(),new Set(),new Map(),Date.now(),jobs);
  await Promise.all(jobs);
  assert.equal(writes.find(w=>w.id==='a').tokens.space_none,'1: Project');
  assert.equal(writes.find(w=>w.id==='b').tokens.space_none,'3: Other');
});

test('subagent-titled panes nest under the workspace main agent', async (t) => {
  let entries = [
    { pane:'m1', workspace:'w1', tab:'t1', name:'pi', title:'Main task', status:'idle' },
    { pane:'s1', workspace:'w1', tab:'t2', name:'pi', title:'[debugger] Stalled build', status:'working', sub:true },
    { pane:'m2', workspace:'w1', tab:'t3', name:'pi', title:'Other main', status:'idle' },
  ];
  const frame = new Frame('test');
  assert.deepEqual(frame.subagentOrder(entries).map(e=>e.pane), ['m1','s1','m2']);
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({tabs:new Map(),workspaces:new Map([['w1','Project']]),parents:new Map(),worktrees:new Map(),info:new Map(),families:new Set()}));
  t.mock.method(herdr, 'reportMetadataAsync', async (id,src,tokens) => { writes.set(id,{...writes.get(id),...tokens});return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  frame.displayFor = () => 'working';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.match(writes.get('s1').title_working, /└─ 2: /);
  assert.match(writes.get('m1').title_working, /^├─ 1: /);
  assert.match(writes.get('m2').title_working, /^\u200b {2}└─ 3: /);
});

test('an open corner always has rows below it and closes when they leave', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-corners-'));
  const main = writeSession(path.join(dir, 'main.jsonl'), undefined, 'Main task');
  const kidA = writeSession(path.join(dir, 'kida.jsonl'), main, 'kid a');
  const kidB = writeSession(path.join(dir, 'kidb.jsonl'), main, 'kid b');
  const sub = (pane, tab, session) => ({ pane, workspace: 'w1', tab, name: 'pi', title: 'sub', status: 'idle', sub: true, session });
  let entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task', status: 'idle', session: main },
    sub('a1', 't2', kidA),
    sub('b1', 't3', kidB),
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.displayFor = () => 'idle';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  // A mid-run child keeps the open corner; the sibling run closes on the last.
  assert.match(writes.get('a1').title_idle, /├─ 2: /);
  assert.match(writes.get('b1').title_idle, /└─ 3: /);
  // The run's LAST child departs first: the survivor must close the run.
  entries = entries.filter((e) => e.pane !== 'b1');
  await frame.render(Date.now());
  assert.match(writes.get('a1').title_idle, /└─ 2: /);
  assert.doesNotMatch(writes.get('a1').title_idle, /├─/);
  // The subtree departs: nothing may hang below the main, so its corner ends.
  entries = entries.filter((e) => e.pane === 'm1');
  await frame.render(Date.now());
  assert.match(writes.get('m1').title_idle, /└─ 1: /);
  assert.doesNotMatch(writes.get('m1').title_idle, /├─/);
});

test('all-subagent workspaces render flat siblings, not phantom nesting', async (t) => {
  const entries = [
    { pane:'s1', workspace:'w1', tab:'t1', name:'pi', title:'π · [subagent]', status:'working', sub:true },
    { pane:'s2', workspace:'w1', tab:'t2', name:'pi', title:'π · [designer] Chonk zine', status:'done', sub:true },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({tabs:new Map(),workspaces:new Map([['w1','tmp']]),parents:new Map(),worktrees:new Map(),info:new Map(),families:new Set()}));
  t.mock.method(herdr, 'reportMetadataAsync', async (id,src,tokens) => { writes.set(id,{...writes.get(id),...tokens}); return true; });
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.equal(writes.get('s1').title_working, '├─ 1: ● subagent');
  assert.equal(writes.get('s2').title_done, state.INDENT + '└─ 2: ✓ designer');
});

// Session fixtures with the spawner's real header shape: the first line of a
// child session names its parent's own .jsonl path under "parentSession".
function writeSession(file, parentSession, name) {
  const header = { type: 'session', version: 3, id: path.basename(file, '.jsonl'), cwd: '/tmp/tree-test' };
  if (parentSession) header.parentSession = parentSession;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(header) + '\n' + (name ? JSON.stringify({ type: 'session_info', name }) + '\n' : ''));
  return file;
}

test('session headers build the pane parentage the tree nests on', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-parent-'));
  const main = writeSession(path.join(dir, 'main.jsonl'));
  const kid = writeSession(path.join(dir, 'kid.jsonl'), main);
  const slug = path.join(dir, 'sessions', 'proj');
  const idRef = '11111111-1111-4111-8111-111111111111';
  writeSession(path.join(slug, `20260101T000000_${idRef}.jsonl`), main);
  const other = writeSession(path.join(dir, 'other.jsonl'), main);
  const entries = [
    { pane: 'm1', workspace: 'w1', session: main },
    { pane: 'k1', workspace: 'w1', session: kid },
    { pane: 'i1', workspace: 'w1', session: idRef },
    { pane: 'x1', workspace: 'w2', session: other },
  ];
  const was = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const edges = state.parentEdges(entries);
    assert.equal(edges.get('k1'), 'm1');
    assert.equal(edges.get('i1'), 'm1'); // id-form refs resolve through the sessions tree
    assert.equal(edges.has('x1'), false); // cross-workspace stays a peer
    assert.equal(edges.has('m1'), false); // a parent headerless pane is never a child
  } finally {
    if (was === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = was;
  }
});

test('sub-of-sub nests at true depth with branch guides', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-depth-'));
  const main = writeSession(path.join(dir, 'main.jsonl'), undefined, 'Main task');
  const designer = writeSession(path.join(dir, 'designer.jsonl'), main, 'Chonk zine');
  const reviewer = writeSession(path.join(dir, 'reviewer.jsonl'), designer, 'check copy');
  const builder = writeSession(path.join(dir, 'builder.jsonl'), main, 'ship it');
  const entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task', status: 'working', session: main },
    { pane: 'sD', workspace: 'w1', tab: 't2', name: 'pi', title: 'π · [designer] Chonk zine', status: 'working', sub: true, session: designer },
    { pane: 'sR', workspace: 'w1', tab: 't3', name: 'pi', title: 'π · [reviewer] check copy', status: 'working', sub: true, session: reviewer },
    { pane: 'sB', workspace: 'w1', tab: 't4', name: 'pi', title: 'π · [builder] ship it', status: 'working', sub: true, session: builder },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.displayFor = () => 'working';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  const sub = state.INDENT + '\u200b   ';
  assert.equal(writes.get('m1').title_working, '└─ 1: ● Main task');
  assert.equal(writes.get('sD').title_working, sub + '├─ 2: ● designer: Chonk zine');
  assert.equal(writes.get('sR').title_working, sub + '│  └─ 3: ● reviewer: check copy');
  assert.equal(writes.get('sB').title_working, sub + '└─ 4: ● builder: ship it');
});

test('a sub whose parent pane is gone nests one level under the first main', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-gone-'));
  const main = writeSession(path.join(dir, 'main.jsonl'), undefined, 'Main task');
  const ghost = writeSession(path.join(dir, 'ghost.jsonl'), main); // exists on disk, no live pane
  const worker = writeSession(path.join(dir, 'worker.jsonl'), ghost, 'stuck task');
  const entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task', status: 'working', session: main },
    { pane: 's1', workspace: 'w1', tab: 't2', name: 'pi', title: 'π · [worker] stuck task', status: 'working', sub: true, session: worker },
    { pane: 's2', workspace: 'w1', tab: 't3', name: 'pi', title: 'π · [scout] loose pane', status: 'working', sub: true },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.displayFor = () => 'working';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  const sub = state.INDENT + '\u200b   ';
  assert.equal(writes.get('m1').title_working, '└─ 1: ● Main task');
  assert.equal(writes.get('s1').title_working, sub + '├─ 2: ● worker: stuck task');
  assert.equal(writes.get('s2').title_working, sub + '└─ 3: ● scout');
});

test('a session named after a commit is not a subagent pane', async (t) => {
  t.mock.method(herdr, 'agentsAsync', async () => [
    {pane_id:'commit-pane', agent:'pi', agent_status:'idle', terminal_title_stripped:'π - [e49336a7] feat(subagents): toggle - repo'},
    {pane_id:'worker-pane', agent:'pi', agent_status:'idle', terminal_title_stripped:'π - [worker] ship it - repo'},
  ]);
  const entries = await state.snapshot(Date.now());
  assert.equal(entries.find((e) => e.pane === 'commit-pane').sub, false);
  assert.equal(entries.find((e) => e.pane === 'worker-pane').sub, true);
});

test('a tab named after a commit does not nest its pane as a subagent', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-committab-'));
  const main = writeSession(path.join(dir, 'main.jsonl'), undefined, 'Main task');
  const commit = writeSession(path.join(dir, 'commit.jsonl'), undefined, '[e49336a7] chore: fix');
  const entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task', status: 'working', session: main },
    { pane: 'c1', workspace: 'w1', tab: 't2', name: 'pi', title: 'π - [e49336a7] chore: fix - repo', status: 'working', session: commit },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map([['t2', '[e49336a7] chore: fix']]), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.displayFor = () => 'working';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.equal(writes.get('m1').title_working, '├─ 1: ● Main task');
  assert.equal(writes.get('c1').title_working, '\u200b  └─ 2: ● [e49336a7] chore: fix');
});

test('parentage cycles degrade to fallback nesting instead of hanging', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-cycle-'));
  const main = writeSession(path.join(dir, 'main.jsonl'), undefined, 'Main task');
  const one = writeSession(path.join(dir, 'one.jsonl'), path.join(dir, 'two.jsonl'), 'cyc one');
  const two = writeSession(path.join(dir, 'two.jsonl'), one, 'cyc two');
  const entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task', status: 'working', session: main },
    { pane: 'a1', workspace: 'w1', tab: 't2', name: 'pi', title: 'π · [alpha] cyc one', status: 'working', sub: true, session: one },
    { pane: 'b1', workspace: 'w1', tab: 't3', name: 'pi', title: 'π · [beta] cyc two', status: 'working', sub: true, session: two },
  ];
  assert.equal(state.parentEdges(entries).size, 1); // one direction dropped
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.displayFor = () => 'working';
  frame.clearGone = () => {};
  await frame.render(Date.now());
  const sub = state.INDENT + '\u200b   ';
  assert.equal(writes.get('m1').title_working, '└─ 1: ● Main task');
  assert.equal(writes.get('a1').title_working, sub + '└─ 2: ● alpha: cyc one');
  assert.equal(writes.get('b1').title_working, sub + '   └─ 3: ● beta: cyc two');
});

test('an all-subagent workspace roots orphans at top level, children still nest', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-roots-'));
  const ghost = writeSession(path.join(dir, 'ghost.jsonl'));
  const designer = writeSession(path.join(dir, 'designer.jsonl'), ghost, 'Chonk zine');
  const reviewer = writeSession(path.join(dir, 'reviewer.jsonl'), designer, 'check copy');
  const entries = [
    { pane: 'sD', workspace: 'w1', tab: 't1', name: 'pi', title: 'π · [designer] Chonk zine', status: 'working', sub: true, session: designer },
    { pane: 'sR', workspace: 'w1', tab: 't2', name: 'pi', title: 'π · [reviewer] check copy', status: 'working', sub: true, session: reviewer },
  ];
  const writes = new Map();
  t.mock.method(state, 'snapshot', async () => entries);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map(), workspaces: new Map([['w1', 'tmp']]), parents: new Map(), worktrees: new Map(), info: new Map(), families: new Set() }));
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, { ...writes.get(id), ...tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  t.mock.method(herdr, 'panelGrouped', () => true);
  const frame = new Frame('test');
  frame.clearGone = () => {};
  await frame.render(Date.now());
  assert.equal(writes.get('sD').title_working, '└─ 1: ● designer: Chonk zine');
  assert.equal(writes.get('sR').title_working, state.INDENT + '\u200b   └─ 2: ● reviewer: check copy');
});

test('nested subagent tab keys sort inside their subtree, keeping rows matched to indices', () => {
  const frame = new Frame('test');
  const entries = [
    { pane: 'm1', workspace: 'w1', tab: 't1', name: 'pi', title: 'Main task' },
    { pane: 'm2', workspace: 'w1', tab: 't2', name: 'pi', title: 'Other main' },
    { pane: 's1', workspace: 'w1', tab: 't3', name: 'pi', title: 'π · [worker] late tab', sub: true },
  ];
  const keys = frame.sortKeys(entries, new Map(), new Map(), ['w1']);
  const key = (pane) => keys.tabKeys.get(pane);
  assert.ok(key('m1') < key('s1'));
  assert.ok(key('s1') < key('m2')); // a late-tab sub still renders inside its anchor's subtree
  assert.deepEqual(frame.displayOrder(entries, 'grouped', keys).map((e) => e.pane), ['m1', 's1', 'm2']);
});

// Consumer fixtures use the published protocol, not producer implementation imports.
function workToken(work) {
  if (!work) return undefined;
  const hash = require('node:crypto').createHash('sha256').update(work.session).digest('base64url');
  return `${hash}:${work.count}:${work.expiresAt}`.slice(0, 80);
}

test('fresh delegated work suppresses a recovered completion badge and keeps workspace working', async (t) => {
  const now = Date.now();
  const session = path.join(root, 'delegating-parent.jsonl');
  fs.writeFileSync(session, JSON.stringify({type:'session_info', name:'Delegating parent'}) + '\n');
  let native = 'done';
  let count = 2;
  const writes = new Map();
  const spaces = new Map();
  t.mock.method(herdr, 'agentsAsync', async () => [{
    pane_id:'parent-work', workspace_id:'work-space', tab_id:'work-tab', agent:'pi', agent_status:native,
    agent_session:{agent:'pi', kind:'path', value:session},
    tokens:{state_done:'✓', pi_subagents_work_v1:workToken({session, count, expiresAt:now + 30000})},
  }]);
  t.mock.method(herdr, 'tabsAsync', async () => [{tab_id:'work-tab', workspace_id:'work-space', label:'Parent'}]);
  t.mock.method(herdr, 'workspacesAsync', async () => [{workspace_id:'work-space', label:'Project'}]);
  t.mock.method(herdr, 'panesAsync', async () => [{pane_id:'parent-work', tab_id:'work-tab', workspace_id:'work-space'}]);
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, {...writes.get(id), ...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async (id, src, tokens) => { spaces.set(id, {...spaces.get(id), ...tokens}); return true; });
  const frame = new Frame('test');
  await frame.render(now);
  assert.equal(writes.get('parent-work').state_done, null);
  assert.ok(writes.get('parent-work').state_working);
  assert.equal(writes.get('parent-work').bg_heading, '\u21b32');
  assert.ok(spaces.get('work-space').space_working_other);
  count = 1;
  await frame.render(now + 1000);
  assert.ok(writes.get('parent-work').state_working);
  native = 'blocked';
  await frame.render(now + 2000);
  assert.ok(writes.get('parent-work').state_blocked);
  native = 'working';
  await frame.render(now + 3000);
  assert.ok(writes.get('parent-work').state_working);
  // Child completion clears the badge without waiting for the parent's turn.
  count = 0;
  await frame.render(now + 4000);
  assert.equal(writes.get('parent-work').bg_heading, null);
  assert.ok(writes.get('parent-work').state_working);
  native = 'blocked';
  await frame.render(now + 5000);
  assert.equal(writes.get('parent-work').bg_heading, null);
  assert.ok(writes.get('parent-work').state_blocked);
  native = 'working'; // Answering the question releases the blocked-state hold.
  await frame.render(now + 6000);
  native = 'done';
  await frame.render(now + 6000 + config.idleGraceMs + 1);
  assert.ok(writes.get('parent-work').state_done);
});

test('delegated metadata cannot leak to peers, stale sessions or unknown/native blocked states', async (t) => {
  const now = Date.now();
  const session = path.join(root, 'metadata-parent.jsonl');
  const positive = {session, count:1, expiresAt:now + 30000};
  const cases = [
    ['positive', 'done', positive, 'working'],
    ['idle', 'idle', positive, 'working'],
    ['blocked', 'blocked', positive, 'blocked'],
    ['unknown', 'unknown', positive, 'unknown'],
    ['native-working', 'working', null, 'working'],
    ['zero', 'done', {...positive, count:0}, 'done'],
    ['expired', 'done', {...positive, expiresAt:now}, 'done'],
    ['foreign-session', 'done', {...positive, session:'another.jsonl'}, 'done'],
    ['negative', 'done', {...positive, count:-1}, 'done'],
    ['fraction', 'done', {...positive, count:1.5}, 'done'],
    ['exponent-count', 'done', {...positive, count:'1e0'}, 'done'],
    ['bad-expiry', 'done', {...positive, expiresAt:'later'}, 'done'],
    ['unbounded-expiry', 'done', {...positive, expiresAt:Number.MAX_SAFE_INTEGER}, 'done'],
    ['absent', 'done', undefined, 'done'],
    ['null', 'done', null, 'done'],
  ];
  t.mock.method(herdr, 'agentsAsync', async () => cases.map(([pane, native, work]) => ({
    pane_id:pane, agent:'pi', agent_status:native, cwd:root,
    agent_session:{agent:'pi', kind:'path', value:session},
    tokens:{pi_subagents_work_v1:workToken(work)},
  })).concat([
    {pane_id:'malformed', agent:'pi', agent_status:'done', tokens:{pi_subagents_work_v1:'{'}},
    {pane_id:'peer', agent:'pi', agent_status:'done', cwd:root, agent_session:{agent:'pi', kind:'path', value:'peer.jsonl'}, tokens:{pi_subagents_work_v1:workToken(positive)}},
    {pane_id:'non-pi', agent:'codex', agent_status:'done', agent_session:{agent:'pi',kind:'path',value:session}, tokens:{pi_subagents_work_v1:workToken(positive)}},
  ]));
  const entries = await state.snapshot(now);
  assert.deepEqual(entries.map((e) => e.status), [...cases.map((row) => row[3]), 'done', 'done', 'done']);
});

test('a heartbeat arriving during snapshot collection is not rejected as too far in the future', async (t) => {
  const now = Date.now();
  t.mock.method(herdr, 'agentsAsync', async () => [{
    pane_id:'refreshing', agent:'pi', agent_status:'done', agent_session:{agent:'pi', kind:'path', value:'parent.jsonl'},
    tokens:{pi_subagents_work_v1:workToken({session:'parent.jsonl', count:1, expiresAt:now + 30010})},
  }]);
  assert.equal((await state.snapshot(now))[0].status, 'working');
});

test('the workspace heading counts only background helpers, not children with their own pane', async (t) => {
  const now = Date.now();
  const session = path.join(root, 'badge-parent.jsonl');
  fs.writeFileSync(session, JSON.stringify({type:'session_info', name:'Badge parent'}) + '\n');
  const childSession = path.join(root, 'badge-child.jsonl');
  fs.writeFileSync(childSession, JSON.stringify({type:'session_info', parentSession:session}) + '\n');
  let panedChild = false;
  const writes = new Map();
  t.mock.method(herdr, 'agentsAsync', async () => [
    {
      pane_id:'badge-parent', workspace_id:'badge-space', tab_id:'badge-tab', agent:'pi', agent_status:'working',
      agent_session:{agent:'pi', kind:'path', value:session},
      tokens:{pi_subagents_work_v1:workToken({session, count:3, expiresAt:now + 30000})},
    },
    ...(panedChild ? [{
      pane_id:'badge-child', workspace_id:'badge-space', tab_id:'badge-child-tab', agent:'pi', agent_status:'working',
      agent_session:{agent:'pi', kind:'path', value:childSession}, tokens:{},
    }] : []),
  ]);
  t.mock.method(herdr, 'tabsAsync', async () => [
    {tab_id:'badge-tab', workspace_id:'badge-space', label:'Parent'},
    {tab_id:'badge-child-tab', workspace_id:'badge-space', label:'[worker] child'},
  ]);
  t.mock.method(herdr, 'workspacesAsync', async () => [{workspace_id:'badge-space', label:'Project'}]);
  t.mock.method(herdr, 'panesAsync', async () => [
    {pane_id:'badge-parent', tab_id:'badge-tab', workspace_id:'badge-space'},
    {pane_id:'badge-child', tab_id:'badge-child-tab', workspace_id:'badge-space'},
  ]);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, {...writes.get(id), ...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  const frame = new Frame('test');
  await frame.render(now);
  assert.equal(writes.get('badge-parent').bg_heading, '\u21b33');
  // The badge lives on the heading by default, so the agent line stays clear.
  assert.equal(writes.get('badge-parent').bg_count, null);

  panedChild = true;
  const second = new Frame('test');
  await second.render(now + 1000);
  assert.equal(writes.get('badge-parent').bg_heading, '\u21b32');
});

test('heading_git and space_git move or hide each panel Git summary', (t) => {
  const file = process.env.HERDR_CONFIG_PATH;
  const managed = require('../lib/managed-config');
  const write = () => {
    fs.writeFileSync(file, '[ui]\n[theme]\nname = "terminal"\nauto_switch = false\n');
    assert.equal(managed.apply().ok, true);
    return fs.readFileSync(file, 'utf8');
  };
  t.after(() => { config.headingGit = 'inline'; config.spaceGit = 'inline'; });

  config.headingGit = 'row';
  config.spaceGit = 'off';
  const moved = write();
  assert.match(moved,/\{ token = "\$group_stale"[^\]]*\}\],\s*\[\{ token = "\$heading_git_branch"/);
  assert.doesNotMatch(moved,/\$sgit_/);

  config.headingGit = 'off';
  config.spaceGit = 'row';
  const hidden = write();
  assert.doesNotMatch(hidden,/\$heading_git_/);
  assert.match(hidden,/\{ token = "\$space_none"[^\n]*\n\s*\],\s*\[\s*\{ token = "\$sgit_branch"/);
});

test('a layout setting makes the installed sidebar block read as stale until it is rewritten', (t) => {
  const file = process.env.HERDR_CONFIG_PATH;
  const managed = require('../lib/managed-config');
  t.after(() => { config.bgBadge = 'heading'; config.headingGit = 'inline'; });

  fs.writeFileSync(file, '[ui]\n[theme]\nname = "terminal"\nauto_switch = false\n');
  assert.equal(managed.apply().ok, true);
  const installed = fs.readFileSync(file, 'utf8');
  assert.equal(managed.sidebarStale(installed), false);

  // This is the daemon's staleness check (lib/daemon.js). Before the signature
  // carried the layout keys it compared equal here, so the block was never
  // rewritten and the setting never reached the sidebar.
  config.bgBadge = 'row';
  config.headingGit = 'off';
  assert.equal(managed.sidebarStale(installed), true);
  assert.equal(managed.apply().ok, true);
  const rewritten = fs.readFileSync(file, 'utf8');
  assert.equal(managed.sidebarStale(rewritten), false);
  assert.match(rewritten,/\],\s*\[\{ token = "\$bg_count"/);
  assert.doesNotMatch(rewritten,/\$heading_git_/);
});

test('each bg_badge placement draws the count in exactly one place', async (t) => {
  const now = Date.now();
  const session = path.join(root, 'placement-parent.jsonl');
  fs.writeFileSync(session, JSON.stringify({type:'session_info', name:'Placement'}) + '\n');
  const writes = new Map();
  t.after(() => { config.bgBadge = 'heading'; });
  t.mock.method(herdr, 'agentsAsync', async () => [{
    pane_id:'place', workspace_id:'place-space', tab_id:'place-tab', agent:'pi', agent_status:'working',
    agent_session:{agent:'pi', kind:'path', value:session},
    tokens:{pi_subagents_work_v1:workToken({session, count:2, expiresAt:now + 30000})},
  }]);
  t.mock.method(herdr, 'tabsAsync', async () => [{tab_id:'place-tab', workspace_id:'place-space', label:'P'}]);
  t.mock.method(herdr, 'workspacesAsync', async () => [{workspace_id:'place-space', label:'Project'}]);
  t.mock.method(herdr, 'panesAsync', async () => [{pane_id:'place', tab_id:'place-tab', workspace_id:'place-space'}]);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, {...writes.get(id), ...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);

  const render = async (placement, at) => {
    config.bgBadge = placement;
    writes.clear();
    await new Frame('test').render(at);
    return writes.get('place');
  };
  const mark = config.STATIC_GLYPH.delegated;

  const heading = await render('heading', now);
  assert.equal(heading.bg_heading, `${mark}2`);
  assert.equal(heading.bg_count, null);

  const agent = await render('agent', now + 1000);
  assert.equal(agent.bg_count, `${mark}2`);
  assert.equal(agent.bg_heading, null);

  const row = await render('row', now + 2000);
  assert.equal(row.bg_count, `${mark}2`);

  const off = await render('off', now + 3000);
  assert.equal(off.bg_count, null);
  assert.equal(off.bg_heading, null);
});

test('an absent sidebar block is not stale, and a stray layout comment does not make it stale', (t) => {
  const file = process.env.HERDR_CONFIG_PATH;
  const managed = require('../lib/managed-config');
  t.after(() => { config.bgBadge = 'heading'; });

  fs.writeFileSync(file, '[ui]\n[theme]\nname = "terminal"\nauto_switch = false\n');
  assert.equal(managed.apply().ok, true);
  // The user switches to Herdr's own Agents panel; the block's absence is the
  // only record of that, so a daemon start must leave it absent.
  assert.equal(managed.setSidebarRows(false).ok, true);
  const off = fs.readFileSync(file, 'utf8');
  assert.equal(managed.sidebarStale(off), false);
  config.bgBadge = 'row';
  assert.equal(managed.sidebarStale(off), false);

  // A comment of the user's own that happens to look like the plugin's.
  config.bgBadge = 'heading';
  assert.equal(managed.setSidebarRows(true).ok, true);
  const decoy = `# layout: something of my own\n${fs.readFileSync(file, 'utf8')}`;
  assert.equal(managed.sidebarStale(decoy), false);
});

test('a child that draws a row never counts toward its parent badge, however it is nested', async (t) => {
  // Past the label cache another test warmed, so this one reads its own tabs.
  const now = Date.now() + 600000;
  const session = path.join(root, 'rows-parent.jsonl');
  fs.writeFileSync(session, JSON.stringify({type:'session_info', name:'Rows parent'}) + '\n');
  // No parentSession header: this child is recognised only by its tab label,
  // so the tree nests it by fallback and the header edges never see it.
  const labelled = path.join(root, 'rows-labelled.jsonl');
  fs.writeFileSync(labelled, JSON.stringify({type:'session_info'}) + '\n');
  // A real header edge, but re-homed to another workspace: the tree draws it
  // there, so nesting drops the edge while the row still exists.
  const rehomed = path.join(root, 'rows-rehomed.jsonl');
  fs.writeFileSync(rehomed, JSON.stringify({type:'session_info', parentSession:session}) + '\n');
  const writes = new Map();
  t.mock.method(herdr, 'agentsAsync', async () => [
    {pane_id:'rp', workspace_id:'rw', tab_id:'rt', agent:'pi', agent_status:'working',
     agent_session:{agent:'pi', kind:'path', value:session},
     tokens:{pi_subagents_work_v1:workToken({session, count:3, expiresAt:now + 30000})}},
    {pane_id:'rl', workspace_id:'rw', tab_id:'rlt', agent:'pi', agent_status:'working',
     agent_session:{agent:'pi', kind:'path', value:labelled}, tokens:{}},
    {pane_id:'rr', workspace_id:'other', tab_id:'rrt', agent:'pi', agent_status:'working',
     agent_session:{agent:'pi', kind:'path', value:rehomed}, tokens:{}},
  ]);
  t.mock.method(herdr, 'tabsAsync', async () => [
    {tab_id:'rt', workspace_id:'rw', label:'Parent'},
    {tab_id:'rlt', workspace_id:'rw', label:'[worker] orphan'},
    {tab_id:'rrt', workspace_id:'other', label:'Elsewhere'},
  ]);
  t.mock.method(herdr, 'workspacesAsync', async () => [
    {workspace_id:'rw', label:'Project'}, {workspace_id:'other', label:'Other'},
  ]);
  t.mock.method(herdr, 'panesAsync', async () => [
    {pane_id:'rp', tab_id:'rt', workspace_id:'rw'},
    {pane_id:'rl', tab_id:'rlt', workspace_id:'rw'},
    {pane_id:'rr', tab_id:'rrt', workspace_id:'other'},
  ]);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, {...writes.get(id), ...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  await new Frame('test').render(now);
  // Three delegations, two of them drawing a row: one left unseen.
  assert.equal(writes.get('rp').bg_heading, `${config.STATIC_GLYPH.delegated}1`);
});

test('an own-row badge sits at its agent row column, at every nesting depth', async (t) => {
  const now = Date.now() + 900000;
  const parentSession = path.join(root, 'indent-parent.jsonl');
  fs.writeFileSync(parentSession, JSON.stringify({type:'session_info'}) + '\n');
  const memberSession = path.join(root, 'indent-member.jsonl');
  fs.writeFileSync(memberSession, JSON.stringify({type:'session_info'}) + '\n');
  const writes = new Map();
  t.after(() => { config.bgBadge = 'heading'; });
  config.bgBadge = 'row';
  const work = (session) => workToken({session, count:1, expiresAt:now + 30000});
  t.mock.method(herdr, 'agentsAsync', async () => [
    {pane_id:'ihead', workspace_id:'iw', tab_id:'it1', agent:'pi', agent_status:'working',
     agent_session:{agent:'pi', kind:'path', value:parentSession},
     tokens:{pi_subagents_work_v1:work(parentSession)}},
    {pane_id:'imem', workspace_id:'iw', tab_id:'it2', agent:'pi', agent_status:'working',
     agent_session:{agent:'pi', kind:'path', value:memberSession},
     tokens:{pi_subagents_work_v1:work(memberSession)}},
  ]);
  t.mock.method(herdr, 'tabsAsync', async () => [
    {tab_id:'it1', workspace_id:'iw', label:'One'}, {tab_id:'it2', workspace_id:'iw', label:'Two'},
  ]);
  t.mock.method(herdr, 'workspacesAsync', async () => [{workspace_id:'iw', label:'Project'}]);
  t.mock.method(herdr, 'panesAsync', async () => [
    {pane_id:'ihead', tab_id:'it1', workspace_id:'iw'}, {pane_id:'imem', tab_id:'it2', workspace_id:'iw'},
  ]);
  t.mock.method(herdr, 'panelGrouped', () => true);
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { writes.set(id, {...writes.get(id), ...tokens}); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  await new Frame('test').render(now);
  // The badge is a continuation row, so Herdr indents it the same for both.
  // Carrying the head/member compensation would push the member's two columns
  // past the row it belongs to.
  const badge = `${config.STATIC_GLYPH.delegated}1`;
  assert.equal(writes.get('ihead').bg_count, badge);
  assert.equal(writes.get('imem').bg_count, badge);
});

test('sort keys lost by a server restart are republished despite an unchanged cache', async (t) => {
  const now = Date.now();
  let agentTokens = {};
  t.mock.method(herdr, 'agentsAsync', async () => [{
    pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', agent_status: 'idle', cwd: root,
    agent_session: { agent: 'pi', kind: 'path', value: path.join(root, 'sortkeys.jsonl') }, tokens: agentTokens,
  }]);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map([['w1:t1', 'One']]), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map() }));
  const calls = [];
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { if ('ws_key' in tokens) calls.push({ id, tokens }); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async () => true);
  const frame = new Frame('test');
  await frame.render(now);
  const first = calls.find((c) => c.id === 'w1:p1');
  assert.ok(first, 'the first frame publishes sort keys');
  // The pane's metadata died with a restarted server while the daemon — and
  // its lastSort cache — lived on: the agent list reports no keys, and the
  // panel buries the pane under every keyed one. The next frame must notice
  // and republish, or the indices read 1, 6, 7, 2, …
  calls.length = 0;
  await frame.render(now + 1000);
  assert.ok(calls.some((c) => c.id === 'w1:p1'), 'a pane whose keys vanished server-side is republished');
  // Steady state: the panel holds what the frame computes, so nothing moves.
  calls.length = 0;
  agentTokens = Object.fromEntries(Object.entries(first.tokens).filter(([, value]) => value !== null));
  await frame.render(now + 2000);
  assert.equal(calls.filter((c) => c.id === 'w1:p1').length, 0);
});

test('row and Spaces tokens lost by a server restart are republished despite unchanged caches', async (t) => {
  const now = Date.now();
  // A faithful fake of the server's token store: reports patch it, lists read it.
  let paneStore = {};
  let wsStore = {};
  const patch = (store, tokens) => { for (const [name, value] of Object.entries(tokens)) { if (value === null || value === undefined) delete store[name]; else store[name] = value; } };
  t.mock.method(herdr, 'agentsAsync', async () => [{
    pane_id: 'w1:p1', workspace_id: 'w1', tab_id: 'w1:t1', agent: 'pi', agent_status: 'idle', cwd: root,
    agent_session: { agent: 'pi', kind: 'path', value: path.join(root, 'rowlost.jsonl') }, tokens: { ...paneStore },
  }]);
  t.mock.method(herdr, 'panesAsync', async () => []);
  t.mock.method(state, 'labels', async () => ({ tabs: new Map([['w1:t1', 'One']]), workspaces: new Map([['w1', 'Project']]), parents: new Map(), worktrees: new Map(), wsTokens: new Map([['w1', { ...wsStore }]]) }));
  const paneWrites = [];
  t.mock.method(herdr, 'reportMetadataAsync', async (id, src, tokens) => { paneWrites.push(tokens); if (id === 'w1:p1') patch(paneStore, tokens); return true; });
  t.mock.method(herdr, 'reportWorkspaceMetadataAsync', async (id, src, tokens) => { if (id === 'w1') patch(wsStore, tokens); return true; });
  const rowNames = (store) => Object.keys(store).filter((name) => name.startsWith('title_') || name.startsWith('state_'));
  const hasSpace = () => Object.keys(wsStore).some((name) => name.startsWith('space_'));
  const frame = new Frame('test');
  await frame.render(now);
  assert.ok(rowNames(paneStore).length > 0, 'the first frame publishes the row');
  assert.ok(hasSpace(), 'the first frame publishes the Space');

  // Steady state: nothing was lost, so the next frame writes no row.
  paneWrites.length = 0;
  await frame.render(now + 1000);
  assert.equal(paneWrites.filter((tokens) => rowNames(tokens).some((name) => tokens[name] !== null)).length, 0);

  // The server restarted under the living daemon and its metadata went with
  // the old process; the frame's caches still say everything is on screen.
  paneStore = {};
  wsStore = {};
  await frame.render(now + 2000);
  assert.ok(rowNames(paneStore).length > 0, 'a row the server lost is republished');
  assert.ok(hasSpace(), 'a Space the server lost is republished');
});

test('event subscription names each live agent pane, since 0.9.2 refuses a paneless status kind', { skip: process.platform === 'win32' }, async (t) => {
  const net = require('node:net');
  const subscribe = require('../lib/subscribe');
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sub-sock-')), 'h.sock');
  const saved = process.env.HERDR_SOCKET_PATH;
  process.env.HERDR_SOCKET_PATH = sock;
  const requests = [];
  const streams = [];
  // Mirrors the 0.9.2 server: a status subscription without pane_id is refused.
  const server = net.createServer((stream) => {
    streams.push(stream);
    stream.on('data', (chunk) => {
      const request = JSON.parse(String(chunk));
      requests.push(request.params.subscriptions);
      const bad = request.params.subscriptions.some((s) => s.type === 'pane.agent_status_changed' && !s.pane_id);
      stream.write(`${JSON.stringify(bad ? { id: request.id, error: { code: 'invalid_request' } } : { id: request.id, result: { type: 'subscription_started' } })}\n`);
    });
    stream.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  let wakes = 0;
  const sub = subscribe.start({ onWake: () => { wakes += 1; }, onGone: () => {} });
  t.after(() => {
    sub.stop();
    for (const stream of streams) stream.destroy();
    server.close();
    if (saved === undefined) delete process.env.HERDR_SOCKET_PATH; else process.env.HERDR_SOCKET_PATH = saved;
  });
  const until = async (condition) => { for (let i = 0; i < 200 && !condition(); i += 1) await new Promise((r) => setTimeout(r, 10)); assert.ok(condition()); };

  await until(() => wakes >= 1);
  assert.equal(requests.length, 1);
  assert.ok(!requests[0].some((s) => s.type === 'pane.agent_status_changed'));

  sub.setPanes(['w1:p2', 'w1:p1']);
  await until(() => requests.length === 2);
  assert.deepEqual(requests[1].filter((s) => s.type === 'pane.agent_status_changed').map((s) => s.pane_id), ['w1:p1', 'w1:p2']);
  await until(() => wakes >= 2); // the ack of the new stream resyncs

  sub.setPanes(['w1:p1', 'w1:p2']); // same set, different order: nothing to do
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(requests.length, 2);

  sub.setPanes(['w1:p1']);
  await until(() => requests.length === 3);
  assert.deepEqual(requests[2].filter((s) => s.type === 'pane.agent_status_changed').map((s) => s.pane_id), ['w1:p1']);
});

test('reads inside a session share one snapshot; outside they call the list methods', async (t) => {
  const calls = [];
  const snapshot = { agents: [{ pane_id: 'a' }], workspaces: [{ workspace_id: 'w' }], tabs: [{ tab_id: 't' }], panes: [{ pane_id: 'p' }] };
  t.mock.method(ipc, 'call', async (method) => {
    calls.push(method);
    return method === 'session.snapshot' ? { result: { snapshot } } : { result: { agents: [{ pane_id: 'listed' }] } };
  });
  const [agents, workspaces, tabs, panes] = await herdr.withSession(() =>
    Promise.all([herdr.agentsAsync(), herdr.workspacesAsync(), herdr.tabsAsync(), herdr.panesAsync()]));
  assert.deepEqual([agents, workspaces, tabs, panes], [snapshot.agents, snapshot.workspaces, snapshot.tabs, snapshot.panes]);
  assert.deepEqual(calls, ['session.snapshot']);
  assert.deepEqual(await herdr.agentsAsync(), [{ pane_id: 'listed' }]);
  assert.deepEqual(calls, ['session.snapshot', 'agent.list']);
});

test('a session whose socket stalls is answered by the CLI within milliseconds', { skip: process.platform === 'win32' }, async (t) => {
  const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-')), 'herdr');
  fs.writeFileSync(bin, `#!/bin/sh\n[ "$1 $2" = "api snapshot" ] && echo '{"result":{"snapshot":{"agents":[{"pane_id":"from-cli"}]}}}'\n`, { mode: 0o755 });
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = bin;
  t.after(() => { if (saved === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = saved; });
  // The 0.9.2 stall: the socket reply arrives late (100 ms there, 1 s here).
  t.mock.method(ipc, 'call', () => new Promise((resolve) => setTimeout(() => resolve({ result: { snapshot: { agents: [{ pane_id: 'from-socket' }] } } }), 1000)));
  const started = Date.now();
  const agents = await herdr.withSession(() => herdr.agentsAsync());
  assert.deepEqual(agents, [{ pane_id: 'from-cli' }]);
  assert.ok(Date.now() - started < 500, `took ${Date.now() - started} ms`);
});

test('a session falls back to the plain list read when no snapshot arrives', async (t) => {
  t.mock.method(ipc, 'call', async (method) => (method === 'session.snapshot' ? { error: { code: 'unknown_method' } } : { result: { tabs: [{ tab_id: 'listed' }] } }));
  assert.deepEqual(await herdr.withSession(() => herdr.tabsAsync()), [{ tab_id: 'listed' }]);
});

test('a session opened with fast:false never spawns the CLI', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-herdr-'));
  const marker = path.join(dir, 'spawned');
  fs.writeFileSync(path.join(dir, 'herdr'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const saved = process.env.HERDR_BIN_PATH;
  process.env.HERDR_BIN_PATH = path.join(dir, 'herdr');
  t.after(() => { if (saved === undefined) delete process.env.HERDR_BIN_PATH; else process.env.HERDR_BIN_PATH = saved; });
  t.mock.method(ipc, 'call', () => new Promise((resolve) => setTimeout(() => resolve({ result: { snapshot: { tabs: [{ tab_id: 'slow-socket' }] } } }), 150)));
  assert.deepEqual(await herdr.withSession(() => herdr.tabsAsync(), { fast: false }), [{ tab_id: 'slow-socket' }]);
  assert.equal(fs.existsSync(marker), false);
});

test('labels reports each workspace\'s live tokens even while its label cache is fresh', async (t) => {
  let listed = [{ workspace_id: 'w1', label: 'One', tokens: { space_idle: '1: One' } }];
  t.mock.method(herdr, 'tabsAsync', async () => [{ tab_id: 'w1:t1', label: 'One' }]);
  t.mock.method(herdr, 'workspacesAsync', async () => listed);
  const later = Date.now() + 1e9; // beyond every earlier test's cache
  const first = await state.labels(later);
  assert.deepEqual(first.wsTokens.get('w1'), { space_idle: '1: One' });
  listed = [{ workspace_id: 'w1', label: 'One', tokens: {} }];
  const second = await state.labels(later + 1000); // inside the label TTL
  assert.deepEqual(second.wsTokens.get('w1'), {});
  assert.equal(second.tabs.get('w1:t1'), 'One');
});

test('light sidebar installs, refreshes and appearance changes emit valid colors in both panels', (t) => {
  const managed = require('../lib/managed-config');
  const file = process.env.HERDR_CONFIG_PATH;
  const originalBadge = config.bgBadge;
  t.after(() => { config.bgBadge = originalBadge; });
  for (const placement of ['heading', 'agent', 'row', 'off']) {
    config.bgBadge = placement;
    for (const route of ['rows', 'refresh', 'appearance']) {
      fs.writeFileSync(file, '[ui]\n[theme]\nname = "catppuccin-latte"\n');
      assert.equal(managed.setSidebarRows(true).ok, true);
      if (route === 'refresh') assert.equal(managed.apply().ok, true);
      if (route === 'appearance') {
        assert.equal(managed.applyAppearance('dark').ok, true);
        assert.equal(managed.applyAppearance('light').ok, true);
      }
      const text = fs.readFileSync(file, 'utf8');
      for (const panel of ['agents', 'spaces']) {
        const rows = text.split(`[ui.sidebar.${panel}]`)[1].split('\n[')[0];
        const colors = [...rows.matchAll(/\bfg = "([^"]*)"/g)];
        assert.ok(colors.length > 0, `${route}/${placement}/${panel} has styled cells`);
        for (const [, color] of colors) assert.match(color, /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i);
      }
      assert.match(text, /token = "\$title_working", fg = "#c78a1f"/);
      for (const vendor of ['claude', 'codex', 'grok', 'other']) {
        assert.ok(text.includes(`token = "$space_working_${vendor}", fg = "#c78a1f"`));
      }
      if (placement !== 'off') {
        const token = placement === 'heading' ? '$bg_heading' : '$bg_count';
        assert.ok(text.includes(`token = "${token}", fg = "#c78a1f"`));
      }
    }
  }
});

// Exercise real command entry points with a fake Herdr subprocess. The preload
// also isolates the Windows control pipe identity, without relying on a shell.
function reloadFixture(t, response) {
  const dir = fs.mkdtempSync(path.join(root, 'reload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const preload = path.join(dir, 'preload.cjs');
  const reply = path.join(dir, 'reply.json');
  const calls = path.join(dir, 'calls.txt');
  fs.writeFileSync(reply, JSON.stringify(response));
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    const os = require('node:os');
    const user = os.userInfo();
    // Windows control pipes use the account name, not the state directory.
    os.userInfo = () => ({ ...user, username: ${JSON.stringify(path.basename(root) + '-' + path.basename(dir))} });
    require('node:child_process').spawnSync = (bin, args) => {
      require('node:assert/strict').deepEqual(args, ['server', 'reload-config']);
      fs.appendFileSync(${JSON.stringify(calls)}, 'reload\\n');
      return JSON.parse(fs.readFileSync(${JSON.stringify(reply)}, 'utf8'));
    };
  `);
  fs.writeFileSync(path.join(dir, 'herdr.toml'), '[ui]\n[theme]\nname = "catppuccin-latte"\n');
  fs.writeFileSync(path.join(dir, 'config.toml'), 'follow_appearance = false\nauto_install_font = false\nauto_install_pi_extension = false\nstable_order = false\n');
  const env = { ...process.env, HERDR_CONFIG_PATH: path.join(dir, 'herdr.toml'),
    HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: path.join(dir, 'state') };
  return {
    dir, reply, calls,
    run: (...args) => require('node:child_process').spawnSync(process.execPath, ['--require', preload, ...args], {
      cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', timeout: 5000,
    }),
  };
}

const partialReload = { status: 0, stdout: JSON.stringify({ result: {
  type: 'config_reload', status: 'partial', diagnostics: ['invalid sidebar.agents.rows; keeping current ui settings'],
} }) };
const appliedReload = { status: 0, stdout: JSON.stringify({ result: {
  type: 'config_reload', status: 'applied', diagnostics: [],
} }) };

test('reload fixtures isolate the Windows control pipe and share it with their clients', (t) => {
  // Evaluate the actual Windows endpoint branch without opening a pipe, even
  // on Unix. HOME and USERPROFILE alone do not change os.userInfo().username.
  const code = `
    const filename = ${JSON.stringify(path.resolve(__dirname, '../lib/control.js'))};
    const module = { exports: {} };
    require('node:vm').runInNewContext(require('node:fs').readFileSync(filename, 'utf8'), {
      module, process: { platform: 'win32' }, require: require('node:module').createRequire(filename),
    });
    console.log(module.exports.endpoint());
  `;
  const live = require('node:child_process').spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', timeout: 5000 });
  assert.equal(live.status, 0, live.stderr);
  const fixture = reloadFixture(t, appliedReload);
  const daemon = fixture.run('-e', code);
  const client = fixture.run('-e', code);
  const other = reloadFixture(t, appliedReload).run('-e', code);
  for (const result of [daemon, client, other]) assert.equal(result.status, 0, result.stderr);
  assert.notEqual(daemon.stdout, live.stdout, 'the fixture must not address the live daemon');
  assert.equal(client.stdout, daemon.stdout, 'daemon and client must share the fixture pipe');
  assert.notEqual(other.stdout, daemon.stdout, 'separate fixtures must not compete for a pipe');
});

test('reload rejects partial, failed and invalid replies instead of reporting success', (t) => {
  const cases = [
    [partialReload, /invalid sidebar\.agents\.rows; keeping current ui settings/],
    [{ status: 1, stderr: 'server unavailable' }, /server unavailable/],
    [{ status: null, error: { message: 'spawn herdr ENOENT' } }, /ENOENT/],
    [{ status: null, error: { message: 'spawn herdr ETIMEDOUT' } }, /ETIMEDOUT/],
    [{ status: 2, stderr: '' }, /exit 2/],
    [{ status: 0, stdout: 'not json' }, /invalid response/],
    [{ status: 0, stdout: '{}' }, /missing status/],
  ];
  for (const [response, expected] of cases) {
    const fixture = reloadFixture(t, response);
    const result = fixture.run('-e', "require('./lib/herdr').reloadConfig()");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /config reload failed/);
    assert.match(result.stderr, expected);
  }
});

test('configure reports partial reload failure and succeeds only after an applied reply', (t) => {
  const fixture = reloadFixture(t, partialReload);
  const failed = fixture.run('bin/configure.js', '--apply', '--reload');
  assert.equal(failed.status, 1, failed.stderr);
  assert.match(failed.stderr, /config reload failed.*invalid sidebar\.agents\.rows/);
  assert.doesNotMatch(failed.stdout, /config reloaded/);
  fs.writeFileSync(fixture.reply, JSON.stringify(appliedReload));
  const applied = fixture.run('bin/configure.js', '--apply', '--reload');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /config reloaded/);
  assert.equal(applied.stderr, '');
});

test('setup does not stamp or announce a rejected reload as successful', (t) => {
  const fixture = reloadFixture(t, partialReload);
  const command = "console.log(require('./lib/setup').ensure().join('\\n'))";
  const result = fixture.run('-e', command);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /config reload failed/);
  assert.doesNotMatch(result.stdout, /config reloaded/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'state', 'setup.done')), false);
  assert.equal(fixture.run('-e', command).status, 1, 'an unstamped setup must retry the reload');
  fs.writeFileSync(fixture.reply, JSON.stringify(appliedReload));
  const recovered = fixture.run('-e', command);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /config reloaded/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'state', 'setup.done')), true);
});

test('sidebar reload retries after a failed attempt even when the file is already written', (t) => {
  const fixture = reloadFixture(t, partialReload);
  const command = "require('./lib/view').setRows(true)";
  assert.equal(fixture.run('-e', command).status, 1);
  assert.equal(fixture.run('-e', command).status, 1);
  fs.writeFileSync(fixture.reply, JSON.stringify(appliedReload));
  const recovered = fixture.run('-e', command);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(fs.readFileSync(fixture.calls, 'utf8'), 'reload\nreload\nreload\n');
});

test('native view command reports a rejected reload without changing the persisted mode', (t) => {
  const fixture = reloadFixture(t, partialReload);
  const result = fixture.run('bin/agent-view.js', '--native');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /config reload failed/);
  assert.doesNotMatch(result.stdout, /agent view: back to panel order/);
  assert.equal(fs.existsSync(path.join(fixture.dir, 'state', 'agent-view.on')), false);
});

test('daemon logs reload failures, reports them to the view client, and stays alive for recovery', (t) => {
  const fixture = reloadFixture(t, partialReload);
  const result = fixture.run('-e', `
    const fs = require('node:fs');
    const assert = require('node:assert/strict');
    const snapshot = { agents: [], panes: [], workspaces: [], tabs: [] };
    require('./lib/ipc').call = async () => ({ result: { ...snapshot, snapshot } });
    require('./lib/subscribe').start = () => ({ stop() {}, setPanes() {} });
    const managed = require('./lib/managed-config');
    managed.apply();
    const file = process.env.HERDR_CONFIG_PATH;
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('#c78a1f', 'undefined'));
    const daemon = require('./lib/daemon');
    const control = require('./lib/control');
    (async () => {
      await daemon.start();
      assert.match(fs.readFileSync(daemon.ERR_FILE(), 'utf8'), /config reload failed/);
      const failed = await control.request({ cmd: 'view', op: 'native' });
      assert.equal(failed.applied, false);
      assert.match(failed.error, /invalid sidebar.agents.rows/);
      assert.equal(require('./lib/view').mode(), 'grouped');
      const cli = await new Promise(resolve => {
        require('node:child_process').execFile(process.execPath,
          ['--require', ${JSON.stringify(path.join(fixture.dir, 'preload.cjs'))}, 'bin/agent-view.js', '--native'],
          (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr }));
      });
      assert.equal(cli.code, 1);
      assert.match(cli.stderr, /config reload failed/);
      assert.equal(cli.stdout, '');
      assert.equal(fs.readFileSync(${JSON.stringify(fixture.calls)}, 'utf8'), 'reload\\nreload\\nreload\\n');
      assert.equal((await control.request({ cmd: 'ping' })).pid, process.pid);
      fs.writeFileSync(${JSON.stringify(fixture.reply)}, ${JSON.stringify(JSON.stringify(appliedReload))});
      assert.equal((await control.request({ cmd: 'view', op: 'native' })).applied, true);
      assert.equal(require('./lib/view').mode(), null);
      await control.request({ cmd: 'stop' });
      console.log('daemon recovered');
    })().catch(error => { console.error(error); process.exit(1); });
  `);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /daemon recovered/);
});
