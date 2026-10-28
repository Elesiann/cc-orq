# Changelog

All notable changes to cc-orq are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Cancelling a `questions: human` task while its form is open now closes the
  form. Before, `status` and the BLOCKED text kept saying that the user was
  answering it in a form.
- A worker that leaves a blank `question.txt` and ends with a `BLOCKED:` final
  message gets its question written, as one with no `question.txt` does. The
  engine already read a blank file as no question.
- A launch that stalled past the 10 s grace between taking its lock and writing
  its owner could remove the lock of the launcher that broke it and took it. A
  claim now creates its owner file exclusively, and an owner file it finds
  already there, even an empty one, makes the claim busy.
- The catalog probe starts no command after 75 s and stops the one still running
  then. The engine kills it at 90 s, and an OpenCode probe that ran that long
  left its MCP servers running.

## [0.2.1] - 2026-10-25

### Fixed

- A worker below `auto` cannot write its question to `question.txt` outside its
  directory, so its question never reached `answer`. When a job exits 0 and its
  final message starts with `BLOCKED:`, the supervisor now writes the text after
  that `BLOCKED:` to `question.txt`, unless the worker wrote one itself, before the
  job's `exit` file appears.
- A supervisor that started after its launcher had given up (`exit` 125) still
  ran its worker, next to the job of whoever took the lock. A supervisor now starts
  no worker when the job's `exit` file already exists. The check and the start are
  not atomic, so a launcher that gives up at that moment can still lose.
- The BLOCKED text and `status` of a question name the real state. After the
  question was answered they name the continuation's taskId, and while a human
  form is open they say the user is answering it in a form. They no longer tell
  the session to call `answer` when `answer` would refuse.
- `already_answered` says to read the continuation with `status`, and to delegate
  anew if it failed.
- `answer` on a job that wrote its question but has not exited says so, and to
  answer when the job ends, instead of saying it is waiting.

## [0.2.0] - 2026-10-25

### Breaking changes

- The tools `capabilities`, `status`, `cancel` and `integrate` are now
  `mcp__plugin_cc-orq_orq__capabilities`, `mcp__plugin_cc-orq_orq__status`,
  `mcp__plugin_cc-orq_orq__cancel` and `mcp__plugin_cc-orq_orq__integrate`. Allow
  rules for the old `mcp__cc-orq__*` names stop applying. `mcp__cc-orq__wait`
  keeps its name.
- The `ceiling` of the configuration now limits `cc-orq:task` too. By default a
  worker edits only inside its own worktree and a `shared` worker only reads, so a
  session in `auto` or `bypassPermissions` mode no longer gets workers in that
  mode. To give workers `auto` in an `auto` session, set
  `"ceiling": {"runtime": "auto"}`.
- Node 22.18 or newer must be on the `PATH`. The server writes
  `the orq server needs Node 22.18 or newer` to stderr and exits when it is
  older; the `cc-orq:task` agent keeps working, without the server's tools.
- The config key `"integrate": {"gitHooks": "run"}` is new. Without it, `integrate`
  runs no hook of the checkout, as 0.1 did, so no existing setup changes. With it,
  a hook that refuses the merge makes `integrate` answer `hook_failed`.
- The `BLOCKED on a question` text tells the session to answer with the `answer`
  tool, which resumes the same worker. A job that recorded no session says it cannot
  be resumed, and a new `delegate` with the brief and the answer is the way.
- The `SessionStart` hook and the orchestration snippet it printed are gone. The
  guidance for starting a task is the description of the `cc-orq:task` agent, and
  the guidance for the tools is the server's instructions.

### Added

- A stdio MCP server, `plugin:cc-orq:orq`, that serves the tools `capabilities`,
  `delegate`, `answer`, `status`, `list`, `cancel` and `integrate`. They are there whether
  or not the mod loads. The server sends its own instructions to the session.
  The MCP SDK it runs on is bundled in `server/vendor/mcp-sdk.mjs`, so a user has
  no package to install, and `NOTICE` carries the licenses of the packages in
  the bundle.
- The tool `list`: the newest jobs first, whatever started them, with each
  job's status, instance, model, duration, working directory, branch and
  whether it ended on a question.
