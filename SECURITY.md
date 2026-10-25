# Security policy

## Supported versions

Only the latest release receives fixes.

## Reporting a vulnerability

Report it privately through GitHub: open the repository's **Security** tab and
choose **Report a vulnerability**. Do not open a public issue for it.

Include the cc-orq version, the Claude Code version, the provider CLI involved,
and the steps to reproduce. You should get a first answer within seven days.

## What counts

cc-orq runs other coding agents on your machine, so these are in scope:

- a `cc-orq:task`, or a `delegate` or `answer` call, that runs with a broader
  runtime or interaction mode than the parent session's permission ceiling allows;
- a `cc-orq:task`, `delegate` or `answer` whose requested `cwd`, or the git checkout that
  holds it, lies outside the session's directory and its `allowedRoots`, and still
  runs;
- a secret from an instance's `env`, or from a job's stderr, written to disk or
  shown unredacted by cc-orq;
- a job id or task header that makes cc-orq read or write outside the jobs
  directory or the task's worktree, including through `status`, `answer` or
  `integrate`.

`/orq launch` is a command you type yourself. It runs outside the permission
ceiling, with the provider CLI's own defaults, as the README says. A worktree
task runs beside its checkout, in `REPO_NAME-wt/`, by design.

What a provider CLI does inside the mode cc-orq gave it belongs to that CLI's
own project.

## What the ceiling does not cover

The permission ceiling narrows what a task may do. It is not a barrier against a
model that is trying to get around it. It sets the flags that the worker's CLI
receives. It does not limit what the worker does inside those flags.

- In the `auto` and `bypassPermissions` modes, the native prompt does not show
  the level that a request asked for. For sessions in those modes, the
  configuration's `ceiling` and the cc-orq session-mode hook are the real limits.
- An `Elicitation` hook in your settings can answer the form for a task, so the
  form is a question to you and not a barrier against your own hooks.
- A worktree task shares the repository's `.git` directory with your checkout. A
  worker that can write it can change the git config or the hooks that later git
  commands run, `integrate` and your own `git` commands included.
- With `"integrate": {"gitHooks": "run"}`, `integrate` runs the hooks of your
  checkout, including hook files that a worker wrote, on your machine.

The README's [What the ceiling is not](README.md#what-the-ceiling-is-not) section
says the same.
