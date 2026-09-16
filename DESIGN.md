---
colors:
  primary: '#89b4fa'
  foreground: '#cdd6f4'
  working: '#f9e2af'
  blocked: '#fab387'
  done: '#a6e3a1'
  heading: '#b4befe'
  fresh: '#94e2d5'
  removed: '#f38ba8'
  branch: '#ffffff'
---

# Herdr Pi Tree

## Overview

Keep the terminal theme. Use logo-free compact rows, numbered Spaces and agents, and left-aligned project headings.

## Colors

`lib/palette.js` defines the sidebar roles. Git stats are one white token with single-space fields and one native separator after the name; per-field colors are impossible without separator dots. Idle text remains readable; only stale sessions fade.

## Typography

Use the existing terminal font and portable status glyphs — filled/hollow dots for motion and rest, a static `?` for blocked, `✓` for done. Do not show harness logos or install fonts automatically.

## Layout

Do not pad project headings or add blank rows between entries. Herdr supplies the native continuation indent. Each section has its own indices, single-spaced after the bracket. Same-cwd agents and split panes are peers; worktrees nest, and pi-subagent tabs (`[name] …`) nest under the pane whose session spawned theirs — true depth, three columns per level with │ guides, a missing parent falling back one level under the workspace's first main.

## Components

Standalone projects inline their Git token on the heading; worktree families give each member its own stats row, counts-only where the label is the branch. The indexed session row carries only status and title. Spaces mirrors the same rule. Hide zero counts and absent Git data.

`heading_git` and `space_git` move each panel's Git token to a row of its own or hide it; inline is the default above. Inline truncates a long name in a narrow panel, so the two panels are separate keys.

Background subagents own no pane, so they own no row. `bg_badge` places their count as `↳N` on the workspace heading (default), on the agent's own row, on a row of its own, or nowhere. The count comes from the spawner's `pi_subagents_work_v1` pane token; children that already draw a row are subtracted, so it counts only what is otherwise invisible. The mark is `glyphs.delegated`.

A daemon start compares the installed sidebar block with the one this build would write and rewrites it when they differ, which is how a settings change reaches the sidebar; the `configure` action and an appearance flip rewrite it too. An absent block is the record that the user chose Herdr's own Agents panel, so it is left absent.

## Motion

Only working agents pulse: filled/hollow dot, at most one update per second. Unseen completion holds a static green ✓ until the pane is focused; blocked holds a static `?` (row lead, state mark, Spaces) and idle dots are static. No spinning glyphs. Git reads refresh every five seconds, shared by cwd across both sections, and include behind as ↓n.
