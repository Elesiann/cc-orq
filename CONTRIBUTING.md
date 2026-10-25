# Contributing

Issues and pull requests are welcome. For a change larger than a fix, open an
issue first so the shape can be agreed before the code.

## Setup

You need Linux, Node 22.18 or newer (users need it too: the MCP server runs its
TypeScript files with no build), `bash`, `python3`, `git`, and the Claude Code
CLI, 2.1.287 or newer, where mods load by default (see the README's
Requirements). macOS is experimental, and only its CI job checks it.

```bash
git clone https://github.com/Elesiann/cc-orq.git
cd cc-orq
npm install
claude --plugin-dir .
```

The first interactive session that loads the plugin from this folder writes
the generated types to `.claude-plugin/types/`. `npm run typecheck` needs them.

## Checks

A pull request passes these before review:

```bash
npm run typecheck              # tsc against the generated types
npm run validate               # claude plugin validate . --strict
npm test                       # pure modules and the MCP server, node --test
node scripts/build-vendor.mjs --check  # the vendor bundle and NOTICE are current
npm run test:plugin            # claude plugin test .
bash tests/runners-shell.sh    # supervisor and runners with fake CLIs
bash tests/integrate-shell.sh  # worktree launch and integrate against real git
bash tests/question-shell.sh   # the child question protocol
bash tests/worktree-include-shell.sh  # .worktreeinclude copies into task worktrees
bash tests/allowlist-shell.sh  # only allowed paths are tracked
bash tests/lock-shell.sh       # the checkout lock with real processes
node tests/conformance/run.mjs # the tasks scenarios of the MCP conformance suite
```

`npm test` also checks the relative links and anchors of every tracked Markdown
file, through `scripts/check-links.mjs`. Run it alone with `npm run check:links`.

CI runs `npm ci`, the vendor check, `npm test`, the six shell suites, and
`shellcheck` on the live harness scripts, and in a job of its own the conformance
suite. It also runs the suites on `macos-latest`, which is experimental. The other
checks need a logged-in Claude Code CLI, so run them locally.

## Conformance suite

`tests/conformance/` holds a test-only HTTP entry: the SDK's `createMcpHandler`
on `node:http`, over the seven fixtures that the tasks scenarios of the
[MCP conformance suite](https://github.com/modelcontextprotocol/conformance)
call (`greet`, `slow_compute`, `failing_job`, `protocol_error_job`,
`confirm_delete`, `multi_input` and `test_tool_with_task`). The tools that create
tasks answer through `server/protocol.ts`, the layer that `delegate` uses, so the
suite tests what that layer puts on the wire. The product serves stdio only.

```bash
node tests/conformance/run.mjs                          # the ten tasks scenarios
node tests/conformance/run.mjs tasks-lifecycle          # one, by name
node tests/conformance/run.mjs --out /tmp/conformance   # keep every checks.json
```

The runner starts the entry in its own process, runs `server --url URL --scenario
NAME` once per scenario, and gates on each exit code. It does not use
`--requirements 2026-07-28`: that run includes the ten tasks scenarios, but lists
them under "Not scored" with the note "These do not affect conformance". A
scenario also fails when it passes no check or skips one, except
`tasks-status-notifications`, which the suite skips itself: its harness still
reads the SSE of `tools/call` where the spec has `subscriptions/listen`. The run
needs the network and no login.

By default the runner fetches the published suite with `npx`. CI runs the commit
that the scenarios were read at instead: set `CONFORMANCE_CMD` to the command that
starts the suite, as words split on spaces, such as a checkout run with `tsx`.
Each scenario's `checks.json` lands under `--out`, and CI uploads that folder as
the `conformance-results` artifact.

## Live harness

`tests/live` runs the plugin in real, nested Claude Code sessions: the MCP
server and the `capabilities` and `list` tools, the mod's extra tool and agent
type, and one interactive tmux round. It needs a logged-in `claude` CLI,
`tmux`, `jq`, `git`, and `timeout` and `find`, and it never runs in CI.

```bash
bash tests/live/run.sh smoke
bash tests/live/run.sh smoke-mods
bash tests/live/check.sh       # the harness's own checks, no login needed
```

The nested session runs without your hooks, your global `CLAUDE.md` and your
claude.ai connectors, and in a mode that asks before a tool call, never in auto
mode. Receipts land in `.live-evidence/SCENARIO/` by default, or under
`ORQ_EVIDENCE_DIR`, and hold the raw output of your machine, so read them
before you attach them anywhere. See `tests/live/README.md` for the details and
for how to add a scenario.

## The MCP server

The plugin's `mcpServers` entry starts `server/main.mjs`, a stdio MCP server that
serves the tools `capabilities`, `delegate`, `answer`, `status`, `list`, `cancel`
and `integrate`. `server/tools.ts` holds their names, input schemas and
descriptions. `server/protocol.ts` reads what the client declared on each request
and serves the MCP tasks, `server/job-tasks.ts` is the task source behind
`delegate`, and `server/node-engine.ts` gives the job core the engine's `$` in
plain Node. The server's tests are in `tests/pure/`, in the files named
`server-*.test.mjs` and `job-tasks.test.mjs`.

The MCP SDK that the server runs on is the committed bundle
`server/vendor/mcp-sdk.mjs`. `npm run build:vendor` rebuilds it, and
`node scripts/build-vendor.mjs --check` in CI fails when the bundle or `NOTICE`
is out of date. Change the SDK only through that script.

## Rules

- No model id is pinned in the code. The parent session names the instance and
  the model in every task, and `capabilities` reports what each CLI offers. The
  only fixed names are the `claude` CLI's aliases `haiku`, `sonnet` and `opus`.
  Tests use fixture model ids.
- A new provider driver must refuse every runtime mode it cannot enforce with a
  CLI flag, so a task never runs broader than its parent.
- The guidance a session gets has two homes, and no hook injects text:
  `server/instructions.md` for the tools (under 4,000 bytes; a test checks it),
  and the description of the `cc-orq:task` agent in `hooks/task.ts` for starting
  a task. Do not repeat one in the other.
- `server/vendor/mcp-sdk.mjs` is generated. After a change of the SDK version in
  `package.json`, or of what `scripts/build-vendor.mjs` re-exports from it, run
  `node scripts/build-vendor.mjs` and commit the result. CI runs it with
  `--check`, which fails when the committed file is not what the build gives, or
  when `NOTICE` misses a bundled package or one of its license texts. The server
  imports the SDK from that file only, and everything under `server/` and the
  `hooks/` modules it imports use erasable TypeScript only, because Node 22.18
  runs the files as they are.
- Only files a user of the plugin needs are tracked. `tests/allowlist-shell.sh`
  holds the list; extend it in the same pull request when a new top-level file
  is needed.
- Update the README in the same pull request when behavior changes, and add an
  entry under `Unreleased` in `CHANGELOG.md`.
- `server/node-engine.ts` implements, in Node, the `CoreEngine` part of `$` that
  the job core uses, for the MCP server and the tests. It keeps the host semantics
  the generated declarations in `.claude-plugin/types/` document. It imports only
  `node:` builtins and `hooks/`, because users never run `npm install`, and it uses
  only erasable TypeScript, which Node 22.18 runs without a build.
