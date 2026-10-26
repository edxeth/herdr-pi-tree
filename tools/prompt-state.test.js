'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// The extension is deliberately plain CommonJS so a renamed copy loads under
// plain node; the tests exploit that instead of pulling in a transpiler.
const src = path.resolve(__dirname, '../extensions/herdr-prompt-state.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-hps-'));
const copy = path.join(root, 'herdr-prompt-state.cjs');
fs.copyFileSync(src, copy);
const factory = require(copy);
const refusalEntry = require.resolve('./fixtures/prompt-state/refusal/index.cjs');
const refusal = require(refusalEntry);
const originalHerdrEnv = process.env.HERDR_ENV;
after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  if (originalHerdrEnv === undefined) delete process.env.HERDR_ENV;
  else process.env.HERDR_ENV = originalHerdrEnv;
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness() {
  const handlers = new Map();
  const emitted = [];
  const bus = new EventEmitter();
  bus.on('herdr:blocked', (event) => emitted.push(['herdr:blocked', event]));
  const pi = {
    on: (kind, fn) => handlers.set(kind, fn),
    getCommands: () => [],
    events: {
      emit: (kind, event) => bus.emit(kind, event),
      on: (kind, fn) => {
        bus.on(kind, fn);
        return () => bus.off(kind, fn);
      },
    },
  };
  const ctx = { cwd: root, mode: 'tui', hasUI: true, ui: { select: async () => undefined } };
  return { pi, ctx, emitted, fire: (kind, event) => handlers.get(kind)?.(event, ctx) };
}

function start(h) {
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' });
  h.fire('resources_discover', { reason: 'startup' });
}

function refusalHarness(select = async () => undefined) {
  const h = harness();
  h.ctx.ui.select = select;
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind', source: 'extension', sourceInfo: { path: refusalEntry },
  }];
  start(h);
  h.fire('session_start', { reason: 'startup' });
  return h;
}

test('registers and emits nothing outside Herdr', () => {
  const prev = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    const h = harness();
    start(h);
    h.fire('tool_execution_start', { toolCallId: 't1' });
    h.fire('ui_prompt_start', { title: 'x' });
    assert.equal(h.emitted.length, 0);
  } finally {
    if (prev !== undefined) process.env.HERDR_ENV = prev;
  }
});

test('overlapping agent questions produce one balanced blocked span', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  const first = { version: 1, source: 'tool', toolCallId: 't1', flowId: 'first', title: 'Approve deploy' };
  const second = { ...first, flowId: 'second', title: 'Nested question' };
  h.pi.events.emit('pi-ask:started', first);
  h.pi.events.emit('pi-ask:started', first);
  h.pi.events.emit('pi-ask:started', second);
  assert.deepEqual(h.emitted, [['herdr:blocked', { active: true, label: 'Approve deploy' }]]);
  h.pi.events.emit('pi-ask:completed', first);
  h.pi.events.emit('pi-ask:completed', first);
  assert.equal(h.emitted.length, 1);
  h.pi.events.emit('pi-ask:completed', second);
  assert.deepEqual(h.emitted[1], ['herdr:blocked', { active: false }]);
  h.pi.events.emit('pi-ask:completed', second);
  assert.equal(h.emitted.length, 2);
});

test('unidentified prompts do not block', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('ui_prompt_start', { title: 'Idle widget' });
  h.fire('ui_prompt_end');
  assert.equal(h.emitted.length, 0);
});

test('manual menus stay working while a tool runs', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 't1', toolName: 'bash' });
  h.fire('ui_prompt_start', { kind: 'select', title: 'Choose a setting' });
  for (const source of ['answer', 'answer:again', 'ask:replay']) {
    h.pi.events.emit('pi-ask:started', { version: 1, flowId: source, source, title: 'Manual form' });
    h.pi.events.emit('pi-ask:completed', { version: 1, flowId: source, source });
  }
  assert.deepEqual(h.emitted, []);
  h.fire('ui_prompt_end');
  assert.deepEqual(h.emitted, []);
});

test('a question start from a finished tool is ignored', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('tool_execution_end', { toolCallId: 't1' });
  h.pi.events.emit('pi-ask:started', { version: 1, source: 'tool', toolCallId: 't1', flowId: 'late' });
  assert.equal(h.emitted.length, 0);
});

