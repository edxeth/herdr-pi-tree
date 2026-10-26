// Optional Pi companion for Herdr Pi Tree. Herdr's own managed Pi integration
// consumes herdr:blocked; no other extension needs to depend on this plugin.
//
// Supported question publishers provide version-1 lifecycle events. Only agent
// questions and recovered unanswered questions count; commands and replay
// screens do not. Tool completion also releases a question if its UI failed
// without publishing a completion event.
//
// Pi coalesces ui_prompt_start/end and supplies no caller identity. Neither
// a title nor an in-flight tool proves that a particular menu blocks the
// agent, so those generic events are deliberately not used as wait signals.
//
// The supported refusal handler has no question event. The select wrapper
// recognizes its existing selector call site in the registered extension's
// source files, then follows that select promise. This is a compatibility
// adapter for that source layout, not general await detection. If the caller
// is renamed, moved or bundled with renamed functions, update this adapter;
// do not replace it with title or timing guesses. Stack traces stay local.
//
// Outside Herdr the factory is inert. Setup installs one marker-owned copy
// under Pi's extensions directory; do not load a second copy. No extra toast:
// Herdr already notifies on the blocked transition.
//
// Keep the body plain CommonJS JavaScript: the tests load a .cjs copy without
// a transpiler, and the installer copies this single file.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const util = require('node:util');

const FALLBACK_LABEL = 'waiting for input';
const LABEL_MAX = 120;
const CALLER_FRAMES = 20;

function labelFor(event) {
  const title = event && typeof event.title === 'string' ? event.title.trim() : '';
  if (!title) return FALLBACK_LABEL;
  return title.length <= LABEL_MAX ? title : title.slice(0, LABEL_MAX - 1) + '…';
}

function refusalFiles(pi, ctx) {
  const files = new Set();
  for (const command of pi.getCommands()) {
    if (command.source !== 'extension' || !/^claude-refusal-rewind(?::\d+)?$/.test(command.name)) continue;
    const source = command.sourceInfo?.path;
    if (typeof source !== 'string' || source.startsWith('<') || source.startsWith('builtin:')) continue;
    const baseDir = command.sourceInfo.baseDir;
    const entry = !path.isAbsolute(source) && typeof baseDir === 'string'
      ? path.resolve(baseDir, path.basename(source))
      : path.resolve(ctx.cwd, source);
    const entries = new Set([entry]);
    try {
      entries.add(fs.realpathSync(entry));
    } catch (error) {
      // A loaded extension can outlive its file (for example during an update).
      // Its original filename remains a usable call-site identity.
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    for (const file of entries) {
      const helper = path.join(path.dirname(file), 'retry-refusal' + path.extname(file));
      for (const candidate of [file, helper]) {
        files.add(candidate);
        files.add(pathToFileURL(candidate).href);
      }
    }
  }
  return files;
}

function fromRefusalCaller(files, select) {
  if (typeof util.getCallSites === 'function') {
    return util.getCallSites(CALLER_FRAMES).some((site) =>
      site.functionName === 'chooseRefusalAction' && files.has(site.scriptName));
  }
  // Node 18 compatibility. A custom formatter is not a caller-information API;
  // leave that unsupported case alone rather than invoking application code.
  if (Error.prepareStackTrace !== undefined) return false;
  const trace = {};
  Error.captureStackTrace(trace, select);
  if (typeof trace.stack !== 'string') return false;
  return trace.stack.split('\n').some((line) => {
    const site = /^\s*at (?:async )?chooseRefusalAction \((.+):\d+:\d+\)$/.exec(line);
    return site !== null && files.has(site[1]);
  });
}

module.exports = function herdrPromptState(pi) {
  if (process.env.HERDR_ENV !== '1') return;

  const running = new Set();
  const waits = new Map();
  const wrapped = new WeakSet();
  const restores = [];
  let closed = false;
  let ready = false;
  let published = false;
  let files = new Set();

  // One native notification pair covers all supported questions in this span.
  // String keys are question flow IDs; refusal selections use private Symbols.
  function publishWait() {
    if (closed || !ready || published === (waits.size > 0)) return;
    published = waits.size > 0;
    pi.events.emit('herdr:blocked', published
      ? { active: true, label: waits.values().next().value.label }
      : { active: false });
  }
  function beginWait(key, event) {
    if (closed || waits.has(key)) return;
    waits.set(key, { source: event.source, toolCallId: event.toolCallId, label: labelFor(event) });
    publishWait();
  }
  function endWait(key) {
    if (waits.delete(key)) publishWait();
  }

  pi.on('tool_execution_start', (event) => {
    if (!closed && event && typeof event.toolCallId === 'string') running.add(event.toolCallId);
  });
  pi.on('tool_execution_end', (event) => {
    if (!event || typeof event.toolCallId !== 'string') return;
    running.delete(event.toolCallId);
    for (const [key, wait] of waits) {
      if (wait.source === 'tool' && wait.toolCallId === event.toolCallId) endWait(key);
    }
  });

  const stopStarted = pi.events.on('pi-ask:started', (event) => {
    if (!event || event.version !== 1 || typeof event.flowId !== 'string' || !event.flowId) return;
    if (event.toolCallId !== undefined && typeof event.toolCallId !== 'string') return;
    if (event.source !== 'ask:resume' && (event.source !== 'tool' || !running.has(event.toolCallId))) return;
    beginWait(event.flowId, event);
  });
  const stopCompleted = pi.events.on('pi-ask:completed', (event) => {
    if (!event || event.version !== 1 || typeof event.flowId !== 'string') return;
    const wait = waits.get(event.flowId);
    if (wait && wait.source === event.source && wait.toolCallId === event.toolCallId) endWait(event.flowId);
  });

  function installSelector(_event, ctx) {
    if (closed || ctx.mode !== 'tui' || !ctx.hasUI) return;
    files = refusalFiles(pi, ctx);
    const ui = ctx.ui;
    if (files.size === 0 || wrapped.has(ui.select)) return;
    const original = ui.select;
    function select(...args) {
      if (closed) return original.apply(this, args);
      if (!fromRefusalCaller(files, select)) return original.apply(this, args);
      // A synchronous failure never opened a pending selector.
      const result = original.apply(this, args);
      const key = Symbol('refusal selector');
      beginWait(key, { title: args[0] });
      return Promise.resolve(result).finally(() => endWait(key));
    }
    wrapped.add(select);
    ui.select = select;
    restores.push(() => {
      // Preserve a wrapper another extension installed after ours.
      if (ui.select === select) ui.select = original;
    });
  }

  pi.on('session_start', installSelector);
  // This milestone follows every session_start handler, including Herdr's
  // consumer. A recovered ask can open before that consumer is ready.
  pi.on('resources_discover', (_event, ctx) => {
    if (closed) return;
    ready = ctx.mode === 'tui';
    publishWait();
  });
  // Also covers a run started by an earlier session_start handler.
  pi.on('before_agent_start', installSelector);
  pi.on('session_shutdown', () => {
    closed = true;
    stopStarted();
    stopCompleted();
    running.clear();
    waits.clear();
    if (published) {
      published = false;
      pi.events.emit('herdr:blocked', { active: false });
    }
    for (const restore of restores.reverse()) restore();
    restores.length = 0;
  });
};
