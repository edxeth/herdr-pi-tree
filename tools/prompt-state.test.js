'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The extension is deliberately plain CommonJS so a renamed copy loads under
// plain node; the tests exploit that instead of pulling in a transpiler.
const src = path.resolve(__dirname, '../extensions/herdr-prompt-state.ts');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-hps-'));
const copy = path.join(root, 'herdr-prompt-state.cjs');
fs.copyFileSync(src, copy);
const factory = require(copy);

function harness() {
  const handlers = new Map();
  const emitted = [];
  const pi = {
    on: (kind, fn) => handlers.set(kind, fn),
    events: { emit: (kind, payload) => emitted.push([kind, payload]) },
  };
  return { pi, emitted, fire: (kind, event) => handlers.get(kind)?.(event) };
}

test('registers and emits nothing outside Herdr', () => {
  const prev = process.env.HERDR_ENV;
  delete process.env.HERDR_ENV;
  try {
    const h = harness();
    factory(h.pi);
    h.fire('tool_execution_start', { toolCallId: 't1' });
    h.fire('ui_prompt_start', { title: 'x' });
    assert.equal(h.emitted.length, 0);
  } finally {
    if (prev !== undefined) process.env.HERDR_ENV = prev;
  }
});

test('prompt during a tool call reports blocked, coalesced', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { title: 'Approve deploy' });
  h.fire('ui_prompt_start', { title: 'Nested prompt' });
  assert.deepEqual(h.emitted, [['herdr:blocked', { active: true, label: 'Approve deploy' }]]);
  h.fire('ui_prompt_end');
  assert.deepEqual(h.emitted[1], ['herdr:blocked', { active: false }]);
  h.fire('ui_prompt_end');
  assert.equal(h.emitted.length, 2);
});

test('prompt with no tool in flight never blocks', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  h.fire('ui_prompt_start', { title: 'Idle widget' });
  h.fire('ui_prompt_end');
  assert.equal(h.emitted.length, 0);
});

test('tool end clears the gate for a later prompt', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('tool_execution_end', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { title: 'late' });
  assert.equal(h.emitted.length, 0);
});

test('label falls back when untitled and caps at 120', () => {
  process.env.HERDR_ENV = '1';
  const h = harness();
  factory(h.pi);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('ui_prompt_start', {});
  assert.equal(h.emitted[0][1].label, 'waiting for input');
  h.fire('ui_prompt_end');
  h.fire('ui_prompt_start', { title: 'x'.repeat(200) });
  const label = h.emitted[2][1].label;
  assert.equal(label.length, 120);
  assert.ok(label.endsWith('…'));
});