test('an agent question blocks inside an already open non-blocking popup', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('ui_prompt_start', { kind: 'custom' });
  h.fire('tool_execution_start', { toolCallId: 'ask-1', toolName: 'ask_user' });
  // Documented version-1 events identify the question even when Pi
  // coalesces its UI start into the earlier popup's span.
  h.pi.events.emit('pi-ask:started', {
    version: 1, flowId: 'flow-1', source: 'tool', toolCallId: 'ask-1', title: 'Choose a target',
  });
  assert.deepEqual(h.emitted, [['herdr:blocked', { active: true, label: 'Choose a target' }]]);
  h.pi.events.emit('pi-ask:completed', {
    version: 1, flowId: 'flow-1', source: 'tool', toolCallId: 'ask-1',
  });
  assert.deepEqual(h.emitted[1], ['herdr:blocked', { active: false }]);
});

test('the refusal selector blocks without a tool and releases after its answer', async () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  const answer = deferred();
  h.ctx.ui.select = () => answer.promise;
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind', source: 'extension', sourceInfo: { path: refusalEntry },
  }];
  start(h);
  h.fire('session_start', { reason: 'startup' });
  const pending = refusal(h.ctx, 'Choice from the refusal caller');
  try {
    assert.deepEqual(h.emitted, [['herdr:blocked', { active: true, label: 'Choice from the refusal caller' }]]);
  } finally {
    answer.resolve('Edit');
    await pending;
  }
  assert.equal(await pending, 'Edit');
  assert.deepEqual(h.emitted[1], ['herdr:blocked', { active: false }]);
});

test('caller inspection does not invoke a custom error formatter', async () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  h.ctx.ui.select = async () => 'Continue';
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind', source: 'extension', sourceInfo: { path: refusalEntry },
  }];
  start(h);
  h.fire('session_start', { reason: 'startup' });
  const previous = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const previousFormatter = Error.prepareStackTrace;
  Error.prepareStackTrace = () => { throw new Error('custom formatter must not run'); };
  try {
    assert.equal(await refusal(h.ctx, 'Question'), 'Continue');
  } finally {
    // Bun also caches the formatter internally; restore its value before the
    // descriptor so the next test does not retain this throwing formatter.
    Error.prepareStackTrace = previousFormatter;
    if (previous) Object.defineProperty(Error, 'prepareStackTrace', previous);
    else delete Error.prepareStackTrace;
  }
});

test('startup questions wait for the native Herdr consumer to finish session initialization', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  const resumed = { version: 1, source: 'ask:resume', flowId: 'startup-question' };
  h.pi.events.emit('pi-ask:started', resumed);
  // Native Herdr ignores blocked notifications before its session_start.
  // Pi emits resources_discover only after all session_start handlers finish.
  assert.deepEqual(h.emitted, []);
  h.fire('session_start', { reason: 'startup' });
  assert.deepEqual(h.emitted, []);
  h.fire('resources_discover', { reason: 'startup' });
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true]);
  h.pi.events.emit('pi-ask:completed', resumed);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('shutdown before initialization emits nothing and ignores stale contexts', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  h.pi.events.emit('pi-ask:started', { version: 1, source: 'ask:resume', flowId: 'early' });
  h.fire('session_shutdown', { reason: 'reload' });
  Object.defineProperty(h.ctx, 'mode', { get() { throw new Error('stale context'); } });
  h.fire('resources_discover', { reason: 'startup' });
  h.fire('before_agent_start', {});
  assert.deepEqual(h.emitted, []);
});

test('RPC contexts do not receive Herdr notifications or selector wrappers', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  h.ctx.mode = 'rpc';
  const original = h.ctx.ui.select;
  start(h);
  h.fire('session_start', { reason: 'startup' });
  h.fire('tool_execution_start', { toolCallId: 'rpc-question' });
  const flow = { version: 1, source: 'tool', flowId: 'rpc-flow', toolCallId: 'rpc-question' };
  h.pi.events.emit('pi-ask:started', flow);
  h.pi.events.emit('pi-ask:completed', flow);
  assert.equal(h.ctx.ui.select, original);
  assert.deepEqual(h.emitted, []);
});

test('label falls back when untitled and caps at 120', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  const flow = { version: 1, source: 'tool', toolCallId: 't1', flowId: 'first' };
  h.pi.events.emit('pi-ask:started', flow);
  assert.equal(h.emitted[0][1].label, 'waiting for input');
  h.pi.events.emit('pi-ask:completed', flow);
  h.pi.events.emit('pi-ask:started', { ...flow, flowId: 'second', title: 'x'.repeat(200) });
  const label = h.emitted[2][1].label;
  assert.equal(label.length, 120);
  assert.ok(label.endsWith('…'));
});