- The tool `delegate` starts a job. A client that declares the MCP tasks
  extension gets a task (below), and any other client gets `{"taskId", "status":
  "running"}` at once. Its fields are the header of a `cc-orq:task` prompt, read by the same
  parser, so a mistake gets the same message. It works in a worktree by default,
  holds the request to the permission ceiling, and refuses what is above it with
  the escalation code and what lifts the limit. It takes a prompt of at most
  200,000 characters. Its job has kind `mcp`, the session id as its `agentId`
  (or `mcp`), and `questions` in `meta.json`.
- `delegate` returns an MCP task to a client that declares the tasks extension
  on the request, as the Claude Code CLI does. `/tasks` lists it with the
  worker's instance, model and last action, and the session wakes by itself with
  the worker's answer, the footer, and for a worktree job the branch and the
  `integrate` call. The task has the id of its job, so `status`, `list` and
  `integrate` take it. `tasks/get` derives its state from the files in the job
  directory on every request and holds nothing in memory, so a server that
  starts after Claude Code was closed answers for the tasks of the session
  before. `tasks/cancel` is idempotent, as Claude Code sends it twice;
  `tasks/update` ignores a key that is not outstanding; `tasks/result` and
  `tasks/list` answer -32601. A client without the extension gets the same
  bytes as before, and a subagent's call declares none (measured on Claude Code
  2.1.310).
- A request above the ceiling opens a form in the CLI instead of being refused,
  when the client declares tasks and form input. The form says who asks, the
  real directory, whether the task runs in its own worktree or in your checkout
  itself, and which limit each level is above (`ceiling.runtime`,
  `ceiling.sharedRuntime` or `ceiling.interaction`, and the session's mode when
  it is the lower). What the model chose is quoted, cut and escaped. Accepting
  starts the job at the level asked, for that task only, and only when the launch
  still matches what the form showed; declining or Esc ends the task with the
  escalation error. A request that could not start is refused before any form.
- `.tasks/ID/` in the jobs directory holds the record of a task (`task.json`,
  written once before the task is answered) and the markers `approved`,
  `declined`, `refused` and `cancelled`. Old tasks and jobs of the `cc-orq:task`
  agent have none and read as tasks from their job alone.
- The `ceiling` field of `~/.config/orq/config.json`: `runtime` (default
  `auto-accept-edits`) limits a task in its own worktree, `sharedRuntime`
  (default `approval-required`) limits a task with `isolation: shared`, and
  `interaction` (default `default`) limits the interaction mode. A value that is
  not valid counts as the narrowest mode, and `capabilities` reports it.
- A `PreToolUse` hook, `scripts/session-mode-hook.sh`, gives `delegate`,
  `answer` and `capabilities` the session's permission mode as `sessionMode`, over any value
  the model wrote there. It returns the changed input and never a permission
  decision. It blocks the call when it has no `python3`, cannot read its input,
  or finds a `permission_mode` that is empty or not text, since a call let
  through could carry a mode the model forged. A session's own limit holds only
  while the hook runs: without it, the configuration's limit is the most a task
  can get.
- `integrate` answers `task_running`, and names the job, while a job is still
  running on the task branch or inside its worktree, a shared job included. A
  job that has not written its process group yet counts as running for its
  first 10 seconds. It runs no git command before that answer.
- After a merge fails, `integrate` undoes the merge itself only when it can read
  the whole state and every changed tracked path, staged or not, is one that the
  task branch changes, which it records before the merge. It then aborts a
  pending merge, or resets a half-made one that a killed git left with no
  `MERGE_HEAD`. Otherwise it changes nothing and leaves a pending merge pending.
  A tracked change outside those paths is probably yours. A list that git printed
  beyond the 4 MiB the engine reads, or a path that is not valid UTF-8, cannot be
  compared. The answer names the paths or the reason, lists the rest, and names
  `git merge --abort` or `git reset --merge` for you to run after you check;
  either drops staged changes of your own too. Both reads pass
  `--ignore-submodules=none`. The check goes by path, so these cases are
  limits: a change of yours to a path that the task also changes counts as the
  merge's, a change you stage between the status read and the abort goes with the
  merge, and a rename that git follows during the merge writes a path outside the
  list and stops the cleanup.
