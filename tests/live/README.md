# Live harness

`tests/live` starts real, nested Claude Code sessions against this plugin and
checks what a user would see: the plugin's MCP server, its tools, the mod, and
the interactive terminal. It is a local check, not a CI job.

## Requirements

- a logged-in Claude Code CLI on `PATH` (`CLAUDE_BIN` overrides the path)
- `tmux`, `jq`, `git`, and `timeout` and `find` from coreutils and findutils
- Linux with `/proc`: cleanup finds processes by their working directory

| Variable | Default | What it does |
|---|---|---|
| `CLAUDE_BIN` | `claude` | the Claude Code executable |
| `PLUGIN_DIR` | the repository root | the plugin the nested session loads |
| `ORQ_LIVE_MODEL` | `haiku` | the model alias of the nested session |
| `ORQ_LIVE_PERMISSION_MODE` | `manual` | the `--permission-mode` of the nested session; `auto` is refused |
| `ORQ_CLAUDE_MD_EXCLUDE_FILES` | `$HOME/.claude/CLAUDE.md` | memory files to keep out of the nested session, one path per line |
| `ORQ_LIVE_SCRATCH_DIR` | `$XDG_RUNTIME_DIR/cc-orq-live`, else `$HOME/.cache/cc-orq-live` | private directory for scratch repositories, run state and tmux sockets |
| `ORQ_LIVE_TMUX_PREFIX` | `orq-live` | prefix of the tmux session names |
| `ORQ_LIVE_TIMEOUT` | `170` | seconds a scenario may run |
| `ORQ_EVIDENCE_DIR` | `.live-evidence` in the repository | where receipts go |

Relative paths in `CLAUDE_BIN`, `PLUGIN_DIR` and `ORQ_EVIDENCE_DIR` are read
from the directory you run in.

## Run a scenario

```bash
bash tests/live/run.sh smoke
bash tests/live/run.sh smoke-mods
npm run test:live -- smoke
```

The runner prints `PASS SCENARIO` and exits 0, or prints
`FAIL SCENARIO: reason` and exits 1.

## Receipts

Receipts go to `$ORQ_EVIDENCE_DIR/SCENARIO/`, or to `.live-evidence/SCENARIO/`
in the repository, which git ignores. `run.sh` marks the directory it creates
with `.cc-orq-live-receipts` and empties only a directory that has the mark or
is empty. A directory with other files in it is refused, so a typo in
`ORQ_EVIDENCE_DIR` cannot delete anything. A run usually leaves:

- `stream.jsonl`, `stderr.txt`, `exit.txt`: the headless session
- `tool_uses.json`, `tool_results.json`, `result.txt`: extracted with `jq`
- `debug.log`: Claude Code's debug log, including the MCP connected line
- `init.json`, `init-tools.txt`, `init-agents.txt`: what the `init` event offered
- `prompt-headless.txt`, `prompt-interactive.txt`: the prompts that were sent
- `pane.txt`, `debug-tmux.log`: the interactive tmux round
- `memory-lines.txt`: what the interactive debug log says about memory files
- `seconds.txt`: the wall time of the scenario
- `failure.txt`: only when the scenario failed

Receipts hold the raw output of your machine: `tool_results.json` carries the
real answer of `list` (task ids and working directories), and the logs carry
paths. Read them before you attach them to anything.

## What the scenarios prove

`smoke` runs with the function-hook mods off (`disableAllHooks`) and checks:

- the `init` event reports the pinned permission mode and lists no `claude.ai`
  server and no `mcp__claude_ai_*` tool
- the `init` event lists the five `mcp__plugin_cc-orq_orq__*` tools with the
  plugin's server connected, and no `mcp__cc-orq__*` tool
- the model calls `capabilities` and then `list`, neither answer is an error,
  and the JSON has the documented shape (`providers` for `capabilities`, `jobs`
  for `list`)
