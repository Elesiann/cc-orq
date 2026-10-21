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

- a `cc-orq:task` that runs with a broader runtime or interaction mode than the
  parent session's permission ceiling allows;
- a `cc-orq:task` whose requested `cwd`, or the git checkout that holds it, lies
  outside the session's directory and its `allowedRoots`, and still runs;
- a secret from an instance's `env`, or from a job's stderr, written to disk or
  shown unredacted by cc-orq;
- a job id or task header that makes cc-orq read or write outside the jobs
  directory or the task's worktree.

`/orq launch` is a command you type yourself. It runs outside the permission
ceiling, with the provider CLI's own defaults, as the README says. A worktree
task runs beside its checkout, in `REPO_NAME-wt/`, by design.

What a provider CLI does inside the mode cc-orq gave it belongs to that CLI's
own project.
