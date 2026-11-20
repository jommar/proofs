# Built-in command runtime (`runtime/command.mjs`)

Default local runtime used by `run.mjs` whenever `--worktree` is passed and no `--runtime`, `PROOFS_RUNTIME`, or `.proofs-runtime/runtime.mjs` is selected.

## What `startSandbox` does

For each service declared in `manifest.json` under `runtimeOptions.services` (in declaration order):

1. Streams `git -C <repo> archive --format=tar <sha> | tar -x -C <dir>/src/<app>` (committed `HEAD` only; no intermediate `.tar` file).
2. Symlinks every relative path listed in `service.link` (e.g. `node_modules`) from the checkout into the exported tree.
3. Allocates a free loopback port (`127.0.0.1:<port>`), runs each `service.setup` command sequentially, then spawns `service.start` in its own process group.
4. Polls `service.ready` (default `/`, timeout `readySeconds`, default `120`) until HTTP status `< 500`.

All stdout/stderr goes to `<dir>/service.log` (`0o600`). On any failure (including `--check`) or `--debug` run, `run.mjs` copies non-empty `service.log` to `<run-dir>/diagnostics/service.log` while keeping `report.md` redacted.

## Teardown & rollback contract

- `close()` sends `SIGTERM` to all started service process groups in parallel, waits up to 5 seconds (abortable once all exit), sends `SIGKILL` to any survivors, runs `runtimeOptions.teardown` commands, and flushes `service.log`.
- If startup fails partway, `startSandbox` runs `close()` to roll back. If rollback also fails, it throws an `AggregateError` (preserving `proofSafe` from the startup error) so `run.mjs` retains `.private/run/sandbox` for inspection.

## Writing a custom runtime

Custom runtimes (passed via `--runtime <path>`, `PROOFS_RUNTIME`, or `.proofs-runtime/runtime.mjs`) implement the same ESM contract:

- `export async function startSandbox({ id, dir, workspace, commits, dataset, options, env, signal })` → returns `{ env, close }`.
- `export async function captureDataset({ dir, workspace, options, signal })` *(optional)* → returns a dataset handle passed to `startSandbox`.
- Write process logs to `join(dir, 'service.log')` (`0o600`) so `run.mjs` automatically preserves them under `diagnostics/` on non-pass or `--debug` runs.
- Mark user-safe failure messages with `Object.assign(new Error(msg), { proofSafe: true })` (service/step/exit code only — never secrets, command text, or tenant data).

Verify changes with:

```bash
node --test test/command-runtime.test.mjs
```
