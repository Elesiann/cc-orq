# orq

orq brings a T3 Code style orchestration surface into Claude Code. The main
session delegates self-contained tasks to external coding agents (Codex,
OpenCode, Claude headless) through one agent type, `orq:task`, and follows,
cancels and integrates their work through MCP tools. Workers run as detached
jobs that survive the session, keep their state on disk, and report back as
text.

orq does not pick models or providers. The parent session names the provider
instance and model in every task.

## Status

Early. This version loads and reads its configuration, runs detached jobs, and
lets you list, show, cancel and launch them with `/orq`. The `orq:task` agent
runs a task as a job for the parent session, under the parent's permission
ceiling; see "Delegating with orq:task". A task can run in its own git
worktree, and the `integrate` tool merges that work back. The `capabilities`,
`status` and `cancel` tools are described under Tools.

## Requirements

- Claude Code with function hooks enabled: add
  `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of
  `~/.claude/settings.json`. Tested on Claude Code 2.1.303.
- Linux only, with `bash`, `python3` and `git`. macOS is not supported yet: the job start script
  needs `systemd-run` or `setsid` to give each job its own session, and macOS has neither by
  default.
- The CLI of each provider you want to delegate to: `codex`, `opencode`,
  `claude`.

## Install

From a local clone:

```bash
claude plugin marketplace add /path/to/orq
claude plugin install orq@orq
```

For one session only, without installing:

```bash
claude --plugin-dir /path/to/orq
```

## Commands

`/orq` takes one subcommand. `list` prints a table, `result` prints a job's
answer, and `cancel` and `launch` print one line.

### `/orq list`

Shows the 50 newest jobs with their `id`, `kind`, `status`, `elapsed` and `cwd`.
Status is `running`, `cancelling`, `waiting`, `interrupted`, `done`, `failed` or
`cancelled`. A `waiting` job has a non-blank `question.txt`, its supervisor is still
running, and it waits for an answer (see [Child questions](#child-questions)). An `interrupted` job has no `exit` file and no
live supervisor. A finished job keeps the elapsed time it had when its `exit` file
was written.

```
/orq list
```

### `/orq result JOB_ID`

Prints the final message of a finished job, followed by a footer with its kind,
model, effort, duration, token counts, job id (`taskId`) and session id. The footer shows `tokens
n/a` when the CLI's event stream reports no counts. A failed job prints its exit code and
the last 20 stderr lines, with secrets redacted. A job that exits 0 after asking a
question gets the question instead (see [Child questions](#child-questions)). A job
that has not ended gets one line that says it is running, cancelling, waiting or
interrupted.

```
/orq result manual-1760000000000-manual-k3j9x2
```

### `/orq cancel JOB_ID`

Asks the job's supervisor to stop it. The supervisor sends SIGTERM to the job's
process group, sends SIGKILL after 5 seconds, and records exit code 124. The
command only writes the request, so the job may show `cancelling` for a few
seconds. A job that has already ended is not touched: the command answers that it
finished and writes nothing. An `interrupted` job has no supervisor to stop, so the
command says so and writes nothing.

```
/orq cancel manual-1760000000000-manual-k3j9x2
```

### `/orq launch INSTANCE MODEL -- PROMPT`

Starts a job for one instance from `instances`, in the session's working
directory. Everything after ` -- ` is the prompt. The command prints
`orq: launched JOB_ID`, or the reason it refused the launch. Replace `my-model`
with a model your provider CLI accepts.

```
/orq launch codex my-model -- Run the test suite and list the failing tests
```

With `--worktree` before the instance, the job runs in its own git worktree.
See [Worktrees and integrate](#worktrees-and-integrate).

Until the `orq:task` agent brings the permission policy, a manual launch uses
each provider CLI's own defaults for sandbox, permissions and reasoning effort.

## Delegating with orq:task

The main session starts a task with one agent type:

```
Agent({ subagent_type: "orq:task", run_in_background: true, prompt: HEADER + TASK })
```

The prompt starts with header lines, in any order, then the task. The first
line that is not a header starts the task text.

```
target: codex my-model effort=high runtime=auto-accept-edits
cwd: /path/to/repo
isolation: worktree
role: review

