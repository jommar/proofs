# Proofs

Verify a completed change against observable acceptance criteria (ACs). Before merge, run the same checks against two pinned Git revisions. After merge, repeat those checks against the merged local revision only. Use [Gherkin and Playwright](bdd/README.md) for user-visible behavior and [Bruno](api/README.md) for HTTP behavior. Neither a ticket tracker nor a particular database, container engine, or deployment stack is required by the harness.

## Try the example

On Linux with Node.js 22+ and Git, clone this repository and run from its root:

```bash
npm --prefix api ci
npm --prefix bdd ci
npm --prefix bdd exec -- playwright install chromium
node examples/demo.mjs
```

Install Chromium's operating-system dependencies if Playwright asks. The demo creates two commits of a tiny local HTTP app, runs real browser and API checks, and verifies both report modes. It needs no Docker, database, remote app, or login. You only need to install the test surface your own project uses.

## Set up a project

The harness can live anywhere. In your project's chosen proof workspace, create:

```text
.proofs/TEAM-42/
  manifest.json
  bdd/                  # optional: features/ and steps/
  api/                  # optional: proof.json and .bru files
  fixtures/             # optional: approved synthetic CSVs
```

Add `/.proofs/`, `/.proofs-out/`, and `/.proofs-runtime/` to the workspace Git ignore rules before adding inputs. Put a private runtime in `.proofs-runtime/`, or keep it in a separate access-controlled repository. This repository tracks only shared tooling and the synthetic example. For a different machine, hand off the same proof inputs privately; do not transfer credentials, customer data, or raw run artifacts.

Start from the issue or agreed spec. Give each criterion a stable ID such as `AC1` and describe what you can observe. Do not copy previous reports, infer expectations from a code diff, or reuse the implementation author's result as your own evidence. Example `manifest.json`:

```json
{
  "acs": [{ "id": "AC1", "claim": "The confirmation shows the saved item name." }],
  "apps": {
    "catalog": {
      "repo": "catalog",
      "before": "<approved baseline commit>",
      "after": "<candidate commit>",
      "mergedRef": "refs/heads/main"
    }
  },
  "csv": ["fixtures/items.csv"]
}
```

- List every repository that contributes to the stack being tested; one is enough. Paths are relative to the workspace unless absolute. Pin unchanged dependencies to the same commit on both sides. Prefer full SHAs so a branch moving does not silently change the comparison.
- Optionally give a candidate `worktree` for an app. It must belong to that repo, be clean, and match the candidate pin when one is supplied. Use application checkouts as read-only inputs. Do not install dependencies, switch branches, stash, or reset them for a proof.
- `mergedRef` is an exact local `refs/heads/...` ref for that app. The runner does not fetch or decide whether a squash, rebase, or cherry-pick contains the intended change; check that before running post-merge.
- Omit `csv` if not needed. List regular CSV files inside the proof directory with distinct basenames. Copies are staged read-only. Never put credentials or customer data in a manifest, check, or CSV.
- `runtimeOptions` is an optional JSON object consumed by your runtime module. Use it for non-secret project settings, not for executable instructions or credentials.

## Supply a local runtime

An operator selects a trusted local ESM module explicitly with `--runtime`. A proof manifest does not choose executable code. See the [demo runtime](examples/) for a working example. The module exports:

| Hook | Contract |
| --- | --- |
| `captureDataset({ dir, workspace, options, signal })` | Optional. Snapshot an approved synthetic source **once per invocation** into private `dir`. Treat the source as read-only. Return the dataset handle the start hook needs. |
| `startSandbox({ id, dir, workspace, commits, dataset, options, signal })` | Required. Start the exact `{ repo, sha }` pins in `commits`, keyed by app name, with separate writable state in this side's `dir`. Return `{ env, close }`, where `close()` tears down only this side. Roll back partial startup on error and honor cancellation. |

Return at least one `PROOF_<NAME>_URL`, such as `PROOF_APP_URL` or `PROOF_API_URL`, as an HTTP(S) **origin** on loopback with no path, query, credentials, or fragment. Use a distinct dynamically assigned listener or isolated routing per side and run. The API adapter verifies HTTPS certificates; for a private CA, return `NODE_EXTRA_CA_CERTS` pointing to a regular CA file inside that side's runtime directory. The BDD browser ignores certificate errors for local HTTPS, so its results do not verify TLS trust. Optional `PROOF_CONTEXT_<NAME>` values are nonsecret synthetic context. For local authentication, trusted browser checks can use `PROOF_USERNAME` and `PROOF_PASSWORD`; API folders can opt in to per-origin headers from `PROOF_API_HEADERS` (see the [API guide](api/README.md)).

**Trust boundary:** The runtime and authored browser step code execute as the local OS user. Review them before running them; this is not a security sandbox for untrusted code. The harness limits the adapters' HTTP destinations and filters what it passes to them. Your runtime is responsible for making its listeners, dependencies, and writable state private, for using the actual pinned code, and for preventing application egress when needed. Never point a proof at production, shared dev, or a customer system. Do not reuse ordinary app credentials. If you cannot establish isolation, block the run.

## Run and read the report

Set `HARNESS` to the harness checkout, `WORKSPACE` to the proof workspace, and `RUNTIME` to the trusted module path. For example:

```bash
node "$HARNESS/run.mjs" TEAM-42 --workspace "$WORKSPACE" --runtime "$RUNTIME" --plan
node "$HARNESS/run.mjs" TEAM-42 --workspace "$WORKSPACE" --runtime "$RUNTIME"
```

`--plan` resolves the pins and proof-input digest without importing the runtime, starting services, or writing output. The live run freezes the check files, AC definitions, and CSVs before starting either side. Each side gets its own runtime; BDD and API checks on the **same** side share that side's state, so use separate records or restore what you change. Each surface has a five-minute deadline after startup.

Read `.proofs-out/<ID>/<run-id>/report.md` in the workspace. Its revision header lists the exact full commit IDs. Every AC uses the same three columns:

| AC | Before | After |
| --- | --- | --- |
| AC1 — The confirmation shows the saved item name. | Fail — the confirmation opened without the name. | Pass — the confirmation showed “Example Item.” |

A Fail means the check exercised the claimed behavior and contradicted it. A missing fixture, unusable response, missing login, or absent evidence is **Blocked**, not a product failure. A Before pass is valid; don't manufacture a regression. The command exits nonzero for blockers or a nonpassing After. Keep reports concrete and free of private values.

## Verify after merge

Use a fresh verifier, the original authored checks, and the same harness/runtime version. Add `--post-merge` to the commands above. The runner resolves only each app's `mergedRef`; it does not need the original coding worktrees. Compare the `Proof inputs digest` from `--plan` with the pre-merge handoff. It covers the checks, AC definitions, and CSVs, **not** runtime code, app pins, or the database snapshot. Record differences in runtime or fixture separately. The live run uses a fresh local dataset and fills the Before column with `Not run — post-merge verification`. Only observations measured in this run count as evidence.

## License

[MIT](LICENSE)
