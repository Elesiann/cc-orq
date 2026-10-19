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

Early. This version loads, reads its configuration and logs it. The job
engine, the `orq:task` agent and the tools land in the next releases; see
the changelog when it exists.

## Requirements

- Claude Code with function hooks enabled: add
  `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of
  `~/.claude/settings.json`. Tested on Claude Code 2.1.303.
- Linux or macOS with `bash`, `python3` and `git`.
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