- After a failed merge, `integrate` reads the checkout and lists up to 10 paths
  that stay, such as a file a hook made, a `reference-transaction` refusal
  included. It skips that read only when the check whether the branch is already
  in HEAD fails with exit 128, and then answers `git_failed`. A merge that git's
  60 second limit kills answers `git_failed` and names the timeout.
- The config key `integrate.gitHooks`. With `"run"`, `integrate` runs the git
  hooks of the checkout as they are, and a hook that refuses the merge, such as
  a failing `pre-merge-commit`, makes it abort the merge, when the cleanup rule
  allows it, and answer `hook_failed` with the hook's output from stdout and
  stderr. The README says what the opt-in risks: a worker that can write the
  checkout's shared git directory, or a hooks path in the work tree, decides what
  runs. Any other value, and the default, run no hook.
- The tool `answer` answers the question of a worker that stopped on one. The same
  worker resumes its own session in a new job, in the same directory, worktree
  and branch, with the answer as its next message, so it keeps what it had read
  and done instead of starting again from the brief. A client with MCP tasks gets a
  task of its own for the continuation, and any other client gets `{"taskId",
  "status": "running"}`. The first answer claims the question with the file `next`,
  created whole and only when absent, so two answers at once start one worker and
  the second gets `already_answered` with the id of the continuation. A job that
  recorded no session, or whose instance, `CODEX_HOME` or directory changed,
  answers `resume_unavailable`, and `delegate` with the brief and the answer is
  the way left. The continuation never runs above its worker's level, and it is
  checked as a launch is: its directory must be in scope, a worktree counts as the
  task's own only when its branch is `orq/ID` of a job that does not run and whose
  `next` claims lead to this job (or of this job itself), its checkout is in scope,
  its path is the one a launch computes for that ID, `git worktree list` of the
  recorded checkout lists it on that branch, its directory resolves, links followed,
  to where a launch put it and inside the worktree, and no other live job holds the
  branch (else the worker
  runs, is scoped and is locked as a shared one, in a resolved directory that is
  never the path `meta.json` names), and a level above
  the ceiling opens the same form as `delegate`, or is refused for a client with no
  form. An approval carries over only from the server's own task records of the
  same chain, for the same worker at no higher level, never from `meta.json`. A
  worker below `auto` cannot write its question outside its directory (measured
  with a Claude worker at `manual` and `acceptEdits`, which could not), so only a
  worker that could write it reaches `answer`.
- `questions: human`, for a client that declares MCP tasks and form input. A worker
  that stops on a question puts its task in `input_required`, with a free-text form
  that shows the worker and its question, and the answer resumes the same worker
  as a job of the same task, which then ends with the result of the job that
  finished last, held to the ceiling again as `answer` is (the config now, and
  the session mode the server last saw, since `tasks/update` carries none). Declining
  the form, Esc, a worker that cannot be resumed, a continuation that cannot start,
  a level above the ceiling, and 24 hours end the task with the BLOCKED text,
  and `answer` can then answer it. `x` on an open form cancels the task, and while
  a form is open `answer` gets `awaiting_form`. Any other client is refused.
- The supervisor writes the worker's session id to the file `session` before it
  writes `exit`, and a job with a `resume` file starts the CLI's own resume form
  for that session: `codex exec resume`, `opencode run --session`, `claude -p
  --resume` or `agy --conversation`. `codex exec resume` takes no `-s`, `-C` or
  `--approve-for-me`, so the sandbox and the approval settings travel as `-c`
  values; a resume that names no sandbox falls back to the user's `config.toml`
  (measured on codex-cli 0.162.1). A resumed job says which argv it ran in
  `child.log`, without the prompt. The OpenCode and Antigravity resumes follow
  their `--help` and were not run.
- `status` names the job that a continuation answers (`parent`) and the job that
  took a question over (`next`). `list` fills `parent`, and its `question` is
  true only while nobody has answered.
