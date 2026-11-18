# Proofs

Check a finished change against its acceptance criteria (ACs), two ways:

- **Local comparison:** run the same checks on a base revision (Before) and the change's worktree branch (After), each started locally. Or, after merge, on the merged branch only.
- **Running environment:** run the checks against a URL you name (local, dev, UAT, or any live site) with `--url`. Nothing is started.

Use [Gherkin + Playwright](bdd/README.md) for what a user sees and [Bruno](api/README.md) for HTTP. No ticket tracker, database or container engine is required.

## Run a ticket

```bash
node proofs/run.mjs TEAM-42 --plan           # resolve pins, input digest and runtime; starts nothing
node proofs/run.mjs TEAM-42                  # local comparison: Before and After
node proofs/run.mjs TEAM-42 --post-merge     # after merge: merged branch only
node proofs/run.mjs TEAM-42 --url https://dev.example.com --branch feature/x   # a running environment
node proofs/run.mjs TEAM-42 --check          # start (or probe) only; run no ACs
```

Run from the workspace root, or add `--workspace <path>`. The runtime is chosen in this order: `--runtime <path>`, `PROOFS_RUNTIME`, the workspace's `.proofs-runtime/runtime.mjs`, then the [built-in runtime](#built-in-runtime). The plan prints which one. Read `.proofs-out/TEAM-42/<run-id>/report.md`: one row per AC with a Before and an After column.

| Result | Meaning |
| --- | --- |
| Pass | The check exercised the claimed behavior and it held. |
| Fail | The check exercised the claimed behavior and contradicted it. |
| Blocked | A fixture, login, response or evidence was missing. This is not a product failure. |

A Before pass is valid; don't manufacture a regression. The command exits nonzero for any blocker or a nonpassing After.

**Is the environment broken, or did the AC fail?** `--check` starts each side (or, with `--url`, probes each origin) and prints `ready` or `NOT READY — <cause>` without running any AC. A startup failure in a run's report names the service, step and exit code, for example `app: setup command 2 failed (exited with code 3)`; command text and output are never shown. `--plan` already fails with a clear message when the built-in runtime is selected but the manifest has no `runtimeOptions.services`.

`--only bdd` or `--only api` (repeatable) runs just those adapters; the other ACs report as uncovered. Use it to keep a read-only run away from checks that write.

## Test a running environment

Pass `--url` and the harness starts nothing, pins nothing and needs no runtime or Docker. It runs the ticket's checks against the origins you give and reports one result per AC.

```bash
node proofs/run.mjs TEAM-42 --url https://dev.example.com
node proofs/run.mjs TEAM-42 --url web=https://dev.example.com --url api=https://api.dev.example.com \
  --context tenant=acme --branch feature/x
```

- `--url [name=]<origin>` is repeatable. An origin is `http(s)://host[:port]`, with no path, query or credentials. A bare origin is named `app` and reaches the checks as `PROOF_APP_URL`; `web=...` becomes `PROOF_WEB_URL`. Checks reference these names, so a ticket's checks work against any environment.
- `--context key=value` becomes `PROOF_CONTEXT_<KEY>` (for example a tenant or client slug).
- `--branch <name>` is a label printed in the report for the branch the environment is expected to serve. It is not verified; the harness cannot see what a remote environment deployed.
- **Logins** are never values in a flag or manifest. Either set `PROOF_USERNAME` and `PROOF_PASSWORD` (browser checks), or add a top-level `"login": { "usernameEnv": "APP_DEV_USER", "passwordEnv": "APP_DEV_PASS" }` to the manifest naming the variables that hold them. For API folders with `"auth": "runtime"`, set `PROOF_API_HEADERS` (a JSON map from URL name to `authorization` or `cookie` headers).
- The variables come from your environment, then from `<workspace>/.env`. The file is plain `KEY=VALUE` lines (quotes allowed, no expansion) and the real environment wins. Only the variables the harness looks up are used, and values never appear in reports or output.
- TLS is verified. For a private CA set `NODE_EXTRA_CA_CERTS=<absolute path>`. `--insecure-tls` skips certificate checks (for example a local mkcert setup); use it only on environments you control.
- The manifest needs only `acs`. `apps` is ignored.
- The adapters can reach only the origins you listed. **Checks that create or change data change that environment**, so write checks that are safe for where you point them, and never aim a write check at production.
- The report has no Before column (`Not run — target verification`) and says no revision was pinned: it describes what the environment served during the run.

## Write a ticket's proofs

```text
.proofs/TEAM-42/
  manifest.json
  bdd/        # optional: features/ and steps/
  api/        # optional: proof.json and .bru files
  fixtures/   # optional: approved synthetic CSVs
```

Add `/.proofs/`, `/.proofs-out/` and `/.proofs-runtime/` to the workspace `.gitignore`. Give each AC a stable ID and write it from the issue or agreed spec, not from the diff or the author's results.

```json
{
  "acs": [{ "id": "AC1", "claim": "The confirmation shows the saved item name." }],
  "apps": {
    "catalog": {
      "repo": "catalog",
      "before": "<baseline commit>",
      "after": "<candidate commit>",
      "mergedRef": "refs/heads/main"
    }
  },
  "csv": ["fixtures/items.csv"]
}
```

