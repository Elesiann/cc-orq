# Changelog

All notable changes to cc-orq are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A stdio MCP server, `plugin:cc-orq:orq`, that serves the tools `capabilities`,
  `status`, `list`, `cancel` and `integrate`. They are there whether or not the
  mod loads. The server sends its own instructions to the session. The MCP SDK
  it runs on is bundled in `server/vendor/mcp-sdk.mjs`, so a user has no package
  to install, and `NOTICE` carries the licenses of the packages in the bundle.
- The tool `list`: the newest jobs first, whatever started them, with each
  job's status, instance, model, duration, working directory, branch and
  whether it ended on a question.
- `integrate` answers `task_running`, and names the job, while a job is still
  running on the task branch or inside its worktree, a shared job included. A
  job that has not written its process group yet counts as running for its
  first 10 seconds. It runs no git command before that answer.
- After a merge fails, `integrate` undoes the merge itself only when every
  changed tracked path, staged or not, is one that the task branch changes, which
  it records before the merge. It then aborts a pending merge, or resets a
  half-made one that a killed git left with no `MERGE_HEAD`. A tracked change
  outside those paths is probably yours, so it changes nothing, names those
  paths, lists the rest, and names `git merge --abort` or `git reset --merge` for
  you to run after you check; either drops staged changes of your own too. A
  change of yours to a path that the task also changes counts as the merge's. The
  answer lists up to 10 paths that stay, such as a file a hook made, a
  `reference-transaction` refusal included. A merge that git's 60 second limit
  kills answers `git_failed` and names the timeout.
- The config key `integrate.gitHooks`. With `"run"`, `integrate` runs the git
  hooks of the checkout as they are, and a hook that refuses the merge, such as
  a failing `pre-merge-commit`, makes it abort the merge and answer `hook_failed`
  with the hook's output from stdout and stderr. The README says what the opt-in
  risks: a worker that can write the checkout's shared git directory, or a hooks
  path in the work tree, decides what runs. Any other value, and the default,
  run no hook.

### Changed

- **Breaking:** `capabilities`, `status`, `cancel` and `integrate` are now the
  tools `mcp__plugin_cc-orq_orq__capabilities`, `mcp__plugin_cc-orq_orq__status`,
  `mcp__plugin_cc-orq_orq__cancel` and `mcp__plugin_cc-orq_orq__integrate`. Allow
  rules for the old `mcp__cc-orq__*` names stop applying. `mcp__cc-orq__wait`
  keeps its name.
- **Breaking:** Node 22.18 or newer must be on the `PATH`. The server writes
  `the orq server needs Node 22.18 or newer` to stderr and exits when it is
  older; the `cc-orq:task` agent keeps working, without the server's tools.
- `capabilities` answers `approval-required` and `default` as `runtimeMode` and
  `interactionMode`, because the server does not know the permission mode of
  the session. The mod used to read it.
- The `SessionStart` hook and the orchestration snippet it printed are gone. The
  guidance for starting a task is now the description of the `cc-orq:task`
  agent, and the guidance for the tools is the server's instructions.
- The README says what a worktree task shares with your checkout: the `.git`
  directory. A worker that can write it can change git config or hooks that
  run programs in any later git command there, `integrate` and your own `git`
  commands included, so untrusted workers belong in modes that cannot write
  outside their worktree.

### Fixed

- The README said that `integrate` runs the hooks of your checkout. It never
  did, because the mod's engine runs git with hooks off, and it still runs none
  unless the config sets `integrate.gitHooks` to `"run"`.
- A finished job could show as failed in the task card or the `/orq-panel`
  pane when either read its `exit` file while the supervisor was writing it.
  The supervisor now writes the file in one step, so a reader sees either no
  file or the whole exit code.
- Two shared launches into one checkout could both start when they began at
  the same moment, for example from two sessions, because each looked for a
  live job before either had written its own. A shared launch now takes a lock
  on its checkout first, and the later one is refused with `worktree_busy` and
  the id of the job that holds it. A subdirectory or a symlink of a checkout is
  the same checkout, and a live job in a subdirectory now blocks a shared
  launch at the top level. A launch that cannot make, write or take over the
  lock is refused with `could not lock its checkout`. A launch keeps its lock
  while it scans the jobs directory, and one whose lock another launch took
  over during the scan is refused with `worktree_busy`.

## [0.1.1] - 2026-10-21

### Added

- A task's worktree gets the files the checkout's `.worktreeinclude` names,
  the file Claude Code reads for its own worktrees: every file that matches a
  pattern and is gitignored, such as `node_modules` or generated types. The
  copy is all or nothing, and it never writes through a symlink.

### Fixed

- `capabilities` lists every model `opencode models` reports, including the
  free `opencode/*` models and providers configured through the environment.
  It no longer filters by `opencode auth list`, retries a failed
  `opencode models` once, and leaves the OpenCode model labels empty, since
  they repeated the id.
- The handback footer names the effort a Claude or Antigravity task gave its
  CLI, instead of `effort n/a`, and a Codex task whose rollout cannot be read
  falls back to the same value.

## [0.1.0] - 2026-10-21

First public release.

### Added

- A detached job engine. Each job runs a provider CLI (Codex, OpenCode,
  Antigravity or Claude) under its own supervisor and process group, keeps its
  prompt, events, final message and exit code in its own directory, and
  outlives the Claude Code session that started it.
- The `/orq` command: `list`, `result`, `cancel` and `launch`.
- The `cc-orq:task` agent type. A task names its instance and model in a header,
  runs as a job, and returns its answer to the parent session when the job
  ends. The parent's permission mode caps what a task may do, and a driver
  refuses a mode it cannot enforce.
- The MCP tools `capabilities`, `status` and `cancel`, with the shapes of
  T3 Code's orchestrator contract, and `integrate`. The subagent of a task
  waits on its job through a fifth tool, `wait`.
- Worktree isolation: a task runs in its own git worktree on a new branch by
  default, and `integrate` merges that branch back with `ff-only` or `merge`.
- Child questions: a blocked job writes its question to `question.txt` and
  stops, and the parent answers it in a new task. The OpenCode tool
  `opencode/tools/orq_ask.ts` writes the same file.
- The orchestration instructions, delivered to the parent session by a
  `SessionStart` hook.
- A task card above the prompt, or on the status line, that shows each running
  job's instance, model, status, last action and duration, and the
  `/orq-panel` pane to follow and cancel jobs.
- The `cardDisplay` setting (`band`, `status` or `off`) and the optional
  `~/.config/orq/config.json` for the jobs directory, wait slice, allowed roots
  and provider instances.

[Unreleased]: https://github.com/Elesiann/cc-orq/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Elesiann/cc-orq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Elesiann/cc-orq/releases/tag/v0.1.0
