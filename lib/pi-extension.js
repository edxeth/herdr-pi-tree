'use strict';

// The Pi-side half of blocked-state detection ships in this repo at
// extensions/herdr-prompt-state.ts; this module puts it where Pi loads
// extensions from (~/.pi/agent/extensions/). The first copy only ever
// happens through the plugin's explicit "pi-install" action — this plugin
// does not write into Pi's directory unasked. The installed copy carries a
// one-line marker above the shipped body, and that marker is the whole
// contract: it separates "ours, safe to refresh or remove" from "someone
// else's file, hands off". Once the marker is there the daemon refreshes
// the copy on every start, so updating the plugin updates the extension
// with the next daemon launch — Pi is never involved and has nothing to
// notify about, exactly like the managed blocks in Herdr's config.toml.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const identity = require('./identity');

const MARKER = `// Managed by ${identity.NAME} — refreshed by the plugin's Pi-extension action; hand edits are overwritten.`;

function shippedPath() {
  return path.join(__dirname, '..', 'extensions', 'herdr-prompt-state.ts');
}

function installedPath(dir = agentDir()) {
  return path.join(dir, 'extensions', 'herdr-prompt-state.ts');
}

// Where Pi's agent directory is: Pi's own override wins (its config.js
// reads PI_CODING_AGENT_DIR, tilde-expanded, defaulting to ~/.pi/agent —
// and discovers extensions under <agent dir>/extensions), with this
// plugin's own env above it for tests and unusual layouts.
function expandTilde(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function agentDir() {
  const own = identity.env('AGENT_DIR');
  if (own) return own;
  const pi = process.env.PI_CODING_AGENT_DIR;
  if (pi) return expandTilde(pi);
  return path.join(os.homedir(), '.pi', 'agent');
}

// jiti can pick the file up mid-write; land it atomically like the caches.
function writeAtomic(file, text) {
  const tmp = file + identity.TMP_SUFFIX;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Core operations on explicit paths, so tests never touch the real agent dir.
function installAt(shipped, target, { force = false } = {}) {
  let body;
  try {
    body = fs.readFileSync(shipped, 'utf8');
  } catch {
    return { ok: false, changed: false, message: `pi: shipped extension missing (${shipped})` };
  }
  const content = `${MARKER}\n\n${body}`;
  let existing = null;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    // Not installed yet.
  }
  if (existing === content) return { ok: true, changed: false, message: 'pi: extension current' };
  if (existing !== null && !existing.startsWith(MARKER) && !force) {
    return {
      ok: false,
      changed: false,
      message: `pi: ${target} already exists and is not managed by this plugin — move it aside, or re-run with --force`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    writeAtomic(target, content);
  } catch (error) {
    return { ok: false, changed: false, message: `pi: could not write ${target} (${error.message})` };
  }
  return {
    ok: true,
    changed: true,
    message: existing === null ? `pi: extension installed at ${target}` : `pi: extension refreshed at ${target}`,
  };
}

// The daemon's every-start check: only ever touches a copy this plugin
// installed. Never creates one — the first install stays an explicit action.
function refreshAt(shipped, target) {
  let existing;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    return { ok: true, changed: false, message: 'pi: extension not installed' };
  }
  if (!existing.startsWith(MARKER)) return { ok: true, changed: false, message: 'pi: extension not managed by this plugin' };
  return installAt(shipped, target);
}

function removeAt(target) {
  let existing;
  try {
    existing = fs.readFileSync(target, 'utf8');
  } catch {
    return { ok: true, changed: false, message: 'pi: no managed extension to remove' };
  }
  if (!existing.startsWith(MARKER)) {
    return { ok: false, changed: false, message: `pi: ${target} is not managed by this plugin — left in place` };
  }
  try {
    fs.unlinkSync(target);
  } catch (error) {
    return { ok: false, changed: false, message: `pi: could not remove ${target} (${error.message})` };
  }
  return { ok: true, changed: true, message: `pi: extension removed (${target})` };
}

const install = (options) => installAt(shippedPath(), installedPath(), options);
const refresh = () => refreshAt(shippedPath(), installedPath());
const remove = () => removeAt(installedPath());

module.exports = { MARKER, agentDir, shippedPath, installedPath, installAt, refreshAt, removeAt, install, refresh, remove };
