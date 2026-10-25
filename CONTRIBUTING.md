# Contributing

Issues and pull requests are welcome. For a change larger than a fix, open an
issue first so the shape can be agreed before the code.

## Setup

You need Linux, Node 22.18 or newer (users need it too: the MCP server runs its
TypeScript files with no build), `bash`, `python3`, `git`, and the Claude Code
CLI, 2.1.287 or newer, where mods load by default (see the README's
Requirements).

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
```

CI runs `npm ci`, the vendor check, `npm test` and the five shell suites. The
other checks need a logged-in Claude Code CLI, so run them locally.

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
