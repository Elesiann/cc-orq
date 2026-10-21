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

- a task that runs with a broader runtime or interaction mode than the parent
  session's permission ceiling allows;
- a task that runs in a working directory outside the session's directory and
  its `allowedRoots`;
- a secret from an instance's `env`, or from a job's stderr, written to disk or
  shown unredacted by cc-orq;
- a job id or task header that makes cc-orq read or write outside the jobs
  directory or the task's worktree.

What a provider CLI does inside the mode cc-orq gave it belongs to that CLI's
own project.
