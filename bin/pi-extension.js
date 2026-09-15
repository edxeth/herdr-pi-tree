#!/usr/bin/env node
'use strict';

require('../lib/node-version');

// The command line over lib/pi-extension.js — the plugin's "pi-install"
// action. Copies the shipped Pi extension into ~/.pi/agent/extensions/;
// re-running is the update command, --force replaces an unmanaged file at
// the same path, --remove takes the managed copy away again.
//
//   node bin/pi-extension.js             install or refresh (the action)
//   node bin/pi-extension.js --force     replace a foreign file at the path
//   node bin/pi-extension.js --remove    remove the managed copy

const piExtension = require('../lib/pi-extension');

const mode = process.argv.includes('--remove') ? 'remove' : 'install';
const result =
  mode === 'remove' ? piExtension.remove() : piExtension.install({ force: process.argv.includes('--force') });
console.log(result.message);
process.exit(result.ok ? 0 : 1);
