# Proofs

Check a finished change against its acceptance criteria (ACs). A run executes a ticket's checks against **one target**, exactly one of:

- **A local checkout:** `--worktree <dir>` starts the app from that Git checkout (the base or the feature branch) and runs the checks against it. Run it once per branch and compare the two reports.
- **A running environment:** `--url <origin>` runs the checks against a URL you name (local, dev, UAT, or any live site). Nothing is started.

Use [Gherkin + Playwright](bdd/README.md) for what a user sees and [Bruno](api/README.md) for HTTP. No ticket tracker, database or container engine is required.

## Try the example

Linux, Node.js 22+ and Git:

```bash
npm --prefix api ci
npm --prefix bdd ci
npm --prefix bdd exec -- playwright install chromium
node examples/built-in-demo.mjs
```

It builds a tiny inventory app with a base commit and a feature commit as two Git worktrees, then runs the same real browser and API checks against the base (both ACs fail), the feature (both pass) and the feature build served on this machine's network address (`--url`, pass). No Docker, database or login.

## Run a ticket

```bash
node proofs/run.mjs TEAM-42 --worktree ~/work/app-feature --login APP_USER,APP_PASS   # one local checkout
node proofs/run.mjs TEAM-42 --worktree ~/work/app-base    --login APP_USER,APP_PASS   # the base, to compare
node proofs/run.mjs TEAM-42 --url https://dev.example.com --branch feature/x         # a running environment
node proofs/run.mjs TEAM-42 --worktree ~/work/app-feature --plan    # resolve inputs, digest and runtime; starts nothing
node proofs/run.mjs TEAM-42 --worktree ~/work/app-feature --check   # start (or probe) only; run no ACs
node proofs/run.mjs TEAM-42 --worktree ~/work/app-feature --serve   # keep the local sandbox up and print --url iterate command
node proofs/run.mjs TEAM-42 --url http://127.0.0.1:4100 --ac AC1 --debug  # iterate on one AC with private failure diagnostics
```

A run without `--url` or `--worktree` fails with `Give a target`. Add `--workspace <path>` if you are not in the directory the paths are relative to. Read `.proofs-out/TEAM-42/<run-id>/report.md`: one row per AC with a single Result column.

| Result | Meaning |
| --- | --- |
| Pass | The check exercised the claimed behavior and it held. |
| Fail | The check exercised the claimed behavior and contradicted it. |
| Blocked | A fixture, login, response or evidence was missing. This is not a product failure. |

The command exits nonzero for any blocker, uncovered AC or nonpassing result. A pass on the base is a valid result; don't manufacture a regression.

**Is the environment broken, or did the AC fail?** `--check` starts the checkout (or, with `--url`, probes each origin) and prints `ready` or `NOT READY — <cause>` without running any AC. A startup failure in a report names the service, step and exit code, for example `app: setup command 2 failed (exited with code 3)`; command text and output are never shown.

`--only bdd` or `--only api` (repeatable) runs just those adapters; the other ACs report as uncovered. Use it to keep a read-only run away from checks that write.

`--ac AC1,AC3` (repeatable) runs only the listed ACs and marks unselected ACs as skipped (partial run). Combine with `--serve` (which keeps a local `--worktree` sandbox running until `Ctrl-C` and prints the matching `--url` iterate command) to debug checks without restarting services each time.

`--debug` retains private local diagnostics (`0o600` files under `<run-dir>/diagnostics/`: `service.log`, adapter logs, `bdd-failures.json`, and Playwright failure traces/screenshots) even on a passing run. Any failing or blocked run (including a failed `--check`) automatically retains non-empty diagnostics there while keeping `report.md` strictly redacted. Each report and `runs.json` entry records total and per-phase durations (`startup`, adapters, `teardown`).

## Test a local checkout

`--worktree [app=]<dir>` tests one checkout. The directory must be a Git checkout root; its committed `HEAD` is exported and started with the manifest's `runtimeOptions.services` recipe (see [Built-in runtime](#built-in-runtime)). The report lists each checkout's commit and whether it was clean; uncommitted changes are not tested. Leave the app name off when the manifest has one app; otherwise name each one (`--worktree web=<dir> --worktree api=<dir>`).

`--login <userVar>,<passVar>` names the two environment variables that hold the username and password (never the values). It overrides the manifest's `login` and works with both `--worktree` and `--url`.

The runtime is chosen in this order: `--runtime <path>`, `PROOFS_RUNTIME`, `.proofs-runtime/runtime.mjs`, then the built-in runtime. `--plan` prints which one.

## Test a running environment

Pass `--url` and the harness starts nothing and needs no runtime or Docker. It runs the checks against the origins you give and reports one result per AC.

