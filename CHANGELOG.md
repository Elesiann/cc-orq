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

### Changed

- **Breaking:** `capabilities`, `status`, `cancel` and `integrate` are now the
  tools `mcp__plugin_cc-orq_orq__capabilities`, `mcp__plugin_cc-orq_orq__status`,
  `mcp__plugin_cc-orq_orq__cancel` and `mcp__plugin_cc-orq_orq__integrate`. Allow
  rules for the old `mcp__cc-orq__*` names stop applying. `mcp__cc-orq__wait`
  keeps its name.
- **Breaking:** Node 22.18 or newer must be on the `PATH`. The server writes
  `the orq server needs Node 22.18 or newer` to stderr and exits when it is
  older, and `/mcp` shows the failure.
- `capabilities` answers `approval-required` and `default` as `runtimeMode` and
  `interactionMode`, because the server does not know the permission mode of
  the session. The mod used to read it.
- The `SessionStart` hook and the orchestration snippet it printed are gone. The
  guidance for starting a task is now the description of the `cc-orq:task`
  agent, and the guidance for the tools is the server's instructions.

### Fixed

- A finished job could show as failed in the task card or the `/orq-panel`
  pane when either read its `exit` file while the supervisor was writing it.
  The supervisor now writes the file in one step, so a reader sees either no
  file or the whole exit code.

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