Review the diff on this branch and list the risks.
```

- `target: INSTANCE MODEL [effort=VALUE] [runtime=MODE] [interaction=MODE]`
  (required). `INSTANCE` is an `id` from `instances`. `MODEL` is passed to the
  CLI as written; orq does not check it against a catalog. `effort` is the
  reasoning effort, one word. `runtime` and `interaction` narrow the session;
  they never widen it. Any other `key=value` is refused.
- `cwd: /absolute/path` (required): an existing directory, inside the session's
  working directory or an `allowedRoots` entry (see "Working directory").
- `isolation: worktree | shared` (default `worktree`). `worktree` runs the task
  in its own git worktree on a new branch; see "Worktrees and integrate". `cwd`
  must then be inside a git checkout, or the task is refused with
  `not_a_repository`. `shared` runs the task in `cwd` as it is.
- `role: implementation | research | review | design | test | general`
  (optional). Any role except `general` prefixes the task with
  `Act as the ROLE sub-agent for this task.`
- A refused header answers the subagent with the refusal text, and nothing runs.
  Every refusal starts with `orq: task refused (taskId none):`, so no job id is
  given for a refused task. A refusal from the ceiling or the driver names its
  code, such as `runtime_mode_unsupported`.

### Permission ceiling

The parent session's permission mode sets the most a task may do. The mode
comes only from the `Agent` call that spawned that task. When that call set no
mode, the ceiling is `approval-required` with interaction `default`, and the
debug log says `orq: ceiling for AGENT_ID: no permission mode captured at spawn`.
The session's last `orq:task` mode and `permissions.defaultMode` in settings never
raise a task's ceiling.

| Parent permission mode | Runtime ceiling | Interaction ceiling |
| --- | --- | --- |
| `plan` | `approval-required` | `plan` |
| `default` | `approval-required` | `default` |
| `acceptEdits` | `auto-accept-edits` | `default` |
| `auto` | `auto` | `default` |
| `dontAsk` | `approval-required` | `default` |
| `bypassPermissions` | `full-access` | `default` |
| none, or any other value | `approval-required` | `default` |

### Working directory

`cwd` is resolved through symlinks (`realpath`), and the resolved path must lie
inside the session's working directory or inside one of the `allowedRoots` in
the configuration. A path outside both is refused with `cwd_out_of_scope`, and
the answer names the roots. A symlink is judged where it points, so a link inside
the session that points elsewhere is refused. A path that does not exist, or is
not a directory, is refused too.

Runtime modes rise in this order: `approval-required`, `auto-accept-edits`,
`auto`, `full-access`. A task that asks for a broader mode than its ceiling is
refused with `runtime_mode_escalation_denied`; `interaction=default` under a
`plan` ceiling is refused with `interaction_mode_escalation_denied`.

Not every driver can enforce every runtime mode with a flag. A mode it cannot
enforce is refused with `runtime_mode_unsupported`, so a task never runs with a
CLI default broader than the ceiling.

| Driver | `approval-required` | `auto-accept-edits` | `auto` | `full-access` | `interaction=plan` |
| --- | --- | --- | --- | --- | --- |
| `codex` | `-s read-only` | `-s workspace-write` | `--approve-for-me` | `-s danger-full-access --dangerously-bypass-approvals-and-sandbox` | refused |
| `opencode` | `--agent plan` | refused | `--auto` | refused | `--agent plan` |
| `antigravity` | `--sandbox` | `--mode accept-edits` | `--mode accept-edits` (narrower) | `--dangerously-skip-permissions` | adds `--mode plan` |
| `claudeAgent` | `--permission-mode manual` | `--permission-mode acceptEdits` | `--permission-mode auto` | `--permission-mode bypassPermissions` | `--permission-mode plan` |

Supported runtime modes per driver: `codex`, `antigravity` and `claudeAgent`
support all four; `opencode` supports `approval-required` and `auto`. The
`claudeAgent` `approval-required` row pins `--permission-mode manual`, so the
`permissions.defaultMode` in the user's settings cannot widen the child. The
`codex` `auto` row sends `--approve-for-me` without `-s`, because the CLI refuses
the pair; its sandbox follows the Codex config.

### Handback

How a finished task is delivered reads the mode in this order: the task's own
spawn, then the session's last `orq:task` spawn, then `permissions.defaultMode`
in settings. This choice only sets the format of the answer. It never changes
the ceiling above.

A task's job runs detached. The subagent waits on it through `mcp__orq__wait`,
one call per `waitSeconds` slice, and each call answers `finished`,
`still running, DURATION` or `supervisor gone`.

When the job ends, the answer goes back to the parent:

- Under `auto` permission mode, through a `SubagentHandback({ message })` call.
  A second step after that answers with text, so the report is handed back once.
- Under any other mode, as the subagent's text.

When the mode cannot be read, the answer is text and the debug log says
`orq: handback skipped for AGENT_ID: no permission mode`.

The answer of a finished job ends with a footer that names the job: `taskId JOB_ID`
is the id to pass to the job tools, and `session` is the provider's session id. orq has no
environment-variable opt-out for the handback, because environment variables do
not reach the mod.

Stopping the subagent with `TaskStop` writes the job's `cancel` file, so the
supervisor stops the job.

## Worktrees and integrate

A task that runs in a worktree works in its own checkout, so it cannot change
the files you are editing. Its worktree is `REPO_PARENT/REPO_NAME-wt/JOB_ID`,
beside the checkout it came from, on a new branch `orq/JOB_ID` cut from that
checkout's HEAD when the job started.

A task whose `cwd` is a subdirectory of its checkout runs in the same
subdirectory of the worktree. For an `orq:task`, the whole checkout must lie
inside the session directory or an `allowedRoots` entry, since the worktree
copies all of it; otherwise the task is refused with `cwd_out_of_scope`. A
`cwd` that is not in the checkout's HEAD, such as an untracked directory, has
no counterpart in the worktree, so the task is refused and the worktree is
removed. orq creates the worktree with the checkout's git hooks and fsmonitor
turned off. `integrate` runs git in your checkout as you would, so the
checkout's own hooks run there.

An `orq:task` runs in a worktree unless its header says `isolation: shared`.
A manual launch asks for one with `--worktree`:

```
/orq launch --worktree codex my-model -- Add the retry to the uploader
```

The launch starts nothing and says why when the directory is not inside a git
checkout (`not_a_repository`), or when git cannot create the worktree
(`git_failed`). A shared launch, a task with `isolation: shared` or a `/orq launch`
without `--worktree`, writes into its directory, so it is refused with
`worktree_busy` while a live job runs there or in a worktree of that checkout.
A worktree launch is never refused for that.

A launch that fails after git created its worktree removes that worktree and
its branch again, on a best-effort basis. When that removal fails, the debug log
records it, and the refusal still names the launch's own failure. Remove the
leftovers by hand with `git worktree remove --force PATH` and
`git branch -D orq/JOB_ID`.

### `mcp__orq__integrate`

Merges a finished task's branch into the checkout the task was launched from.
The input is `taskId`, the job id, and an optional `strategy`:

- `ff-only` (the default) moves the checkout forward without a merge commit.
- `merge` makes a merge commit with `--no-ff --no-edit`, so the history records
  the task.

On success the answer gives the merged commit, the branch and the worktree. The
worktree and the branch stay. Remove them with `git worktree remove` and
`git branch -d` when you no longer need them.

The model reads one JSON string. A merge answers
`{"ok": true, "taskId": "...", "mergedSha": "...", "branch": "...", "worktree": "..."}`.
A refusal answers `{"ok": false, "error": {"code": "...", "message": "..."}}`,
and `error` also carries `files` when the code is `merge_conflict`:

```json
{"ok": false, "error": {"code": "merge_conflict", "message": "orq/JOB_ID conflicts with CHECKOUT in 1 file(s); the merge was aborted", "files": ["a.txt"]}}
```

A refusal names one of these codes:

| Code | Meaning |
| --- | --- |
| `task_not_found` | No job has that id. |
| `no_worktree` | The job ran without a worktree, so it has no branch to merge. |
| `not_a_repository` | The checkout the job was launched from is not a git checkout. |
| `dirty_worktree` | The checkout has uncommitted or untracked files. Commit or stash them, then integrate again. |
| `already_integrated` | The task branch is already in the checkout's HEAD, so there is nothing to merge. |
| `not_fast_forward` | `ff-only` cannot move HEAD, because the checkout has commits the task lacks. Integrate with `merge`, or rebase the task first. |
| `merge_conflict` | The merge stopped on conflicts. orq ran `git merge --abort`, and the answer lists the conflicted files. |
| `invalid_request` | The input does not match the schema. |
| `git_failed` | git failed in a way no other code names. The answer carries its message. |

When a merge conflicts, redelegate a rebase of the task branch to the same
worker, then integrate again. orq never forces a merge, and it never resolves a
conflict for you.

## Tools

Beside `mcp__orq__integrate`, the mod serves three MCP tools for the parent
session, named `mcp__orq__capabilities`, `mcp__orq__status` and
`mcp__orq__cancel`. Each answers with a JSON text. A
refusal has the shape `{"error": {"code": "...", "message": "..."}}`, and the
codes orq answers with are `task_not_found`, `task_not_cancellable` and
`invalid_request`. A task is one job: its `taskId` is the job id that
`/orq list` shows.

The parent session gets the orchestration instructions through the session-start
context: a `SessionStart` hook runs `scripts/session-start.sh`, which prints
`instructions.md` as `additionalContext` on startup, resume, clear and compact.
A test keeps `instructions.md` equal to the `ORCHESTRATION_INSTRUCTIONS` constant
in `hooks/instructions.ts`, so change the constant and the file together.

### `mcp__orq__capabilities`

Takes no input. Answers the provider instances of the configured `instances`
and the permission mode the parent session runs under. Each provider has its
`providerInstanceId`, its `driverKind`, its `models` (each with the `options`
the CLI reports, such as `reasoningEffort` and its allowed values),
`canRunChildTask` and `constraints`, the reasons it cannot run now.

```json
{
  "parentThreadId": null,
  "inheritedProviderInstanceId": null,
  "inheritedModel": null,
  "runtimeMode": "approval-required",
  "interactionMode": "default",
  "providers": [
    {
      "providerInstanceId": "codex",
      "driverKind": "codex",
      "displayName": null,
      "models": [{ "id": "<model-id>", "label": "<label>", "options": [] }],
      "canRunChildTask": true,
      "canRunCrossProviderChildTask": true,
      "constraints": []
    }
  ],
  "features": {
    "appOwnedSubagents": true,
    "asyncPolling": true,
    "cancellation": true,
    "batchThreadCreation": false,
    "threadManagement": false,
    "incrementalThreadRead": false,
    "scheduledTasks": false,
    "maxBatchThreads": 0
  }
}
```

The probe runs `scripts/catalog.py` over the configured instances and is cached
for ten minutes. A probe that fails answers no providers, logs the reason, and
is run again on the next call. The permission mode is the one the session
records, else the `defaultMode` of the settings. `plan` gives `approval-required`
with `plan`; `acceptEdits` gives `auto-accept-edits`; `auto` gives `auto`;
`bypassPermissions` gives `full-access`; `default`, `dontAsk` and any other value
give `approval-required`.

### `mcp__orq__status`

Takes `{"taskId": "<id>"}` and reads that job's directory, so it also answers for
jobs of earlier sessions. An unknown or unsafe id answers `task_not_found`.

```json
{
  "taskId": "manual-1760000000000-manual-k3j9x2",
  "status": "completed",
  "workState": "result_available",
  "kind": "manual",
  "startedAtIso": "2026-10-19T12:00:00.000Z",
  "finishedAtIso": "2026-10-19T12:02:05.000Z",
  "instanceId": "codex",
  "model": "<model-id>",
  "result": "The answer."
}
```

`result` is set for a completed task. `error` is set for a failed task (its exit
code and the redacted stderr tail) and for an interrupted one. `finishedAtIso`
is set once the job has ended. `instanceId` and `model` are set when the job
recorded them.

| `status` | Meaning |
| --- | --- |
| `queued` | Reserved; orq does not produce it yet. |
| `running` | The supervisor is alive. A task with a cancel request stays `running` until the supervisor stops it. |
| `waiting` | The task wrote a question to `question.txt` and its supervisor is still alive. See [Child questions](#child-questions). |
| `completed` | Exit 0, a non-empty final message, and no error in the event stream. A task that exited 0 after writing a question is `completed`, and its `result` is the `BLOCKED on a question (taskId ID): ...` text. |
| `failed` | Any other end: a non-zero exit, an empty final message, or an error in the event stream. |
| `cancelled` | Exit 124, after a cancel request. |
| `interrupted` | The supervisor is gone and the job left no exit file. |

`workState` is `working` while the task runs or waits on its question, and
`result_available` once the task has ended. orq does not produce
`waiting_for_children`, since a task has no children of its own.

### `mcp__orq__cancel`

Takes `{"taskId": "<id>", "reason": "<optional text>"}`. The reason is up to 200
characters; a longer one, or one that is not text, answers `invalid_request` and
nothing is written. orq writes it into the cancel marker as `why="..."`. A running
or waiting task answers `{"taskId": "...", "status": "cancel_requested"}` and gets
the cancel request that the supervisor acts on; it then reads `cancelled`. A task
whose cancel was already requested still reads `running`, or `waiting` when it has
written a question, and a repeated cancel answers
`cancel_requested` again and rewrites the marker with its own reason. A task that
has ended, or is `interrupted`, answers `task_not_cancellable` and nothing is written.

At session start orq logs one debug line for each job in the jobs directory
that has no exit file, with its id, kind and age.

## Task card

While jobs run, orq shows them in a card above the prompt. Each job takes one
line with five fields:

```
codex · my-model · running · msg Reading the test files · 2m15s
```

1. INSTANCE: the job's instance id. A job without one shows its runner, or its kind.
2. MODEL: the model the job was launched with, or `?` when none was recorded.
3. STATUS: the job's status, as `/orq list` shows it.
4. LAST_ACTION: the last event in the job's `events.jsonl` that orq can render. It reads `—` while there is none.
5. DURATION: the time since the job started. For a job that has ended, it is the time up to its `exit` file.

The card looks at the 50 newest jobs, as `/orq list` does. It lists a job while
the job has no `exit` file, so an `interrupted` job stays on the card. A job whose
`exit` file was written less than 60 seconds ago also stays. It leaves the card
once its `exit` file is 60 seconds old.

The card refreshes every 2 seconds. A refresh that is still running makes the
next tick skip.

The card draws nothing when a survey holds the band, when the band gives it no
rows, when the surface is neither the terminal nor the desktop, and when no job
is listed. When the rows do not fit the band, the card draws the newest rows and
a last row, `+N more`, that counts the rest.

`/clear` and a resume keep the card running. Any other end of the session, such
as `/exit`, a logout, or a `-p` run that finishes, stops it.

### Setting `cardDisplay`

`cardDisplay` takes one of three values:

- `band`: the card draws above the prompt. This is the default.
- `status`: the card goes to the status line under the prompt. It shows the newest
  job's line, followed by ` (+N more)` when more jobs are listed.
- `off`: no card is drawn, and no refresh timer runs.

An unknown value counts as `band`. Set it in `/config`, or in `settings.json`
under `pluginConfigs.orq.options.cardDisplay`.

### `/orq-panel`

`/orq-panel [show <id> | cancel <id>]` opens a pane with the 50 newest jobs. Each
job is one row, with its status, elapsed time, kind and model. The pane redraws
every 2 seconds.

- A running or waiting job has a `cancel` button. It asks the supervisor to stop
  the job, as `/orq cancel` does.
- Pressing a job's row selects it. The pane then shows the last 30 rendered lines
  of that job's `events.jsonl`, read from its last 32 KB.
- `show <id>` selects a job and opens the pane. `cancel <id>` cancels a running
  or waiting job without opening the pane.

The pane also has `refresh` and `close` buttons.

## Configuration

orq reads `~/.config/orq/config.json` when it exists. Every field is optional.

```json
{
  "jobsDir": "~/.cache/orq/jobs",
  "waitSeconds": 120,
  "allowedRoots": ["~/work/shared"],
  "instances": [
    { "id": "codex", "driver": "codex" },
    { "id": "opencode", "driver": "opencode" },
    { "id": "claudeAgent", "driver": "claudeAgent" },
    { "id": "codex-work", "driver": "codex", "env": { "CODEX_HOME": "~/.codex-work" } }
  ]
}
```

- `jobsDir`: where each job keeps its files, as an absolute path or one that
  starts with `~/`. Default `~/.cache/orq/jobs`.
- `waitSeconds`: how long one wait step blocks before the next one, between 10 and 240. The
  engine aborts a subagent silent for 600 s, so orq keeps each wait under 240 s. Default 120.
- `allowedRoots`: directories, as absolute paths or paths that start with `~/`,
  where an `orq:task` may run besides the session's own working directory. A
  `cwd` must resolve inside one of them. Default: none. Entries that are not
  absolute are dropped with a warning in the debug log.
- `instances`: the provider instances the parent can target. `id` is the name
  used in a task's `target:` line (letters, digits, `_`, `.`, `-`, up to 64
  characters, unique), `driver` is one of `codex`, `opencode`, `antigravity`,
  `claudeAgent`, and `env` holds variables passed to that instance's process,
  with `UPPER_CASE` keys and string values. A leading `~` in `jobsDir` or in an
  `env` value expands to your home. Defaults: `codex`, `opencode` and
  `claudeAgent`.

A file that is not valid JSON falls back to the defaults. A valid file with an
invalid field keeps the default for that field and drops invalid instances one
by one. Both cases log a warning naming the field in the debug log
(`claude --debug-file`).

## Job directory layout

Each job gets its own directory, `<jobsDir>/<id>`. The job id has the form
`<kind>-<start in ms>-<agent suffix>-<random>`. A manual launch uses `manual`
for both the kind and the agent suffix, for example
`manual-1760000000000-manual-k3j9x2`.

| File | Written by | Contents |
| --- | --- | --- |
| `meta.json` | `/orq launch` | The job's id, kind, agent id, working directory, start time, runner, model, instance id, driver and, for a Codex instance with a `CODEX_HOME`, that path. A worktree job adds the checkout it came from (`repo`), the base commit (`baseSha`), its branch and its worktree path. Other `env` values are never written to disk. |
| `prompt.txt` | `/orq launch` | The prompt, as given. |
| `scope` | start script | `systemd` when the job runs in a transient user unit, `setsid` when no user manager is reachable. |
| `child.log` | start script | The supervisor's own stdout and stderr. |
| `pgid` | `supervise.sh` | The supervisor's pid. The supervisor leads its process group, so this is also the group id. |
| `events.jsonl` | `supervise.sh` | The CLI's stdout. For the supported runners it is a JSON event stream. |
| `stderr.txt` | `supervise.sh` | The CLI's stderr. |
| `last.txt` | the CLI or `supervise.sh` | The final message. Codex writes it with `-o`. The other runners extract it from the event stream after the run. |
| `cancel` | `/orq cancel` | A request to stop the job. Only its existence counts. |
| `exit` | `supervise.sh`, or `/orq launch` when the supervisor does not start | The exit code, described below. |
| `question.txt` | the job, through the shell or the `orq_ask` tool | The question for the parent, written before the job stops. A job with a non-blank file, no `exit`, and a running supervisor is `waiting`. |
| `flags` | `orq:task` | Optional. Written by a task launch from the permission ceiling and the effort. Each non-empty line becomes one extra argument to the CLI. |

The `exit` file holds one number:

- `0`: the CLI finished. The job is `done` when `last.txt` holds a non-empty final message and the event extractor reports no error. Otherwise it is `failed`. A job that left a non-blank `question.txt` is `done` even when `last.txt` is empty.
- `124`: the job was cancelled.
- `125`: the supervisor did not start, so the job never ran.
- Any other number: the CLI's own exit code. The job is `failed`.

A file that does not hold one whole number, an empty file for example, counts as `failed`. `/orq list` and `/orq result` apply this same rule, so a job shows the same status in both.

A `meta.json` without `runner` takes the runner of its `driver`. A job with neither
skips the event extraction, so it is `done` when its exit is 0 and `last.txt` is not empty.

A job without an `exit` file is `waiting` while its process group, named in `pgid`,
still exists and its `question.txt` is non-blank. Otherwise it is `running` while
that group exists. When the group is gone, `/orq list` shows the job as `interrupted`
and leaves its elapsed time as `—`, whether or not it wrote a question.

## Child questions

A job that is blocked on something its brief does not answer asks its parent
instead of guessing. orq sets `ORQ_JOB_DIR` to the job's own directory in every
job's environment. The job writes its question to `$ORQ_JOB_DIR/question.txt`,
prints `BLOCKED:` followed by the question as its final message, and stops.

- While `question.txt` is non-blank, the job has no `exit` file, and its supervisor
  still runs, `/orq list` shows the job as `waiting`, and `/orq result` says it is
  waiting for an answer.
- When the job exits 0 after writing a non-blank question, it is `done`, and `/orq result`
  prints `BLOCKED on a question`, with the question. The parent answers it in a new
  task that carries the original brief plus the answer.
- A job that fails or is cancelled keeps its failed or cancelled answer, even when
  it left a question.

Every `orq:task` and `/orq launch` prompt ends with the protocol paragraph, `QUESTION_PROTOCOL` in
`hooks/question.ts`. A Codex or Claude worker writes its question with its shell
tool:

```bash
printf '%s\n' 'Which database should the migration target?' > "$ORQ_JOB_DIR/question.txt"
```

An OpenCode worker can call the `orq_ask` tool instead. The tool is in
`opencode/tools/orq_ask.ts`. OpenCode loads custom tools from
`~/.config/opencode/tools/`, so link it there once:

```bash
mkdir -p ~/.config/opencode/tools
ln -s /path/to/orq/opencode/tools/orq_ask.ts ~/.config/opencode/tools/orq_ask.ts
```

The tool writes the same file. Without the link, an OpenCode worker still has its
shell tool, and the paragraph works the same way.

Limit: when a job's supervisor dies after it wrote a question, no `exit` file
follows, so the job is `interrupted`. `/orq result` reports the interruption and
does not show the question, although the question stays in `question.txt`.

## Development

Node 22.18 or newer (the tests import TypeScript directly).

```bash
npm install
npm test              # pure modules, node --test
npm run typecheck     # tsc against the types Claude Code generates on load
npm run validate      # claude plugin validate . --strict
npm run test:plugin   # claude plugin test . (needs the Claude Code CLI)
```

Claude Code writes `.claude-plugin/types/` the first time it loads the plugin
from this folder in an interactive session; `npm run typecheck` needs that
folder.

## License

MIT. See `LICENSE` and `NOTICE`.
