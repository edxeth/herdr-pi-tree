'use strict';

// Tracked changes against HEAD, with staged/unstaged fallback for unborn
// branches. Never fetch or run diff helpers.
const {execFile} = require('node:child_process');
const herdr = require('./herdr');

function git(cwd, args) {
  return new Promise(resolve => {
    execFile('git', ['--no-optional-locks','-c','core.fsmonitor=false',...args],
      {cwd,timeout:2000,maxBuffer:1024*1024,encoding:'utf8',windowsHide:true},
      (error,stdout) => resolve(error ? null : stdout));
  });
}

function numstat(text) {
  let added=0,removed=0;
  for (const line of text.split('\n')) {
    const [a,d]=line.split('\t');
    if (/^\d+$/.test(a)) added+=Number(a);
    if (/^\d+$/.test(d)) removed+=Number(d);
  }
  return {added,removed};
}

async function collectGit(cwd) {
  if (!cwd) return null;
  const status=await git(cwd,['status','--porcelain=2','--branch','--untracked-files=no']);
  if (status === null) return null;
  const head=/^# branch.head (.+)$/m.exec(status)?.[1];
  const commit=/^# branch.oid ([a-f0-9]+)$/m.exec(status)?.[1];
  const branch=head === '(detached)' ? commit?.slice(0,7) : head;
  if (!branch) return null;
  const ab=/^# branch.ab \+(\d+) -(\d+)$/m.exec(status);
  const diffArgs=['diff','--no-ext-diff','--no-textconv','--numstat'];
  const headDiff=await git(cwd,[...diffArgs,'HEAD']);
  let stats;
  if (headDiff) stats=numstat(headDiff);
  else {
    const [staged,unstaged]=await Promise.all([git(cwd,[...diffArgs,'--cached']),git(cwd,diffArgs)]);
    if (staged === null || unstaged === null) return null;
    const a=numstat(staged),b=numstat(unstaged);
    stats={added:a.added+b.added,removed:a.removed+b.removed};
  }
  return {branch,...stats,ahead:ab ? Number(ab[1]) : null,behind:ab ? Number(ab[2]) : null};
}

function gitTokens(info) {
  return {
    git_branch:info?.branch ?? null,
    git_added:info?.added ? `+${info.added}` : null,
    git_removed:info?.removed ? `-${info.removed}` : null,
    git_ahead:info?.ahead||info?.behind ? `${info.ahead?`↑${info.ahead}`:''}${info.behind?`↓${info.behind}`:''}` : null,
    git_summary:null,
    git_counts:null,
    git_behind:null,
  };
}

class WorkspaceGit {
  constructor(read=collectGit) { this.read=read; }
  async refresh(source, canPublish=()=>true) {
    const [panes,workspaces,agents]=await Promise.all([herdr.panesAsync(),herdr.workspacesAsync(),herdr.agentsAsync()]);
    const selected=new Map();
    for (const pane of panes) {
      const previous=selected.get(pane.workspace_id);
      if (!previous || (!previous.focused && (pane.focused || (!previous.agent && pane.agent)))) selected.set(pane.workspace_id,pane);
    }
    const reads=new Map();
    const read = cwd => {
      if (!reads.has(cwd)) reads.set(cwd,cwd ? this.read(cwd) : Promise.resolve(null));
      return reads.get(cwd);
    };
    const workspaceJobs=workspaces.map(async workspace => {
      const pane=selected.get(workspace.workspace_id);
      const cwd=pane?.foreground_cwd ?? pane?.cwd;
      const tokens=gitTokens(await read(cwd));
      const delta=Object.fromEntries(Object.entries(tokens).filter(([key,value])=>(workspace.tokens?.[key] ?? null)!==value));
      if (canPublish() && Object.keys(delta).length) await herdr.reportWorkspaceMetadataAsync(workspace.workspace_id,source,delta);
    });
    const agentJobs=(agents ?? []).map(async agent => {
      const tokens=gitTokens(await read(agent.foreground_cwd ?? agent.cwd));
      const delta=Object.fromEntries(Object.entries(tokens).filter(([key,value])=>(agent.tokens?.[key] ?? null)!==value));
      if (canPublish() && Object.keys(delta).length) {
        await herdr.reportMetadataAsync(agent.pane_id,source,delta);
      }
    });
    await Promise.all([...workspaceJobs,...agentJobs]);
  }
}

module.exports={collectGit,gitTokens,WorkspaceGit};