```bash
node proofs/run.mjs TEAM-42 --url https://dev.example.com
node proofs/run.mjs TEAM-42 --url web=https://dev.example.com --url api=https://api.dev.example.com \
  --context tenant=acme --branch feature/x
```

- `--url [name=]<origin>` is repeatable. An origin is `http(s)://host[:port]`, with no path, query or credentials. A bare origin is named `app` and reaches the checks as `PROOF_APP_URL`; `web=...` becomes `PROOF_WEB_URL`. Checks reference these names, so a ticket's checks work against any environment.
- `--context key=value` becomes `PROOF_CONTEXT_<KEY>` (for example a tenant or client slug).
- `--branch <name>` is a label printed in the report for the branch the environment is expected to serve. It is not verified; the harness cannot see what a remote environment deployed.
- **Logins** are never values in a flag or manifest. Either set `PROOF_USERNAME` and `PROOF_PASSWORD` (browser checks), or use `--login` or a top-level `"login": { "usernameEnv": "APP_DEV_USER", "passwordEnv": "APP_DEV_PASS" }` in the manifest to name the variables that hold them. For API folders with `"auth": "runtime"`, set `PROOF_API_HEADERS` (a JSON map from URL name to `authorization` or `cookie` headers).
- The variables come from your environment, then from `<workspace>/.env`. The file is plain `KEY=VALUE` lines (quotes allowed, no expansion) and the real environment wins. Only the variables the harness looks up are used, and values never appear in reports or output.
- TLS is verified. For a private CA set `NODE_EXTRA_CA_CERTS=<absolute path>`. `--insecure-tls` skips certificate checks (for example a local mkcert setup); use it only on environments you control.
- The adapters can reach only the origins you listed. **Checks that create or change data change that environment**, so write checks that are safe for where you point them, and never aim a write check at production.
- The report says no revision was pinned: it describes what the environment served during the run.

## Write a ticket's proofs

```text
proofs/.proofs/TEAM-42/       # inside this repo, gitignored
  manifest.json
  bdd/        # optional: features/ and steps/
  api/        # optional: proof.json and .bru files
  fixtures/   # optional: approved synthetic CSVs
```

A ticket's folder lives in this repo's own `.proofs/` (ignored by Git; reports go to `.proofs-out/` beside it, and a private runtime to `.proofs-runtime/`). A workspace-level `.proofs/TEAM-42/` is also accepted, and the harness checkout's copy wins if both exist. Add `/.proofs/`, `/.proofs-out/` and `/.proofs-runtime/` to any workspace `.gitignore` that holds them. Give each AC a stable ID and write it from the issue or agreed spec, not from the diff or the author's results.

```json
{
  "acs": [{ "id": "AC1", "claim": "The confirmation shows the saved item name." }],
  "login": { "usernameEnv": "APP_USER", "passwordEnv": "APP_PASS" },
  "runtimeOptions": { "services": { "app": { "app": "catalog", "start": "node server.js" } } },
  "csv": ["fixtures/items.csv"]
}
```

- **`acs`:** required. The only other fields are optional.
- **`login`:** the names of the environment variables that hold the login (see above).
- **`runtimeOptions`:** non-secret settings for the runtime, used by `--worktree`. The built-in runtime reads its services from here. Not used with `--url`.
- **`csv`:** regular CSV files inside the ticket directory with distinct names. Staged read-only.
- Never put credentials or customer data in a manifest, check or CSV.

## Built-in runtime

For most projects nothing needs writing: list the services in the manifest and `--worktree` starts each one from the checkout's committed `HEAD` as a local process (`examples/built-in-demo.mjs` runs this end to end):

```json
"runtimeOptions": {
  "services": {
    "app": {
      "app": "catalog",
      "setup": ["npm ci"],
      "start": "node server.js",
      "ready": "/health"
    }
  },
  "passEnv": ["DB_PASSWORD"],
  "context": { "tenant": "demo" },
  "teardown": []
}
```

For each service in order, it:

1. exports the checkout's commit with `git archive` into the run's directory (committed files only);
2. symlinks each `link` path (for example `node_modules`) from the repository checkout;
3. runs the `setup` commands, then `start`, with `PORT` (a free loopback port), `HOST` and your `env` entries;
4. polls `ready` (default `/`, up to `readySeconds`, default 120) until the server answers below HTTP 500.

It returns `PROOF_<SERVICE>_URL` for each service, so name a service `app` to get `PROOF_APP_URL`. On close it stops every process and runs `teardown`.

