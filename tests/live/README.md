# Live harness

`tests/live` starts real, nested Claude Code sessions against this plugin and
checks what a user would see: the plugin's MCP server, its tools, the mod, and
the interactive terminal. It is a local check, not a CI job.

## Requirements

- a logged-in Claude Code CLI on `PATH` (`CLAUDE_BIN` overrides the path)
- `tmux`
- `jq`
- `git`
- Linux with `/proc` (the cleanup reads `/proc/<pid>/cwd`)

Set `CLAUDE_BIN` when `claude` is not on `PATH`. Set
`ORQ_CLAUDE_MD_EXCLUDE_FILES` when your global instruction files live elsewhere
than `$HOME/.claude/CLAUDE.md` and `$HOME/.claude/RTK.md`; the default excludes
those two files from the nested session so the user's own instructions do not
change the answer.

## Run a scenario

```bash
bash tests/live/run.sh smoke
bash tests/live/run.sh smoke-mods
npm run test:live -- smoke
```

The runner prints `PASS SCENARIO` and exits 0, or prints
`FAIL SCENARIO: reason` and exits 1. Each scenario has a 170 s timeout
(`ORQ_LIVE_TIMEOUT` overrides it).

## Receipts

Receipts go to `$ORQ_EVIDENCE_DIR/SCENARIO/`, defaulting to
`.live-evidence/SCENARIO/` in the repository root. That directory is ignored by
git. A run usually leaves:

- `stream.jsonl`, `stderr.txt`, `exit.txt` — the headless session
- `tool_uses.json`, `tool_results.json`, `result.txt` — extracted with `jq`
- `debug.log` — Claude Code's debug log, including the MCP connected line
- `init-tools.txt`, `init-agents.txt` — what the `init` event offered
- `prompt-headless.txt`, `prompt-interactive.txt` — the prompts that were sent
- `pane.txt`, `debug-tmux.log` — the interactive tmux round
- `memory-lines.txt` — what the debug log says about loaded memory files
- `failure.txt` — only when the scenario failed

Keep receipts outside the repository when you attach them to a report:

```bash
ORQ_EVIDENCE_DIR=~/somewhere/live bash tests/live/run.sh smoke
```

## What the scenarios prove

`smoke` runs with the function-hook mods off (`disableAllHooks`) and checks:

- the `init` event lists the five `mcp__plugin_cc-orq_orq__*` tools and no
  `mcp__cc-orq__*` tool
- the model calls `capabilities` and then `list`, and both raw results parse as
  JSON
- the debug log shows `plugin:cc-orq:orq` connected over stdio
- neither excluded `CLAUDE.md` loaded: the debug log has no
  `InstructionsLoaded` dispatch and never names an excluded path
- one interactive tmux round passes the trust dialog, calls `list`, captures
  the pane and leaves with `/exit`

`smoke-mods` runs with the mods on and checks that `init` offers the same five
tools plus `mcp__cc-orq__wait`, that the agent type `cc-orq:task` is available,
and that the plugin's function-hook module loaded.

## Isolation and cleanup

Every scenario gets its own temporary git repository with one commit and its own
tmux session name. The nested CLI always runs with `--setting-sources project`
so the user's own hooks, plugins and MCP servers stay out, and with
`claudeMdExcludes` for the global instruction files. The harness never passes
`--strict-mcp-config`, because that would turn the plugin's server off.

On exit the scenario leaves its tmux session with `/exit`, kills that session if
it is still alive, kills only processes whose working directory is its temporary
repository, and removes the repository. It never touches sessions or processes
that another run started.

## Adding a scenario

Add `tests/live/scenarios/NAME.sh`. Source `tests/live/lib.sh`, call
`live_setup`, write assertions with `live_fail`, and use
`live_run_headless`/`bash tests/live/headless.sh` and the `live_tmux_*` helpers.
`run.sh` supplies `ORQ_EVIDENCE`, reports the failure reason and prints
`PASS NAME` or `FAIL NAME: reason`.