test('manual selects preserve their promise, receiver and options while work runs', async () => {
  process.env.HERDR_ENV = '1';
  const answer = deferred();
  let received;
  const h = refusalHarness(function (...args) {
    received = { receiver: this, args };
    return answer.promise;
  });
  h.fire('tool_execution_start', { toolCallId: 'busy' });
  const options = { signal: new AbortController().signal, timeout: 500 };
  const result = h.ctx.ui.select("Claude Opus 5.5's safeguards flagged this response.", ['Continue', 'Edit'], options);
  assert.equal(result, answer.promise);
  assert.equal(received.receiver, h.ctx.ui);
  assert.equal(received.args[2], options);
  assert.deepEqual(h.emitted, []);
  answer.resolve('Continue');
  assert.equal(await result, 'Continue');
});

test('a similarly named caller in another extension is not a refusal wait', async () => {
  process.env.HERDR_ENV = '1';
  const other = path.join(root, 'other-extension');
  fs.mkdirSync(other);
  fs.copyFileSync(path.join(path.dirname(refusalEntry), 'retry-refusal.cjs'), path.join(other, 'retry-refusal.cjs'));
  const otherCaller = require(path.join(other, 'retry-refusal.cjs'));
  const h = refusalHarness();
  await otherCaller(h.ctx, 'A manual question');
  assert.deepEqual(h.emitted, []);
});

test('the selector stays untouched when the refusal extension is absent', async () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  const original = h.ctx.ui.select;
  start(h);
  h.fire('session_start', { reason: 'startup' });
  assert.equal(h.ctx.ui.select, original);
  await refusal(h.ctx, 'Unregistered caller');
  assert.deepEqual(h.emitted, []);
});

