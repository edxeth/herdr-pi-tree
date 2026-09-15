'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {collectGit, gitTokens, WorkspaceGit} = require('../lib/git-summary');
const herdr = require('../lib/herdr');

function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'herdr-pi-tree-git-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',['-c','user.name=Test','-c','user.email=test@example.invalid',...args],{cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git('init','-b','main');return {dir,git};
}
test('tracked additions/deletions and ahead match footer semantics without fetching',async t=>{
  const {dir,git}=fixture(t);
  fs.writeFileSync(path.join(dir,'file'),'old\nkeep\n');git('add','.');git('commit','-m','base');
  git('remote','add','origin',path.join(dir,'unused-remote'));
  git('update-ref','refs/remotes/origin/main','HEAD');git('config','branch.main.remote','origin');git('config','branch.main.merge','refs/heads/main');
  git('commit','--allow-empty','-m','ahead');
  fs.writeFileSync(path.join(dir,'file'),'new\nkeep\n');git('add','file');
  fs.appendFileSync(path.join(dir,'file'),'extra\n');
  fs.writeFileSync(path.join(dir,'untracked'),'not counted\n');
  assert.deepEqual(await collectGit(dir),{branch:'main',added:2,removed:1,ahead:1,behind:0});
  assert.deepEqual(gitTokens(await collectGit(dir)),{git_branch:'main',git_added:'+2',git_removed:'-1',git_ahead:'↑1',git_summary:null,git_counts:null,git_behind:null});
  git('checkout','--detach');
  assert.match((await collectGit(dir)).branch,/^[0-9a-f]{7}$/);
});
test('unborn branch, binary diff, and non-repository fallbacks',async t=>{
  const {dir,git}=fixture(t);
  fs.writeFileSync(path.join(dir,'new'),'one\ntwo\n');git('add','new');
  assert.deepEqual(await collectGit(dir),{branch:'main',added:2,removed:0,ahead:null,behind:null});
  git('commit','-m','initial');fs.writeFileSync(path.join(dir,'binary'),Buffer.from([0,1,2]));git('add','binary');
  assert.equal((await collectGit(dir)).added,0);
  assert.equal(await collectGit('/definitely-missing-herdr-pi-tree-directory'),null);
  assert.deepEqual(gitTokens(null),{git_branch:null,git_added:null,git_removed:null,git_ahead:null,git_summary:null,git_counts:null,git_behind:null});
});
test('workspace refresh deduplicates cwd reads and suppresses unchanged writes',async t=>{
  let reads=0;const patches=[];
  const workspaces=[{workspace_id:'w1',tokens:{}},{workspace_id:'w2',tokens:{}}];
  t.mock.method(herdr,'panesAsync',async()=>[{workspace_id:'w1',cwd:'/repo'},{workspace_id:'w2',cwd:'/repo'}]);
  t.mock.method(herdr,'agentsAsync',async()=>[]);
  t.mock.method(herdr,'workspacesAsync',async()=>workspaces);
  t.mock.method(herdr,'reportWorkspaceMetadataAsync',async(id,src,tokens)=>{patches.push(tokens);Object.assign(workspaces.find(w=>w.workspace_id===id).tokens,tokens);return true;});
  const reader=new WorkspaceGit(async()=>{reads++;return {branch:'main',added:1,removed:0,ahead:0};});
  await reader.refresh('test');assert.equal(reads,1);assert.equal(patches.length,2);
  await reader.refresh('test');assert.equal(patches.length,2);
});

test('agents get their own cwd Git summary while sharing reads with Spaces',async t=>{
  const reads=[],writes=[];
  t.mock.method(herdr,'panesAsync',async()=>[{workspace_id:'w1',cwd:'/main',focused:true}]);
  t.mock.method(herdr,'workspacesAsync',async()=>[{workspace_id:'w1',tokens:{}}]);
  t.mock.method(herdr,'agentsAsync',async()=>[{pane_id:'p1',workspace_id:'w1',cwd:'/main',tokens:{}},{pane_id:'p2',workspace_id:'w1',cwd:'/worktree',tokens:{}}]);
  t.mock.method(herdr,'reportWorkspaceMetadataAsync',async()=>true);
  t.mock.method(herdr,'reportMetadataAsync',async(id,src,tokens)=>{writes.push({id,...tokens});return true;});
  await new WorkspaceGit(async cwd=>{reads.push(cwd);return {branch:cwd.slice(1),added:2,removed:1,ahead:3};}).refresh('test');
  assert.deepEqual(reads.sort(),['/main','/worktree']);
  assert.equal(writes.find(w=>w.id==='p1').git_branch,'main');
  assert.equal(writes.find(w=>w.id==='p2').git_branch,'worktree');
  assert.equal(writes.find(w=>w.id==='p2').git_added,'+2');
});