- the debug log shows `plugin:cc-orq:orq` connected over stdio
- one interactive tmux round passes the trust dialog when it shows one (a
  directory trusted before shows none), calls `list`, captures the pane and
  leaves with `/exit`; the pane shows the pinned mode and not auto mode
- the debug log of that interactive session says that no `CLAUDE.md` or rules
  file loaded and never names an excluded path. Claude Code writes that line only in an
  interactive session

`smoke-mods` runs with the mods on and checks the same `init` isolation, that
`init` offers the five tools plus `mcp__cc-orq__wait`, that the agent type
`cc-orq:task` is available, and that the plugin's function-hook module loaded.

## Isolation and cleanup

The nested CLI always runs with:

- `--setting-sources project`, so the user's own hooks, plugins and MCP servers
  stay out. At Claude Code 2.1.310 this alone keeps `~/.claude/CLAUDE.md` out
  too; `claudeMdExcludes` stays as a second guard
- `disableClaudeAiConnectors`, so the account's connectors (mail, databases,
  internal portals) are not in the session
- an explicit `--permission-mode`, `manual` by default (the mode that asks
  before a tool call; `init` reports it as `default`). The tools a prompt needs
  are named in `--allowedTools`

The harness never passes `--strict-mcp-config`, because that would turn the
plugin's server off.

Each scenario runs in its own scratch repository with one commit, built without
your global git configuration. Its path is the same on every run:
`SCRATCH/SCENARIO-N/repo`, where `SCRATCH` is `ORQ_LIVE_SCRATCH_DIR` and `N`
identifies the checkout. Claude Code keeps state for every directory it runs
in, under `~/.claude` and in `~/.claude.json`; a stable path keeps that to one
entry per scenario and checkout instead of one per run. The harness itself never
writes under `~/.claude`. Two runs of one scenario from one checkout cannot
overlap: the second refuses to start.

`SCRATCH` is private to you. The harness creates it with mode 700 and fails
unless you own it, it is not a symlink and it can be restricted to its owner.

The interactive round runs on a tmux server of its own, on a socket inside the
scratch directory of the run, so the harness never talks to your default tmux
server, where your own sessions live. Every tmux call names that socket with
`-S`; a run whose socket path would be too long for a unix socket fails instead
of falling back. The harness closes the one session it created, by exact name, and
the server exits with it. It never stops a whole tmux server.

On exit the scenario leaves its tmux session with `/exit` and closes it if it
is still alive. tmux targets are exact, so a session whose name only starts
with the run's name is never touched. It then stops the processes whose working
directory is the scratch directory, with SIGTERM and then SIGKILL after three
seconds, and removes the directory. It never touches a session or process
that another run started.

A run records its scratch directory and its tmux session in a state file next to
that directory. When a run dies without its trap, as the OOM killer does with
SIGKILL, the next `run.sh` reads the file and cleans up the same way, unless the
process that owns it is still running. A state file is data from disk, so the
harness acts on it only when it is a regular file of yours directly inside the
scratch directory, names the scratch directory its own name stands for, and
names a tmux session that starts with `ORQ_LIVE_TMUX_PREFIX`. It logs why it
ignores any other and leaves it where it is.

## Checking the harness

`bash tests/live/check.sh` runs the harness against a fake `claude` and either a
fake `tmux` or a tmux server on a socket inside the check's own directory, so it
needs no login, no model and no network, and it never touches your default tmux
server. Each check is named after the finding it covers and fails when that
finding is back. `LIVE_UNDER_TEST=DIR` runs the same checks against another copy
of the harness. Run it after you change anything under `tests/live`.

## Adding a scenario

Add `tests/live/scenarios/NAME.sh`. Source `tests/live/lib.sh`, call
`live_setup`, write assertions with `live_fail` or the `live_assert_*`
functions, and use `live_run_headless`/`bash tests/live/headless.sh` and the
`live_tmux_*` helpers. `run.sh` supplies `ORQ_EVIDENCE` and `ORQ_SCENARIO`,
reports the failure reason and prints `PASS NAME` or `FAIL NAME: reason`. Keep
the file executable.
