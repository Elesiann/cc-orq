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
and the MCP tools land in the next releases; see the changelog when it exists.

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
model, effort, duration, token counts and session id. The footer shows `tokens
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

Until the `orq:task` agent brings the permission policy, a manual launch uses
each provider CLI's own defaults for sandbox, permissions and reasoning effort.

## Configuration

orq reads `~/.config/orq/config.json` when it exists. Every field is optional.

```json
{
  "jobsDir": "~/.cache/orq/jobs",
  "waitSeconds": 120,
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
- `waitSeconds`: how long one wait step blocks before the next one, between 10 and 600. Keep it
  under 600, the engine's stall limit for a silent subagent. Default 120.
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
| `meta.json` | `/orq launch` | The job's id, kind, agent id, working directory, start time, runner, model, instance id, driver and, for a Codex instance with a `CODEX_HOME`, that path. Other `env` values are never written to disk. |
| `prompt.txt` | `/orq launch` | The prompt, as given. |
| `scope` | start script | `systemd` when the job runs in a transient user unit, `setsid` when no user manager is reachable. |
| `child.log` | start script | The supervisor's own stdout and stderr. |
| `pgid` | `supervise.sh` | The supervisor's pid. The supervisor leads its process group, so this is also the group id. |
| `events.jsonl` | `supervise.sh` | The CLI's stdout. For the supported runners it is a JSON event stream. |
| `stderr.txt` | `supervise.sh` | The CLI's stderr. |
| `last.txt` | the CLI or `supervise.sh` | The final message. Codex writes it with `-o`. The other runners extract it from the event stream after the run. |
| `cancel` | `/orq cancel` | A request to stop the job. Only its existence counts. |
| `exit` | `supervise.sh`, or `/orq launch` when the supervisor does not start | The exit code, described below. |
| `flags` | nothing in this release | Optional. When present, each non-empty line becomes one extra argument to the CLI. |

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
