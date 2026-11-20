# Proofs

Check a finished change against its acceptance criteria (ACs). A run executes a ticket's checks against **one target**, exactly one of:

- **A local checkout:** `--worktree <dir>` starts the app from that Git checkout (the base or the feature branch) and runs the checks against it. Run it once per branch and compare the two reports.
- **A running environment:** `--url <origin>` runs the checks against a URL you name (local, dev, UAT, or any live site). Nothing is started.

A tracked [target profile](#target-profiles) (`--target <name>`) names each environment once, so the same ticket runs the same way in separate sessions for local, dev, UAT and live, and `--summary` merges them into one table.

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
node proofs/run.mjs TEAM-42 --target dev --plan                     # a profile supplies urls, context, logins and capabilities
node proofs/run.mjs TEAM-42 --target dev --persona driver           # one persona per run
node proofs/run.mjs TEAM-42 --summary                               # AC x target matrix and a ticket comment from every recorded run
node proofs/run.mjs --help                                          # flags by purpose, examples, and the tickets in .proofs/
```

`--help` (or `-h`) prints the flags grouped by what to run, where, which user and data, and diagnostics, example commands, and then the ticket folders found in `<workspace>/.proofs/` and the harness's own `.proofs/`, each with the `--worktree <app>=<dir>` names its manifest's `runtimeOptions.services` expect (read as JSON; nothing is executed and no environment value is shown). It exits 0; bad arguments print the usage line and exit 1.

One ticket may have several check folders, for example one per app (`TEAM-42` and `TEAM-42-web`). Running `TEAM-42` covers only its own folder, so any run of it (including `--plan`, `--check` and `--summary`) prints `Note: sibling proof folder(s) for the same ticket: TEAM-42-web. Run each ID separately.` The note is informational and does not change the exit code.

A run without `--url` or `--worktree` fails with `Give a target`. Add `--workspace <path>` if you are not in the directory the paths are relative to. Read `.proofs-out/TEAM-42/<run-id>/report.md`: one row per AC with a single Result column.

| Result | Meaning |
| --- | --- |
| Pass | The check exercised the claimed behavior and it held. |
| Fail | The check exercised the claimed behavior and contradicted it. |
| Blocked | A fixture, login, response or evidence was missing. This is not a product failure. |
| Not applicable here | The manifest says this AC cannot run on this target: a capability it lacks, writes it denies, or another persona (see [Capabilities, writes and personas](#capabilities-writes-and-personas)). |

The command exits nonzero for any blocker, uncovered AC or nonpassing result; Skipped and Not applicable here are ignored. A pass on the base is a valid result; don't manufacture a regression.

**Is the environment broken, or did the AC fail?** `--plan` and `--check` both collect every problem they can find in one pass instead of stopping at the first, and list them as `Problem:` and `Warning:` lines (a problem makes the exit code nonzero):

- `--plan` (offline, starts nothing): login variables set, target profile fields still required, source password variable set, the chosen source qualifying for the ticket's fixtures (see [Data sources](#data-sources)), dirty or untracked checkouts (a warning, or a problem with `--require-clean`), `--expect-commit` contained in the checkout, and, for the built-in runtime, `passEnv` variables (warning) and `link` targets (problem).
- `--check` runs the same checks, then the runtime's own `preflight()` hook if it has one (see [Write a custom runtime](#write-a-custom-runtime)), then starts the checkout (or, with `--url`, probes each origin), and prints `ready`, `ready with warnings` or `NOT READY — <causes>`. With problems found before startup, a local sandbox is not started. An origin that answers HTTP 401 or 403 is reported as reachable but unauthenticated: `--check` does not log in, so the login itself is not verified.

A startup failure in a report names the service, step and exit code, for example `app: setup command 2 failed (exited with code 3)`; command text and output are never shown. Local runs do not need the commit pushed: the harness exports the checkout's committed `HEAD`. Problems that make a run meaningless (a required profile field, `--require-clean`, a source password that cannot be resolved, `--expect-commit` on the wrong checkout) also stop a real run before anything starts.

`--only bdd` or `--only api` (repeatable) runs just those adapters; the other ACs report as uncovered. Use it to keep a read-only run away from checks that write.

An adapter folder (`bdd/` or `api/`) that holds no check files is treated as absent: the adapter is not run, `--plan` and `--check` print a `Warning:` naming the folder, and the report's Execution notes say it was skipped. ACs that only it would cover report Uncovered, never Pass.

`--ac AC1,AC3` (repeatable) runs only the listed ACs and marks unselected ACs as skipped (partial run). Combine with `--serve` (which keeps a local `--worktree` sandbox running until `Ctrl-C` and prints the matching `--url` iterate command) to debug checks without restarting services each time.

`--debug` retains private local diagnostics (`0o600` files under `<run-dir>/diagnostics/`: `service.log`, adapter logs, `bdd-failures.json`, and Playwright failure traces/screenshots) even on a passing run. Any failing or blocked run (including a failed `--check`) automatically retains non-empty diagnostics there while keeping `report.md` strictly redacted. Each report and `runs.json` entry records total and per-phase durations (`startup`, adapters, `teardown`).

While a run is in progress, `runs.json` holds a `running` entry for it (start time, settings, current phase, the runner's pid and a heartbeat updated every 15 seconds) and `.proofs-out/dashboard.html` is rebuilt at each phase (`setup`, `startup`, then each adapter, `teardown`), so the page shows the run, its phase and elapsed time and reloads itself every 5 seconds while anything is running. The entry becomes the normal record when the run ends. A running entry whose process is gone or whose heartbeat is over a minute old shows as `interrupted`. Progress is phase-level, not per AC, and a failed progress write is only a warning. `--check` and `--serve` show no progress, and the ledger only ever gets finished runs.

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
- The adapters can reach only the origins you listed. **Checks that create or change data change that environment**, so mark them `"writes": true` (a profile then has to allow writes) and never aim a write check at production.
- The report says no revision was pinned: it describes what the environment served during the run.

## Target profiles

A profile file names each environment once. It lives at `.proofs/targets.json` beside the ticket's `.proofs/<ID>/` (or in the workspace's `.proofs/`), is meant to be tracked in Git, and must never hold a secret: unknown fields are refused, so a stray `password` cannot slip in.

```json
{
  "targets": {
    "local": {
      "login": { "usernameEnv": "APP_USER", "passwordEnv": "APP_PASS" },
      "personas": { "admin": {}, "driver": { "usernameEnv": "APP_DRIVER_USER", "passwordEnv": "APP_DRIVER_PASS" } },
      "defaultPersona": "admin",
      "capabilities": { "db": true, "faultInjection": true },
      "sourceEnv": "APP_SOURCE_URL",
      "sources": { "seed": { "kind": "mysql", "host": "127.0.0.1", "port": 3307, "database": "seed_demo", "user": "root", "passwordEnv": "SEED_DB_PASSWORD" } },
      "defaultSource": "seed"
    },
    "dev": {
      "urls": { "web": "https://dev.example.com", "api": "https://api.dev.example.com" },
      "context": { "tenant": null },
      "login": { "usernameEnv": "APP_DEV_USER", "passwordEnv": "APP_DEV_PASS" },
      "version": { "url": "api", "path": "/version", "field": "commit" }
    }
  }
}
```

- **`urls`** makes it a running-environment profile (used without `--worktree`). A profile without `urls` is a local profile: give `--worktree`, or `--url <loopback origin>` to iterate on a sandbox kept up with `--serve`.
- **Flags override the profile:** each `--url name=...` replaces that url, each `--context key=value` that key, `--login` the persona's login, `--insecure-tls` turns TLS checks off. A value written as `null` is required: `--plan` lists it and a run refuses to start until a flag supplies it (use this for a tenant each user must name).
- **`login`, `personas`, `defaultPersona`:** variable names only. `--persona <name>` (or `PROOF_PERSONA` in the environment) picks one; an empty persona (`{}`) reuses the profile's login. The persona name reaches the checks and the runtime as `PROOF_PERSONA`, and the profile name as `PROOF_TARGET_NAME`.
- **`capabilities`:** names mapped to true or false. Anything not listed is false, except `writes`, which defaults to true for a local profile and false for one with `urls`.
- **`sources`, `defaultSource`, `sourceEnv`:** see [Data sources](#data-sources).
- **`version`:** where the build says what it is: an origin name, a path and optionally a JSON field. How a build exposes its version is app-specific. The detected value is recorded in the report (`Build:`), or `build not detected`; `--expect-commit <sha>` blocks a run when the build does not name that commit (for `--worktree`, when the checkout neither is nor contains it).

The profile name, persona and inputs are recorded in every report and `runs.json` entry. Runs without `--target` behave exactly as before.

## Capabilities, writes and personas

An AC may declare what it needs from a target:

```json
{ "id": "AC6", "claim": "A failed save stores nothing.", "requires": ["db", "faultInjection"], "writes": true, "persona": "admin" }
```

- **`requires`:** capability names the target must have.
- **`writes`:** true when the check creates or changes data. Writes are denied unless the profile allows them (local profiles do by default); a `--url` run without a profile denies them.
- **`persona`:** the persona the AC runs as. An AC without one runs as the default persona. One run uses one persona; run again with `--persona` for the others, and let `--summary` merge them.

An AC that cannot run on the chosen target is not sent to the adapters and reports `Not applicable here — <reason>` (`capability_missing: <names>`, `writes_denied` or `persona_mismatch: <persona>`). Without a profile a local sandbox has every capability. **This guard is declarative:** it skips whole ACs before they run. Steps and setup scripts are trusted code that run as you, so a step that writes without declaring `writes` still writes; declare it honestly, and do not rely on the browser proxy to block writes.

## Data sources

A local run usually copies its dataset from a database. The harness never connects to one; it picks a source and hands its URL to the runtime in the profile's `sourceEnv` variable (default `PROOF_SOURCE_URL`, plus `PROOF_SOURCE_NAME`), where a setup script dumps it into a scratch copy. **A source is only ever read:** the setup that consumes it must dump and load into a scratch database it drops afterwards, and never write to the source.

- **Named sources:** `sources` maps a name to `{ kind, host, port, database, user, passwordEnv | passwordCommand, description }`. `kind` is the URL scheme. The password comes from the variable `passwordEnv` names, or the first line `passwordCommand` prints (trusted operator code from the profile, run with only `PATH` and `HOME`; its output is never shown). Any database on any reachable server is usable by adding an entry; no harness code changes.
- **Choosing:** `--source <name>` picks one; otherwise a URL already set in `sourceEnv` in your shell is used exactly as given (the raw override); otherwise `defaultSource`. An explicit `--source` replaces a raw override for that run, and `--plan` says so.
- **Qualification:** a ticket may declare what its fixtures need in `manifest.sourceRequires`: `{ "probe": "setup/probe.cjs", "checks": [{ "id": "open_order", ... }], "known": { "<source>": { "qualifies": false, "reason": "too_large" } } }`. `--plan` and `--check` then list **every** source of the profile with `qualifies`, `does not qualify` or `unknown`, and flag the chosen one when it does not qualify, so you pick a working source before a run. The probe (trusted, read-only ticket code) gets `PROOF_SOURCE_URL` and `PROOF_SOURCE_CHECKS` (the `checks` JSON) and prints one line per check, `{ "id": "...", "ok": true|false, "reason": "<code>" }`; any other field makes its output invalid, so it cannot leak a row value. Without a probe, or when a source's password cannot be resolved, `known` supplies recorded verdicts. A ticket that declares nothing behaves as before.
- Reports, `runs.json` and the ledger record only the source name and its kind, host, port and database. Never a user, password, connection string or row value.

## Report inputs

Each report has an `## Inputs` section with non-secret inputs only: the target profile and its file, the persona, context values (for example the tenant), the login variable **names** and whether they were set, the source name with its parsed host, port and database, capabilities, the detected build, and the values of variables the manifest lists in `recordEnv` (names whose values are safe to print; a value that contains a credential or URL credential characters is shown as `withheld`). Any known secret (login values, a source URL or password) is removed from the whole report.

## Summarize a ticket across targets

Every complete run is also appended to `.proofs/<ID>/ledger.json`, beside the ticket's inputs. It holds statuses, target, persona, origins, commits, build, source name, digest and the masked command line, never observed text or secrets, and it is never pruned, so you can track it in Git with the checks. `node proofs/run.mjs <ID> --summary` reads it and prints an AC x target matrix plus a ticket comment in Markdown:

- Only complete runs count; `--ac` and `--debug` runs are left out.
- Per target it takes the latest run per persona and, per AC, the latest of those where the AC applied.
- Two local runs on different commits become **Before** and **After** (with a Verdict column) when Git shows one commit is an ancestor of the other.
- Each profile without a complete run gets a `Not verified on <target>.` line, and a different proof inputs digest across runs is flagged.

## Write a ticket's proofs

```text
proofs/.proofs/TEAM-42/       # inside this repo, gitignored
  manifest.json
  bdd/        # optional: features/ and steps/
  api/        # optional: proof.json and .bru files
  fixtures/   # optional: approved synthetic CSVs
```

A ticket's folder lives in this repo's own `.proofs/` (ignored by Git; reports go to `.proofs-out/` beside it, and a private runtime to `.proofs-runtime/`). A workspace-level `.proofs/TEAM-42/` is also accepted, and the harness checkout's copy wins if both exist, so move a ticket (do not copy it) to keep it in a workspace where it can be tracked. Add `/.proofs/`, `/.proofs-out/` and `/.proofs-runtime/` to any workspace `.gitignore` that holds them. Give each AC a stable ID and write it from the issue or agreed spec, not from the diff or the author's results.

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
- **Per AC `requires`, `writes`, `persona`:** see [Capabilities, writes and personas](#capabilities-writes-and-personas).
- **`recordEnv`:** variable names whose values the report may print (see [Report inputs](#report-inputs)).
- **`sourceRequires`:** what the fixtures need from a data source (see [Data sources](#data-sources)).
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
- Placeholders in `setup`, `start`, `env` and `teardown`: `{port}`, `{dir}` (the run's directory), `{src}` (the exported tree), `{id}`, `{slug}` (the id as a safe identifier, unique per run; use it for scratch database names), `{workspace}` (the workspace directory, so a manifest needs no machine-specific absolute paths) and `{url:<service>}` (an earlier service's URL).
- Services get only `PATH`, `HOME`, `LANG`, `LC_ALL`, the variables named in `passEnv`, and their own `env`. Secrets stay in your shell; the manifest holds names only.
- `login` (top level or under `runtimeOptions`) hands the browser checks `PROOF_USERNAME` and `PROOF_PASSWORD`, read from your environment, then `<workspace>/.env`.
- `context` becomes `PROOF_CONTEXT_<KEY>`. Command output goes to `service.log` in the run's directory.
- Commands run as you through `sh -c`, so review a manifest as you would a script.

## Write a custom runtime

When a project needs more than commands (a database snapshot, a container stack), supply a trusted local ESM module with `--runtime`, `PROOFS_RUNTIME` or `.proofs-runtime/runtime.mjs`. A manifest never selects code. It exports:

| Hook | Contract |
| --- | --- |
| `captureDataset({ dir, workspace, options, signal })` | Optional. Snapshot an approved synthetic source once per run into `dir`; return the handle `startSandbox` needs. |
| `preflight({ workspace, commits, options, env, signal })` | Optional. Called by `--check` before anything starts: return `{ problems, warnings }` (arrays of short strings naming what is wrong, never values) for runtime-specific checks such as a database container that is not running. They are printed on the console only. The built-in runtime's own hook also runs at `--plan`. |
| `startSandbox({ id, dir, workspace, commits, dataset, options, env, signal })` | Required, called once per run. Start the `{ repo, sha }` pins in `commits` (keyed by app; it holds only the `--worktree` pins) with writable state in `dir`. `options` is the manifest's `runtimeOptions` and `env` the operator's environment. Return `{ env, close }`; `close()` tears the sandbox down. Roll back on error and honor `signal`. |

`env` must contain at least one `PROOF_<NAME>_URL`: an HTTP(S) **origin** on loopback, with no path, query, credentials or fragment. Optional values:

- `PROOF_CONTEXT_<NAME>`: non-secret context for checks.
- `PROOF_USERNAME` / `PROOF_PASSWORD`: browser login.
- `PROOF_API_HEADERS`: per-origin `authorization` or `cookie` headers for API folders with `"auth": "runtime"`.
- `NODE_EXTRA_CA_CERTS`: a CA file inside the sandbox directory, for private HTTPS. The browser ignores local certificate errors, so it does not verify TLS trust.

**Trust boundary:** the runtime and the authored browser steps run as your OS user. Review them first; this is not a sandbox. The harness restricts the adapters' HTTP destinations and the environment it passes them. Your runtime must keep its listeners and state private and run the pinned code. Never point a proof at production, shared dev or a customer system, and don't reuse ordinary app credentials. If you can't isolate it, block the run.

## How a run works

`--plan` resolves the target, the checkout commits and the proof-input digest without importing the runtime or writing output. A live run freezes the checks, ACs and CSVs, starts the target once (a sandbox for `--worktree`, nothing for `--url`), then runs the BDD and API adapters in turn. They share that run's state, so use separate records or restore what you change. Each adapter has a five-minute limit after startup.

To compare a base and a feature, run the same ticket on each checkout and compare the `Proof inputs digest` in the two **reports**: it covers checks, ACs and CSVs, **not** runtime code, checkout commits or the dataset, so record those differences separately. It hashes only the adapters that run, which the line names (`adapters: bdd, api`), so `--only` changes it: give both runs the same `--only`. `--plan` prints the same value as the report for the same checks and flags; a plan without `--only` and a run with `--only bdd` differ whenever `api/` holds checks.

## Directory layout

| Path | Purpose |
| --- | --- |
| `run.mjs` | Main CLI entry point (`--worktree`, `--url`, `--target`, `--persona`, `--source`, `--plan`, `--check`, `--serve`, `--summary`, `--only`, `--ac`, `--debug`, `--help`). |
| `lib/` | Argument parsing and offline preflight (`inputs.mjs`), target profiles and capabilities (`targets.mjs`), data sources and qualification (`sources.mjs`), input snapshot/digest (`snapshot.mjs`), origin validation (`origins.mjs`), evidence/report rendering (`evidence.mjs`), `runs.json` index (`runs.mjs`), live run progress (`progress.mjs`), durable per-ticket ledger (`ledger.mjs`), `--summary` matrix (`summary.mjs`), `--help` text (`help.mjs`), self-contained HTML dashboard (`dashboard.mjs`). |
| `runtime/` | Built-in local process runtime (`command.mjs`) — see [`runtime/README.md`](runtime/README.md). |
| `bdd/` | Gherkin + Playwright browser adapter (`run.mjs`, `fixtures.mjs`, `loopback.mjs`, `reporter.mjs`) — see [`bdd/README.md`](bdd/README.md). |
| `api/` | Declarative Bruno HTTP adapter (`run.mjs`) — see [`api/README.md`](api/README.md). |
| `test/` | Harness unit/integration tests (`runner.test.mjs`, `targets.test.mjs`, `command-runtime.test.mjs`, `dashboard.test.mjs`, `progress.test.mjs`). |
| `examples/` | Self-contained end-to-end demo (`built-in-demo.mjs`). |
| `dashboard.mjs` | Rebuilds the offline `.proofs-out/dashboard.html` dashboard from `runs.json` and redacted `report.md` files (also auto-updated during and after each run); each run shows the command it was started with, with paths, `--context` values and URL credentials masked. |
| `prune.mjs` | Cleans unindexed run folders from `.proofs-out/` (`--yes` to delete). |

## License

[MIT](LICENSE)
