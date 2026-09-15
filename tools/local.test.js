'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-test-'));
process.env.HERDR_PLUGIN_CONFIG_DIR = root;
process.env.HERDR_PLUGIN_STATE_DIR = path.join(root, 'state');
process.env.HERDR_CONFIG_PATH = path.join(root, 'herdr.toml');
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
  assert.doesNotMatch(result,/token = "\$logo(?:_working|_stale)?"/);
  assert.match(result,/\[ui.sidebar.spaces\]\s+row_gap = 0/);
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
  native = 'done'; count = 0;
  await frame.render(now + 3000 + config.idleGraceMs + 1);
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
