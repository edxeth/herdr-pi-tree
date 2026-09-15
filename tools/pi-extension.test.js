'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MARKER, installAt, refreshAt, removeAt } = require('../lib/pi-extension');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-piext-'));
  const shipped = path.join(root, 'shipped.ts');
  const target = path.join(root, 'agent', 'extensions', 'herdr-prompt-state.ts');
  fs.writeFileSync(shipped, '// body v1\n');
  return { root, shipped, target };
}

test('install writes a marked copy, then reports current', () => {
  const { shipped, target } = fixture();
  const first = installAt(shipped, target);
  assert.equal(first.ok && first.changed, true);
  const text = fs.readFileSync(target, 'utf8');
  assert.ok(text.startsWith(MARKER));
  assert.ok(text.includes('// body v1'));
  assert.equal(installAt(shipped, target).changed, false);
});

test('refresh updates a marked copy when the shipped file changes', () => {
  const { shipped, target } = fixture();
  installAt(shipped, target);
  fs.writeFileSync(shipped, '// body v2\n');
  const result = refreshAt(shipped, target);
  assert.equal(result.ok && result.changed, true);
  assert.ok(fs.readFileSync(target, 'utf8').includes('// body v2'));
});

test('refresh never creates, and never touches a foreign file', () => {
  const { shipped, target } = fixture();
  assert.equal(refreshAt(shipped, target).changed, false);
  assert.equal(fs.existsSync(target), false);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '// someone else\n');
  assert.equal(refreshAt(shipped, target).changed, false);
  assert.equal(installAt(shipped, target).ok, false);
  assert.ok(fs.readFileSync(target, 'utf8').includes('someone else'));
});

test('force replaces a foreign file; remove takes only the managed copy', () => {
  const { shipped, target } = fixture();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '// someone else\n');
  assert.equal(installAt(shipped, target, { force: true }).changed, true);
  assert.ok(fs.readFileSync(target, 'utf8').startsWith(MARKER));
  assert.equal(removeAt(target).changed, true);
  assert.equal(fs.existsSync(target), false);
  fs.writeFileSync(target, '// someone else\n');
  assert.equal(removeAt(target).ok, false);
  assert.ok(fs.existsSync(target));
});

test('install follows PI_CODING_AGENT_DIR, and the plugin env wins over it', () => {
  const savedPi = process.env.PI_CODING_AGENT_DIR;
  const savedOwn = process.env.HERDR_PI_TREE_AGENT_DIR;
  const piDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-pienv-'));
  const ownDir = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-pi-tree-ownenv-'));
  try {
    process.env.PI_CODING_AGENT_DIR = piDir;
    delete process.env.HERDR_PI_TREE_AGENT_DIR;
    const result = require('../lib/pi-extension').install();
    assert.equal(result.ok, true, result.message);
    assert.ok(fs.existsSync(path.join(piDir, 'extensions', 'herdr-prompt-state.ts')));
    require('../lib/pi-extension').remove();
    process.env.HERDR_PI_TREE_AGENT_DIR = ownDir;
    const again = require('../lib/pi-extension').install();
    assert.equal(again.ok, true, again.message);
    assert.ok(fs.existsSync(path.join(ownDir, 'extensions', 'herdr-prompt-state.ts')));
    assert.ok(!fs.existsSync(path.join(piDir, 'extensions', 'herdr-prompt-state.ts')));
  } finally {
    if (savedPi === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = savedPi;
    if (savedOwn === undefined) delete process.env.HERDR_PI_TREE_AGENT_DIR; else process.env.HERDR_PI_TREE_AGENT_DIR = savedOwn;
    fs.rmSync(piDir, { recursive: true, force: true });
    fs.rmSync(ownDir, { recursive: true, force: true });
  }
});
