## orq tools

These tools read and finish orq jobs, the background runs of Codex, OpenCode, Antigravity and Claude CLIs. Every job has a `taskId`, the job id.

- Call `capabilities` before you name a provider instance or a model. It lists each configured instance, its live models, each model's options and allowed values, and its constraints. Do not guess model ids. Its `runtimeMode` and `interactionMode` are the most that orq grants a task while it does not know the permission mode of the session: `approval-required` and `default`.
- `status` takes `{"taskId": "<id>"}` and answers one job's state: `running`, `waiting`, `completed`, `failed`, `cancelled` or `interrupted`. Once the job has ended, it carries the `result` or the `error`. It works for jobs of earlier sessions too. A job that stopped on a question has `BLOCKED on a question` as its result.
- `list` shows the newest jobs first, whoever started them. Pass `{"limit": N}` for more or fewer than 20, up to 50. Use it to find the `taskId` of an older job, then read that job with `status`.
- `cancel` takes `{"taskId": "<id>"}` and an optional `reason`. It stops a running or waiting job, which then reads `cancelled`. A job that has ended answers `task_not_cancellable`.
- `integrate` with `{"taskId": "<id>"}` merges a finished worktree job's branch into the checkout the job was launched from. It merges commits only, so the worker must have committed. When it answers `not_fast_forward`, call it again with `"strategy": "merge"`. When it answers `merge_conflict`, give a rebase of the job's branch to the worker that wrote it, then integrate again. The other refusals say what to fix.
