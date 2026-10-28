# Changelog

## [Unreleased]

## [0.1.7] - 2026-10-28

### Fixed

- Fixed linked worktrees whose main checkout has no agent each drawing a heading of their own. They now share one heading, named as Herdr's Spaces panel names the checkout's workspace rather than after the repository directory. The repository name is still used when the checkout is not open as a workspace.
- Fixed the vertical tree line under a worktree branch. It now sits under the branch corner and stops at the last branch that has an agent row.
- Fixed the branch in Herdr's mobile Spaces list staying at the branch a workspace had when it was created. Herdr updates that branch only while the Spaces rows ask for its built-in branch field. The generated rows now include that field, hidden, so the desktop rows look the same. The sidebar block is rewritten on the next daemon start.
- Fixed the sidebar daemon retrying, every minute for as long as it ran, to clear its marks from each workspace and pane that had closed. Herdr refuses reports for a target that no longer exists, so each closed workspace or pane kept adding refused requests to the Herdr server log. A clear of a gone target now counts as done.

#### Agent questions and refusal choices show as waiting
Refs: `5abdf1c`

Fixed agent questions and `claude-refusal-rewind` refusal choices staying marked as working while they waited for an answer. This includes questions opened over another popup and recovered unanswered questions. Other extensions need no changes.

The companion extension now shows `?` only for version-1 question notifications and the supported refusal selector. Before, any extension prompt opened while a tool ran showed `?`, including menus you opened yourself. Those menus, replay forms, and unrecognized dialogs now leave the agent working. The wait clears when the question finishes, its tool ends, or the session closes.

The plugin refreshes its managed copy of the companion extension on its next setup or state action. Reload Pi to load the refreshed copy.

## [0.1.6] - 2026-10-09

### Fixed

- Fixed light-theme sidebar configurations that Herdr rejected because working-state colors were missing.
- Fixed dim repository headings above linked worktrees when the main checkout has no agent. These headings now use the normal project-heading style.
- Fixed setup repeating on each daemon start when automatic font installation is disabled and the bundled font is absent.

#### Configuration reload failures are reported and can be retried
Refs: `1e948c8`

Fixed configuration reloads reporting success when Herdr rejected or only partly applied the requested changes.

Configure and view-switch commands now report the failure. The sidebar daemon stays running, and a failed view switch keeps the previous mode.

Setup and sidebar switching retry failed reloads even when the configuration file already contains the requested changes.