test('before_agent_start installs detection for a run launched during startup', async () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  const answer = deferred();
  h.ctx.ui.select = () => answer.promise;
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind', source: 'extension', sourceInfo: { path: refusalEntry },
  }];
  factory(h.pi);
  h.fire('before_agent_start', {});
  const pending = refusal(h.ctx, 'Question');
  assert.deepEqual(h.emitted, []);
  h.fire('resources_discover', { reason: 'startup' });
  try {
    assert.deepEqual(h.emitted.map(([, event]) => event.active), [true]);
  } finally {
    answer.resolve(undefined);
    await pending;
  }
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('repeated binding does not multiply native blocked transitions', async () => {
  process.env.HERDR_ENV = '1';
  let calls = 0;
  const h = refusalHarness(async () => { calls++; return 'Continue'; });
  for (let i = 0; i < 30; i++) h.fire('before_agent_start', {});
  await refusal(h.ctx, 'Question');
  assert.equal(calls, 1);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('selector rejection is preserved and releases the refusal wait', async () => {
  process.env.HERDR_ENV = '1';
  const failure = new Error('Synthetic selector rejection');
  const h = refusalHarness(() => Promise.reject(failure));
  await assert.rejects(refusal(h.ctx, 'Question'), (error) => error === failure);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('a synchronous selector failure never leaves a pending wait', async () => {
  process.env.HERDR_ENV = '1';
  const failure = new Error('Synthetic selector failure');
  const h = refusalHarness(() => { throw failure; });
  await assert.rejects(refusal(h.ctx, 'Question'), (error) => error === failure);
  assert.deepEqual(h.emitted, []);
});

test('cancelling a refusal preserves the cancellation result and releases the wait', async () => {
  process.env.HERDR_ENV = '1';
  const h = refusalHarness();
  assert.equal(await refusal(h.ctx, 'Question'), undefined);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('tool completion releases only its own question after a missing completion event', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 'question' });
  h.fire('tool_execution_start', { toolCallId: 'unrelated' });
  const flow = { version: 1, source: 'tool', flowId: 'question-flow', toolCallId: 'question' };
  h.pi.events.emit('pi-ask:started', flow);
  flow.toolCallId = 'changed-by-another-listener';
  h.fire('tool_execution_end', { toolCallId: 'unrelated' });
  assert.equal(h.emitted.length, 1);
  h.fire('tool_execution_end', { toolCallId: 'question' });
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
  h.pi.events.emit('pi-ask:completed', flow);
  assert.equal(h.emitted.length, 2);
});

test('recovered unanswered questions count but manually reopened forms do not', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  const recovered = { version: 1, source: 'ask:resume', flowId: 'recovered' };
  h.pi.events.emit('pi-ask:started', recovered);
  h.pi.events.emit('pi-ask:started', { ...recovered, source: 'ask:replay', flowId: 'manual' });
  h.pi.events.emit('pi-ask:completed', { ...recovered, source: 'ask:replay', flowId: 'manual' });
  assert.equal(h.emitted.length, 1);
  h.pi.events.emit('pi-ask:completed', recovered);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('invalid or unrelated question events neither start nor release a question', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  start(h);
  h.fire('tool_execution_start', { toolCallId: 'question' });
  const flow = { version: 1, source: 'tool', flowId: 'flow', toolCallId: 'question' };
  for (const event of [null, {}, { ...flow, version: 2 }, { ...flow, flowId: '' },
    { ...flow, source: 'answer' }, { ...flow, toolCallId: 'not-running' },
    { ...flow, source: 'ask:resume', toolCallId: 7 }]) {
    h.pi.events.emit('pi-ask:started', event);
  }
  assert.deepEqual(h.emitted, []);
  h.pi.events.emit('pi-ask:started', flow);
  for (const event of [null, {}, { ...flow, version: 2 }, { ...flow, flowId: 'other' },
    { ...flow, source: 'answer' }, { ...flow, toolCallId: 'other' }]) {
    h.pi.events.emit('pi-ask:completed', event);
  }
  assert.equal(h.emitted.length, 1);
  h.pi.events.emit('pi-ask:completed', flow);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('closing a refusal does not release a still-unanswered agent question', async () => {
  process.env.HERDR_ENV = '1';
  const answer = deferred();
  const h = refusalHarness(() => answer.promise);
  const recovered = { version: 1, source: 'ask:resume', flowId: 'recovered' };
  h.pi.events.emit('pi-ask:started', recovered);
  const pending = refusal(h.ctx, 'Another question');
  answer.resolve(undefined);
  await pending;
  assert.equal(h.emitted.length, 1);
  h.pi.events.emit('pi-ask:completed', recovered);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('shutdown clears the old span and late closure cannot release a replacement session', async () => {
  process.env.HERDR_ENV = '1';
  const answer = deferred();
  const original = () => answer.promise;
  const h = refusalHarness(original);
  const pending = refusal(h.ctx, 'Old question');
  h.fire('session_shutdown', { reason: 'resume' });
  assert.equal(h.ctx.ui.select, original);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
  h.pi.events.emit('pi-ask:started', { version: 1, source: 'ask:resume', flowId: 'stale' });
  assert.equal(h.emitted.length, 2);
  start(h);
  h.fire('session_start', { reason: 'resume' });
  const next = { version: 1, source: 'ask:resume', flowId: 'new' };
  h.pi.events.emit('pi-ask:started', next);
  answer.resolve(undefined);
  await pending;
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false, true]);
  h.pi.events.emit('pi-ask:completed', next);
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false, true, false]);
});

test('shutdown preserves another extension\'s later selector wrapper', async () => {
  process.env.HERDR_ENV = '1';
  const h = refusalHarness(async () => 'Continue');
  const prior = h.ctx.ui.select;
  const foreign = function (...args) { return prior.apply(this, args); };
  h.ctx.ui.select = foreign;
  h.fire('session_shutdown', { reason: 'reload' });
  assert.equal(h.ctx.ui.select, foreign);
  assert.equal(await refusal(h.ctx, 'Question'), 'Continue');
  assert.deepEqual(h.emitted, []);
});

test('source aliases and symlinked extension paths still identify the real caller', async () => {
  process.env.HERDR_ENV = '1';
  const alias = path.join(root, 'linked auth');
  fs.symlinkSync(path.dirname(refusalEntry), alias, 'dir');
  const h = harness();
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind:1', source: 'extension', sourceInfo: { path: path.join(alias, 'index.cjs') },
  }];
  start(h);
  h.fire('session_start', { reason: 'startup' });
  await refusal(h.ctx, 'Question');
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('relative extension identities use the resolved source directory', async () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  // Pi's raw loader keeps a relative extensionPath alongside the resolved
  // file's parent directory in SourceInfo.baseDir.
  h.pi.getCommands = () => [{
    name: 'claude-refusal-rewind', source: 'extension',
    sourceInfo: { path: './index.cjs', baseDir: path.dirname(refusalEntry) },
  }];
  start(h);
  await refusal(h.ctx, 'Question');
  assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
});

test('Node 18 caller fallback works without changing global error formatting', async () => {
  process.env.HERDR_ENV = '1';
  const util = require('node:util');
  const sites = Object.getOwnPropertyDescriptor(util, 'getCallSites');
  const formatter = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
  const previousFormatter = Error.prepareStackTrace;
  delete util.getCallSites;
  delete Error.prepareStackTrace;
  try {
    const h = refusalHarness();
    await refusal(h.ctx, 'Question');
    assert.deepEqual(h.emitted.map(([, event]) => event.active), [true, false]);
    assert.equal(Error.prepareStackTrace, undefined);
  } finally {
    if (sites) Object.defineProperty(util, 'getCallSites', sites);
    Error.prepareStackTrace = previousFormatter;
    if (formatter) Object.defineProperty(Error, 'prepareStackTrace', formatter);
    else delete Error.prepareStackTrace;
  }
});
