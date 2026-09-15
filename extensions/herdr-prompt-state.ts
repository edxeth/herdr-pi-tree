// Companion Pi extension for Herdr Pi Tree: the missing producer of
// `herdr:blocked`. Herdr's own managed extension (~/.pi/agent/extensions/
// herdr-agent-state.ts, installed and updated by Herdr's integration)
// already consumes those events on the inter-extension bus and reports
// Herdr's `blocked` agent state; this bridge is what emits them for Pi
// agents. Without it a Pi agent whose tool call is waiting on an interactive
// TUI keeps showing `working` instead.
//
// Pi fires ui_prompt_start / ui_prompt_end around every extension UI prompt —
// ctx.ui.custom(), select(), confirm(), input(), editor() — from any
// extension, with nested or overlapping prompts coalesced into one span.
// But only a prompt opened by a running tool call actually blocks the agent:
// commands, shortcuts, and fire-and-forget widgets render TUIs while the
// agent keeps working, and those must stay working. Pi emits
// tool_execution_start/end around every tool execution and awaits the start
// before the tool runs, so a prompt that begins while some tool call is in
// flight is one a human must answer for the agent to continue — an
// ask-style tool or any other extension's, no hardcoding. The gate is judged
// only when the prompt opens; prompts that never emit a start never emit an
// end, so the consumer's blockedCount stays balanced. No toast from here:
// Herdr already fires its own native attention notification on the blocked
// transition, and a second one from this side just doubles the ding.
//
// Ships in this repo's extensions/ directory. Plugin setup copies it to
// ~/.pi/agent/extensions/herdr-prompt-state.ts (auto_install_pi_extension,
// on by default; the `pi-install` action does it by hand) under a one-line
// managed marker; never keep a second unmanaged copy at that path, or the
// bridge loads twice and every event fires doubled. Outside Herdr
// (HERDR_ENV unset) the factory registers nothing and the file is inert;
// removing it entirely is always safe — panes fall back to plain
// working/idle.
//
// The body is deliberately plain JavaScript, so plain node can load a renamed
// copy for quick checks without a transpiler (tools/prompt-state.test.js
// does exactly that). Keep it that way.

'use strict';

const FALLBACK_LABEL = 'waiting for input';
const LABEL_MAX = 120;

function labelFor(event) {
  const title = event && typeof event.title === 'string' ? event.title.trim() : '';
  if (!title) return FALLBACK_LABEL;
  return title.length <= LABEL_MAX ? title : title.slice(0, LABEL_MAX - 1) + '…';
}

module.exports = function herdrPromptState(pi) {
  if (process.env.HERDR_ENV !== '1') return;

  // Tool calls in flight, by id: the only prompts that block the agent.
  const running = new Set();

  pi.on('tool_execution_start', (event) => {
    if (event && typeof event.toolCallId === 'string') running.add(event.toolCallId);
  });

  pi.on('tool_execution_end', (event) => {
    if (event && typeof event.toolCallId === 'string') running.delete(event.toolCallId);
  });

  // One emit pair per waiting span keeps the consumer's blockedCount
  // balanced even if pi ever double-fires a start.
  let waiting = false;

  pi.on('ui_prompt_start', (event) => {
    if (waiting || running.size === 0) return;
    waiting = true;
    pi.events.emit('herdr:blocked', { active: true, label: labelFor(event) });
  });

  pi.on('ui_prompt_end', () => {
    if (!waiting) return;
    waiting = false;
    pi.events.emit('herdr:blocked', { active: false });
  });
};
