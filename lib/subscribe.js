'use strict';

// The daemon's long-lived event subscription — the reason it can sleep.
//
// One read-only connection carries `events.subscribe`; every line that
// arrives after the ack is treated as a WAKE HINT and nothing more. The
// payloads are deliberately ignored: replays (up to 512 historical events on
// every connect), the 10-events-per-second per-subscription throttle, and the
// two envelope naming styles (snake_case for broadcast kinds, dotted for
// parameterised ones) all stop mattering when the only response to any event
// is "go take a fresh snapshot".
//
// The connection must stay write-silent after the initial request: the server
// treats client bytes on a streaming connection as a disconnect (unix) or
// lets them rot unread (windows). Ordinary requests go through lib/ipc.js on
// their own short connections.
//
// Neither `workspace.metadata_updated` nor `pane.updated` is subscribed: both
// are almost entirely the echo of this plugin's own token writes, and that
// echo is not merely noise. Herdr's server answers other requests late while
// it is flushing events to a subscriber — measured here at ~110ms per write
// with `pane.updated` on, against 1-2ms with it off — so listening to our own
// writes made every write slow, which an animation shows as a stutter. What
// `pane.updated` was kept for, agent status, has had its own event since 0.9.
// Title and cwd changes no longer arrive as events; the daemon's own slow
// heartbeat picks those up.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const { herdrConfigPath } = require('./paths');

const KINDS = [
  'pane.created',
  'pane.closed',
  'pane.exited',
  'pane.agent_detected',
  'pane.focused',
  'workspace.created',
  'workspace.closed',
  'workspace.renamed',
  'workspace.focused',
  'tab.renamed',
];

const PANE_KIND = 'pane.agent_status_changed';
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 30000;

function socketFile() {
  return (
    process.env.HERDR_SOCKET_PATH ?? path.join(path.dirname(herdrConfigPath()), 'herdr.sock')
  );
}

function pipePath() {
  const file = socketFile();
  return process.platform === 'win32' ? `\\\\.\\pipe\\${file}` : file;
}

// Request list: the fixed kinds plus one status entry per live agent pane.
function subscriptions(paneIds) {
  return [...KINDS.map((type) => ({ type })), ...paneIds.map((pane_id) => ({ type: PANE_KIND, pane_id }))];
}

// onWake(): any event arrived, or the stream just (re)connected — resync.
// onGone(): the server is gone for good (its socket marker vanished).
// Reconnects forever with capped backoff otherwise: a reload hiccup or a
// live handoff is a disconnect too, and dying over one would leave the
// sidebar frozen until the next herdr restart.
function start({ onWake, onGone }) {
  let stopped = false;
  let attempts = 0;
  let current = null;
  let retryTimer = null;
  let paneIds = [];

  const connect = () => {
    if (stopped) return;
    const stream = net.connect({ path: pipePath() });
    current = stream;
    let body = '';
    let acked = false;
    let ended = false;

    const retry = () => {
      if (ended) return;
      ended = true;
      stream.destroy();
      if (stopped || current !== stream) return; // superseded by setPanes
      current = null;
      if (!fs.existsSync(socketFile())) {
        onGone();
        return;
      }
      attempts += 1;
      retryTimer = setTimeout(connect, Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(attempts, 6)));
    };

    stream.on('connect', () => {
      stream.write(
        `${JSON.stringify({
          id: 'daemon-sub',
          method: 'events.subscribe',
          params: { subscriptions: subscriptions(paneIds) },
        })}\n`,
      );
    });
    stream.on('data', (chunk) => {
      body += chunk;
      let sawEvent = false;
      let newline;
      while ((newline = body.indexOf('\n')) >= 0) {
        const line = body.slice(0, newline);
        body = body.slice(newline + 1);
        if (!acked) {
          // The ack, or a refusal (the close handler follows it). A refusal
          // keeps the backoff growing instead of hammering the server.
          acked = true;
          if (!line.includes('"error"')) attempts = 0;
        }
        sawEvent = true; // resync after every (re)connect
      }
      if (sawEvent && !stopped) onWake();
    });
    stream.on('error', retry);
    stream.on('close', retry);
  };

  connect();
  return {
    // The live agent panes, as of the latest frame. Same set: nothing to do.
    setPanes(ids) {
      const next = [...new Set(ids)].sort();
      if (stopped || next.join('\n') === paneIds.join('\n')) return;
      paneIds = next;
      clearTimeout(retryTimer);
      const previous = current;
      current = null;
      previous?.destroy();
      attempts = 0;
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      current?.destroy();
    },
  };
}

module.exports = { start, subscriptions, KINDS };