- `app` names the `--worktree` app whose commit the service runs (default: the service name). Several services can run the same app.
- Placeholders in `setup`, `start`, `env` and `teardown`: `{port}`, `{dir}` (the run's directory), `{src}` (the exported tree), `{id}`, `{slug}` (the id as a safe identifier, unique per run; use it for scratch database names) and `{url:<service>}` (an earlier service's URL).
- Services get only `PATH`, `HOME`, `LANG`, `LC_ALL`, the variables named in `passEnv`, and their own `env`. Secrets stay in your shell; the manifest holds names only.
- `login` (top level or under `runtimeOptions`) hands the browser checks `PROOF_USERNAME` and `PROOF_PASSWORD`, read from your environment, then `<workspace>/.env`.
- `context` becomes `PROOF_CONTEXT_<KEY>`. Command output goes to `service.log` in the run's directory.
- Commands run as you through `sh -c`, so review a manifest as you would a script.

## Write a custom runtime

When a project needs more than commands (a database snapshot, a container stack), supply a trusted local ESM module with `--runtime`, `PROOFS_RUNTIME` or `.proofs-runtime/runtime.mjs`. A manifest never selects code. It exports:

| Hook | Contract |
| --- | --- |
| `captureDataset({ dir, workspace, options, signal })` | Optional. Snapshot an approved synthetic source once per run into `dir`; return the handle `startSandbox` needs. |
| `startSandbox({ id, dir, workspace, commits, dataset, options, env, signal })` | Required, called once per run. Start the `{ repo, sha }` pins in `commits` (keyed by app; it holds only the `--worktree` pins) with writable state in `dir`. `options` is the manifest's `runtimeOptions` and `env` the operator's environment. Return `{ env, close }`; `close()` tears the sandbox down. Roll back on error and honor `signal`. |

`env` must contain at least one `PROOF_<NAME>_URL`: an HTTP(S) **origin** on loopback, with no path, query, credentials or fragment. Optional values:

- `PROOF_CONTEXT_<NAME>`: non-secret context for checks.
- `PROOF_USERNAME` / `PROOF_PASSWORD`: browser login.
- `PROOF_API_HEADERS`: per-origin `authorization` or `cookie` headers for API folders with `"auth": "runtime"`.
- `NODE_EXTRA_CA_CERTS`: a CA file inside the sandbox directory, for private HTTPS. The browser ignores local certificate errors, so it does not verify TLS trust.

**Trust boundary:** the runtime and the authored browser steps run as your OS user. Review them first; this is not a sandbox. The harness restricts the adapters' HTTP destinations and the environment it passes them. Your runtime must keep its listeners and state private and run the pinned code. Never point a proof at production, shared dev or a customer system, and don't reuse ordinary app credentials. If you can't isolate it, block the run.

## How a run works

`--plan` resolves the target, the checkout commits and the proof-input digest without importing the runtime or writing output. A live run freezes the checks, ACs and CSVs, starts the target once (a sandbox for `--worktree`, nothing for `--url`), then runs the BDD and API adapters in turn. They share that run's state, so use separate records or restore what you change. Each adapter has a five-minute limit after startup.

To compare a base and a feature, run the same ticket on each checkout and compare the `Proof inputs digest` in the two reports: it covers checks, ACs and CSVs, **not** runtime code, checkout commits or the dataset, so record those differences separately.

## Directory layout

| Path | Purpose |
| --- | --- |
| `run.mjs` | Main CLI entry point (`--worktree`, `--url`, `--plan`, `--check`, `--serve`, `--only`, `--ac`, `--debug`). |
| `lib/` | Argument parsing (`inputs.mjs`), input snapshot/digest (`snapshot.mjs`), origin validation (`origins.mjs`), evidence/report rendering (`evidence.mjs`), `runs.json` index (`runs.mjs`), self-contained HTML dashboard (`dashboard.mjs`). |
| `runtime/` | Built-in local process runtime (`command.mjs`) — see [`runtime/README.md`](runtime/README.md). |
| `bdd/` | Gherkin + Playwright browser adapter (`run.mjs`, `fixtures.mjs`, `loopback.mjs`, `reporter.mjs`) — see [`bdd/README.md`](bdd/README.md). |
| `api/` | Declarative Bruno HTTP adapter (`run.mjs`) — see [`api/README.md`](api/README.md). |
| `test/` | Harness unit/integration tests (`runner.test.mjs`, `command-runtime.test.mjs`, `dashboard.test.mjs`). |
| `examples/` | Self-contained end-to-end demo (`built-in-demo.mjs`). |
| `dashboard.mjs` | Rebuilds the offline `.proofs-out/dashboard.html` dashboard from `runs.json` and redacted `report.md` files (also auto-updated after each run). |
| `prune.mjs` | Cleans unindexed run folders from `.proofs-out/` (`--yes` to delete). |

## License

[MIT](LICENSE)