- **Apps** (local comparison only; ignored with `--url`): list every repository in the stack, even unchanged ones (pin them to the same commit on both sides). Use full SHAs. Paths are relative to the workspace unless absolute.
- **Worktree (optional):** a clean linked worktree of that repo whose HEAD matches `after`. Never install, switch branches, stash or reset an application checkout for a proof.
- **`mergedRef`:** an exact local `refs/heads/...` branch, used by `--post-merge`. The runner does not fetch or check that a squash or rebase contains the change.
- **`csv`:** optional regular CSV files inside the ticket directory with distinct names. Staged read-only.
- **`runtimeOptions`:** non-secret settings for the runtime. The built-in runtime reads its services from here.
- Never put credentials or customer data in a manifest, check or CSV.

## Built-in runtime

For most projects nothing needs writing: list the services in the manifest and the harness starts each one from its pinned commit as a local process. Example (`examples/built-in-demo.mjs` runs this end to end):

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
  "login": { "usernameEnv": "PROOF_LOGIN_USER", "passwordEnv": "PROOF_LOGIN_PASS" },
  "context": { "tenant": "demo" },
  "teardown": []
}
```

Per side, for each service in order, it:

1. exports the pinned commit with `git archive` into the side's directory (committed files only);
2. symlinks each `link` path (for example `node_modules`) from the repository checkout;
3. runs the `setup` commands, then `start`, with `PORT` (a free loopback port), `HOST` and your `env` entries;
4. polls `ready` (default `/`, up to `readySeconds`, default 120) until the server answers below HTTP 500.

It returns `PROOF_<SERVICE>_URL` for each service, so name a service `app` to get `PROOF_APP_URL`. On close it stops every process and runs `teardown`.

- `app` names the manifest app whose commit the service runs (default: the service name). Several services can run the same app.
- Placeholders in `setup`, `start`, `env` and `teardown`: `{port}`, `{dir}` (the side's directory), `{src}` (the exported tree), `{id}`, `{slug}` (the id as a safe identifier, unique per run and side; use it for scratch database names) and `{url:<service>}` (an earlier service's URL).
- Services get only `PATH`, `HOME`, `LANG`, `LC_ALL`, the variables named in `passEnv`, and their own `env`. Secrets stay in your shell; the manifest holds names only.
- `login` (also valid at the manifest's top level, where it serves both modes) names the environment variables that hold the username and password, and hands them to the browser checks as `PROOF_USERNAME` and `PROOF_PASSWORD`. They are read from your environment, then `<workspace>/.env`.
- `context` becomes `PROOF_CONTEXT_<KEY>`. Command output goes to `service.log` in the side's directory.
- Commands run as you through `sh -c`, so review a manifest as you would a script.

## Write a custom runtime

When a project needs more than commands (a database snapshot, a container stack), supply a trusted local ESM module with `--runtime`, `PROOFS_RUNTIME` or `.proofs-runtime/runtime.mjs`. A manifest never selects code. See `examples/demo-runtime.mjs`. It exports:

| Hook | Contract |
| --- | --- |
| `captureDataset({ dir, workspace, options, signal })` | Optional. Snapshot an approved synthetic source once per run into `dir`; return the handle `startSandbox` needs. |
| `startSandbox({ id, dir, workspace, commits, dataset, options, signal })` | Required. Start the exact `{ repo, sha }` pins in `commits` (keyed by app) with writable state in this side's `dir`. Return `{ env, close }`; `close()` tears down only this side. Roll back on error and honor `signal`. |

`env` must contain at least one `PROOF_<NAME>_URL`: an HTTP(S) **origin** on loopback, with no path, query, credentials or fragment, on a distinct port per side. Optional values:

- `PROOF_CONTEXT_<NAME>`: non-secret context for checks.
- `PROOF_USERNAME` / `PROOF_PASSWORD`: browser login.
- `PROOF_API_HEADERS`: per-origin `authorization` or `cookie` headers for API folders with `"auth": "runtime"`.
- `NODE_EXTRA_CA_CERTS`: a CA file inside the side's directory, for private HTTPS. The browser ignores local certificate errors, so it does not verify TLS trust.

**Trust boundary:** the runtime and the authored browser steps run as your OS user. Review them first; this is not a sandbox. The harness restricts the adapters' HTTP destinations and the environment it passes them. Your runtime must keep its listeners and state private and run the pinned code. Never point a proof at production, shared dev or a customer system, and don't reuse ordinary app credentials. If you can't isolate it, block the run.

## How a run works

`--plan` resolves pins and the proof-input digest without importing the runtime or writing output. A live run freezes the checks, ACs and CSVs, then starts Before and After separately. BDD and API checks on the same side share that side's state, so use separate records or restore what you change. Each adapter has a five-minute limit after startup.

After merge, run `--post-merge` with the original checks. It resolves only each app's `mergedRef` and fills Before with `Not run — post-merge verification`. Compare the `Proof inputs digest` with the pre-merge plan: it covers checks, ACs and CSVs, **not** runtime code, app pins or the dataset, so record those differences separately.

## Try the example

Linux, Node.js 22+ and Git:

```bash
npm --prefix api ci
npm --prefix bdd ci
npm --prefix bdd exec -- playwright install chromium
node examples/built-in-demo.mjs
```

It builds a tiny local app at two commits and runs real browser and API checks both ways: the built-in runtime comparing Before and After, then `--url` against the After build served on this machine's network address. No Docker, database or login. `examples/demo.mjs` is a second demo that adds a custom runtime (`demo-runtime.mjs`), `--plan` digests and post-merge verification.

## License

[MIT](LICENSE)