- A conformance job for the task layer. `tests/conformance/` serves the seven
  fixtures of the MCP conformance suite (`greet`, `slow_compute`, `failing_job`,
  `protocol_error_job`, `confirm_delete`, `multi_input` and `test_tool_with_task`)
  over a test-only HTTP entry, through `server/protocol.ts`, and CI runs each of
  the suite's ten tasks scenarios by name, at commit c37eec8. Nine pass, with
  44 checks, and `tasks-status-notifications` is skipped by the suite itself,
  because its harness reads the SSE of `tools/call` where the spec has
  `subscriptions/listen`. `--requirements 2026-07-28` is not the gate, since it
  lists these scenarios as `not_scored`. The product still serves stdio only.

- macOS, experimental. CI runs the test suites on `macos-latest` as well as
  `ubuntu-latest`. Where `setsid` is missing, as on macOS, the start script runs
  the supervisor through `python3` with `os.setsid()`, and the job's `scope`
  file says `python-setsid`. The supervisor runs under bash 3.2. The sweep
  needs `/proc`, so it ends nothing on macOS, and a cancel still ends the
  process group. Nobody has run a job with a real CLI there.

- The tool `answer` answers the question of a worker that stopped on one. The same
  worker resumes its own session in a new job, in the same directory, worktree
  and branch, with the answer as its next message, so it keeps what it had read
  and done instead of starting again from the brief. A client with MCP tasks gets a
  task of its own for the continuation, and any other client gets `{"taskId",
  "status": "running"}`. The first answer claims the question with the file `next`,
  created whole and only when absent, so two answers at once start one worker and
  the second gets `already_answered` with the id of the continuation. A job that
  recorded no session, or whose instance, `CODEX_HOME` or directory changed,
  answers `resume_unavailable`, and `delegate` with the brief and the answer is
  the way left. The continuation never runs above its worker's level and is held
  to the ceiling again, unless the user allowed that level in a form for the task
  that started the worker.
- The supervisor writes the worker's session id to the file `session` before it
  writes `exit`, and a job with a `resume` file starts the CLI's own resume form
  for that session: `codex exec resume`, `opencode run --session`, `claude -p
  --resume` or `agy --conversation`. `codex exec resume` takes no `-s`, `-C` or
  `--approve-for-me`, so the sandbox and the approval settings travel as `-c`
  values; a resume that names no sandbox falls back to the user's `config.toml`
  (measured on codex-cli 0.162.1). A resumed job says which argv it ran in
  `child.log`, without the prompt. The OpenCode and Antigravity resumes follow
  their `--help` and were not run.
- `status` names the job that a continuation answers (`parent`) and the job that
  took a question over (`next`). `list` fills `parent`, and its `question` is
  true only while nobody has answered.
- A conformance job for the task layer. `tests/conformance/` serves the seven
  fixtures of the MCP conformance suite (`greet`, `slow_compute`, `failing_job`,
  `protocol_error_job`, `confirm_delete`, `multi_input` and `test_tool_with_task`)
  over a test-only HTTP entry, through `server/protocol.ts`, and CI runs each of
  the suite's ten tasks scenarios by name, at commit c37eec8. Nine pass, with
  44 checks, and `tasks-status-notifications` is skipped by the suite itself,
  because its harness reads the SSE of `tools/call` where the spec has
  `subscriptions/listen`. `--requirements 2026-07-28` is not the gate, since it
  lists these scenarios as `not_scored`. The product still serves stdio only.
- macOS, experimental. CI runs the test suites on `macos-latest` as well as
  `ubuntu-latest`. Where `setsid` is missing, as on macOS, the start script runs
  the supervisor through `python3` with `os.setsid()`, and the job's `scope`
  file says `python-setsid`. The supervisor runs under bash 3.2. The sweep
  needs `/proc`, so it ends nothing on macOS, and a cancel still ends the
  process group. Nobody has run a job with a real CLI there.

### Changed

- `capabilities` reports `client.forms` as true for an `elicitation` capability
  that names no mode, which the MCP spec defines as form mode.
- The tool descriptions and `server/instructions.md` tell the session that a task
  wakes it with the result, so it ends its turn and does not poll.
