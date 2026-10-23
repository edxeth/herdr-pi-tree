# Changelog

## [Unreleased]

### Fixed

- Fixed the sidebar daemon retrying, every minute for as long as it ran, to clear its marks from each workspace and pane that had closed. Herdr refuses reports for a target that no longer exists, so each closed workspace or pane added a pair of refused requests to the Herdr server log for good. A clear of a gone target now counts as done.

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
