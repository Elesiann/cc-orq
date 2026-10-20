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
worktree, and the `integrate` tool merges that work back. The other MCP tools
land in later releases; see the changelog when it exists.

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
Status is `running`, `cancelling`, `interrupted`, `done`, `failed` or
`cancelled`. An `interrupted` job has no `exit` file and no live supervisor. A
finished job keeps the elapsed time it had when its `exit` file was written.

```
/orq list
```

### `/orq result JOB_ID`

Prints the final message of a finished job, followed by a footer with its kind,
model, effort, duration, token counts, job id (`taskId`) and session id. The footer shows `tokens
n/a` when the CLI's event stream reports no counts. A failed job prints its exit code and
the last 20 stderr lines, with secrets redacted. A job that has not ended gets
one line that says it is running, cancelling or interrupted.

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
- `isolation: worktree | shared` (default `worktree`). `worktree` is accepted
  but does not isolate yet: the job runs in `cwd`, as `shared` does.
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

In this version, worktree isolation is available through `/orq launch
--worktree`; `orq:task` gains it next.

```
/orq launch --worktree codex my-model -- Add the retry to the uploader
```

The launch starts nothing and says why when the directory is not inside a git
checkout (`not_a_repository`), when a job without an exit file already uses the
worktree path (`worktree_busy`), or when git cannot create the worktree
(`git_failed`).

### `mcp__orq__integrate`

Merges a finished task's branch into the checkout the task was launched from.
The input is `taskId`, the job id, and an optional `strategy`:

- `ff-only` (the default) moves the checkout forward without a merge commit.
- `merge` makes a merge commit with `--no-ff --no-edit`, so the history records
  the task.

On success the answer gives the merged commit, the branch and the worktree. The
worktree and the branch stay. Remove them with `git worktree remove` and
`git branch -d` when you no longer need them.

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
| `invalid_input` | The input does not match the schema. |
| `git_failed` | git failed in a way no other code names. The answer carries its message. |

When a merge conflicts, redelegate a rebase of the task branch to the same
worker, then integrate again. orq never forces a merge, and it never resolves a
conflict for you.

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
| `flags` | `orq:task` | Optional. Written by a task launch from the permission ceiling and the effort. Each non-empty line becomes one extra argument to the CLI. |

The `exit` file holds one number:

- `0`: the CLI finished. The job is `done` when `last.txt` holds a non-empty final message and the event extractor reports no error. Otherwise it is `failed`.
- `124`: the job was cancelled.
- `125`: the supervisor did not start, so the job never ran.
- Any other number: the CLI's own exit code. The job is `failed`.

A file that does not hold one whole number, an empty file for example, counts as `failed`. `/orq list` and `/orq result` apply this same rule, so a job shows the same status in both.

A `meta.json` without `runner` takes the runner of its `driver`. A job with neither
skips the event extraction, so it is `done` when its exit is 0 and `last.txt` is not empty.

A job without an `exit` file is `running` while its process group, named in
`pgid`, still exists. When that group is gone, `/orq list` shows the job as
`interrupted` and leaves its elapsed time as `—`.

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