- A task refused for asking above its ceiling gets a message that names the
  limit in the way and what lifts it: the `ceiling` field of the configuration,
  the session's permission mode, or both.
- `capabilities` answers the effective ceiling as `runtimeMode` and
  `interactionMode`, the lower of the configuration's `ceiling` and the
  session's permission mode, which counts as far as the hook supplies it, and
  adds `ceiling` (the configuration's limits, the session's mode and each
  isolation's effective ceiling) and `client` (whether the client declared MCP
  tasks and form input).
- The working-directory check resolves a path with `fs.stat` instead of the
  GNU-only `realpath -e` and `-m`. An `allowedRoots` entry that does not exist
  is no longer listed among the roots of a refusal. It admitted nothing before
  either. In the MCP server, the check folds each `..` into the path's text before it
  follows a symlink, as `cd -L` does, so `link/..` names the parent of the link. A `..`
  right after a symlink or after a missing directory resolves by text, in a `cwd`
  and in an `allowedRoots` entry.
- A cancel no longer waits out the 5 seconds when the CLI ends sooner. Once the
  CLI has ended and its leftovers are swept, the supervisor writes `exit` 124
  and sends SIGKILL to the process group. A process in the group that needs
  longer than the CLI to stop on SIGTERM gets less than the 5 seconds a cancel
  gave it before.
- The README says what a worktree task shares with your checkout: the `.git`
  directory. A worker that can write it can change git config or hooks that
  run programs in any later git command there, `integrate` and your own `git`
  commands included, so untrusted workers belong in modes that cannot write
  outside their worktree.
- `/orq list` has an `origin` column between `elapsed` and `cwd`, so `cwd` is now
  the sixth column. A job that continues another one, and records that job's id
  as `parent` in its `meta.json`, shows `↳` and that id. Any other job shows
  `delegate` (kind `mcp`), `agent` (kind `task`) or `manual`. A `parent` that is
  not a safe job id is ignored. In `/orq-panel`, the detail of a selected
  continuation names its parent on a line under the job's id.

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
  while it scans the jobs directory. It checks that the lock is still its own
  before it writes its job and again right before it starts it, under the mutex
  that a break takes, and the check fails closed. A launcher that stops for more
  than 60 s while it holds that mutex can still let two launches start, because
  the next launcher then counts the mutex as abandoned. A launch whose lock another
  launch took over, or whose check fails, is refused with `worktree_busy`. A
  supervisor that writes its pid after its launch gave up still runs its
  worker, which the supervisor has to close itself.
- OpenCode jobs and the `capabilities` probe no longer go through OpenCode's
  shared background service. That service started your OpenCode MCP servers
  again for each command and kept them running, which left 41 processes and
  about 2 GB of memory in use after one probe on OpenCode 2.0.27. Every command
  also ran with the environment the service was started with. Jobs and the
  probe now pass `--standalone`, so OpenCode runs on a private server that uses
  the command's environment and ends with the command.
- A process that a job's CLI left running outside its process group, such as an
  OpenCode MCP server that was still starting when the command ended, no longer
  outlives the job. When the CLI is gone, finished or cancelled, the supervisor
  ends every process that still carries the job's `ORQ_JOB_DIR` before it
  writes `exit`, so a cancelled job reads `cancelled` only once they are gone,
  and the `capabilities` probe does the same for each `opencode models` call.
  Under load that leftover was up to 20 processes after one probe on OpenCode
  2.0.27.
- Cancelling an OpenCode job sends SIGINT first, so OpenCode aborts the session.
  SIGTERM left the session claimed, and OpenCode's shared service continues a
  claimed session ("continue where you left off") the next time it starts. The
  supervisor sends the SIGINT to the pid it recorded in `cli.pid`. A client that
  is still running 3 seconds later gets one line in `child.log`, and the cancel
  goes on with SIGTERM.

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

[Unreleased]: https://github.com/Elesiann/cc-orq/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/Elesiann/cc-orq/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Elesiann/cc-orq/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Elesiann/cc-orq/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Elesiann/cc-orq/releases/tag/v0.1.0
