# API proofs

Follow the [proof runbook](../README.md) first. Put API checks under `.proofs/<ID>/api/` in the harness repo (or a workspace-level `.proofs/`). Use this surface when a response, a validation rule, a role-dependent outcome, or a follow-up read can prove the acceptance criterion (AC) without a browser. Use BDD for a claim that depends on the rendered workflow.

Keep the manifest, requests, assertions, and synthetic CSVs in the harness's [ignored `.proofs/` directory](../README.md#write-a-tickets-proofs), not in a shared repo. Another checkout or machine needs a private handoff of the same inputs, without credentials or customer data.

## Set up the proof tools

From the harness root, install the pinned API dependencies using Node.js 22 or later:

```bash
npm --prefix api ci
```

The adapter parses a declarative subset of Bruno `.bru` files. It does not need the Bruno CLI and does not run scripts, plugins, or collection hooks.

## Add a collection

Put `proof.json` in the `api/` directory to map request files to criteria or prerequisites. It is the API adapter's collection map, separate from `manifest.json`:

```text
proofs/.proofs/TEAM-42/
  manifest.json
  api/
    proof.json
    cases/
      inventory.bru
```

The example endpoint and data below are fictitious. Replace them with the actual local route and your independently derived assertions. For this example, put the following in `proof.json`:

```json
{
  "folders": [
    {
      "path": "cases",
      "auth": "none",
      "requests": { "inventory.bru": { "ac": "AC1" } }
    }
  ]
}
```

Then put this in `cases/inventory.bru`:

```bru
meta {
  name: Inventory is readable
  type: http
  seq: 1
}

get {
  url: {{PROOF_CATALOG_URL}}/inventory
  body: none
  auth: none
}

assert {
  res.status: eq 200
  res.body.data.available: eq true
}
```

The adapter runs folders in manifest order. In each folder, mapped requests run by ascending `meta.seq`, which must be a unique positive integer. Each request needs an enabled assertion. Assign one manifest AC ID per request, in the form `AC` followed by a positive integer with no leading zero. You can map multiple requests to the same ID. Each folder needs at least one request mapped to an AC.

Map a setup request with `{ "role": "prerequisite" }` instead of `{ "ac": "AC1" }` when later checks need it. Keep the setup request and its consumers in the same folder. A prerequisite emits no AC result of its own. If its assertions or response captures fail, the subsequent checks in that folder are blocked. Guard a needed fixture this way when its absence is not the behavior itself.

## Write the check

1. Identify the manifest AC ID and the request that demonstrates the claim. Define the expected status and only the fields or side effects that matter. Derive those expectations from the agreed AC, not from the candidate's output.
2. Select the intended origin variable from the trusted runtime and append the endpoint's full route. Use an approved synthetic identity only if the endpoint requires one.
3. Use the same method, initiating role, input, and assertion on every target, so the same check can run against a base checkout, a feature checkout and a running environment. Check a follow-up read when a persistence claim cannot be proved by the write response alone. Keep any mutating requests inside disposable state: a `--worktree` run's sandbox, or an environment where writes are safe.
4. Compare the exact behavior the AC promises. A transport error or an unrelated `401` is blocked if it prevented the assertion. A product rejection can be evidence when the setup is valid and rejection is what the AC tests.
5. Let the adapter report the HTTP status and check outcomes. Never put full responses, authorization headers, cookies, or credentials in observations or labels.

- **Local URLs:** start the URL with a configured `{{PROOF_<NAME>_URL}}`, such as `{{PROOF_CATALOG_URL}}`, followed by a path starting with `/`. `<NAME>` is 1–48 uppercase ASCII letters, digits, or underscores, starting with a letter. The variable is an origin, without an endpoint or path prefix. Use inline queries or `params:query`; substitutions are URL-escaped. The adapter verifies TLS and never follows redirects. A redirect off the selected origin or an unusable transport is blocked.
- **Inputs:** use `headers`, `body: none`, `body: json` with `body:json`, or `body: text` with `body:text`. Quote placeholders in JSON values. `{{PROOF_CONTEXT_<NAME>}}` values supplied by the runtime are nonsecret synthetic context. `{{PROOF_TICKET}}` and a fresh `{{runId}}` are also available. Use `runId` to avoid collisions between synthetic records; do not vary expected behavior by target. Credentials and runtime authentication headers are not interpolation variables.
- **CSV:** add `"csv": { "file": "cases.csv", "case": "synthetic-example" }` to a request map entry. Include that CSV in the shared ticket manifest. The adapter reads the basename under `PROOF_CSV_DIR`. It selects the unique row with the matching `case` column and exposes columns as strings, for example `{{csv.column_name}}`. Missing, malformed, or ambiguous fixtures block the check.
- **Assertions:** check `res.status`, `res.body` and JSON fields (including array indexes), or `res.headers.<name>`. Use `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains` (substring or array membership), `matches` (regex up to 256 chars), or `length` (arrays or text) with a primitive value or substitution, or `isDefined`, `isUndefined`, and `isNull` without a value. No JavaScript runs in assertions.
- **Body guard:** if a request checks or captures the response body, its first enabled assertion must be an exact literal status, such as `res.status: eq 200`. Field checks and captures also require valid `application/json` or `application/*+json` with the expected top-level container: `res.body.field` requires an object, `res.body[0]` an array. A wrong status, HTML page, malformed JSON, or wrong container blocks the field checks and captures instead of proving a field is missing. To explicitly check text, assert on `res.body` itself. If the HTTP status alone is the behavior, write a status-only check.
- **Follow-up requests:** capture a primitive from a successful response with `vars:post-response`, one `name: res.body.data.field`, `name: res.body[0].id`, or non-secret `name: res.headers.<name>` per line (auth/cookie headers such as `set-cookie` and `authorization` are blocked). Use `{{name}}` in later requests in that folder. There are no implicit cookies or file uploads.

## Authenticate locally

For an authenticated check, set `"auth": "runtime"` in the folder map and keep `auth: none` in each `.bru` request. The trusted runtime prepares and verifies any required session before returning `PROOF_API_HEADERS` to the [runner](../README.md#write-a-custom-runtime). This is a JSON-encoded map keyed by the exact origin variable name, such as `{"PROOF_CATALOG_URL":{"authorization":"<private value>"}}`. Each entry can contain lowercase `authorization`, `cookie`, or both. The adapter sends those headers only to requests for that variable in an authenticated folder. Missing headers for that origin block the request. `"auth": "none"` folders receive no runtime headers. Do not declare `Authorization` or `Cookie` headers in `.bru` files or put credentials in any proof input.

An HTTP `401` or `403` normally blocks the check. If the AC tests the rejection itself, map the request as `{ "ac": "AC1", "expectAuthRejection": true }` and start its assertions with exactly `res.status: eq 401` or `res.status: eq 403`. Once setup succeeds, a different status is a failure of that rejection check. Its body checks run only if the expected status matches. The opt-in does not bypass login or other prerequisites.

The adapter reports HTTP status and check counts or ordinals, not raw paths, bodies, or headers. It can also include the static Bruno `meta.name` if it starts with a letter and uses up to 80 ASCII letters, spaces, and hyphens. Use a short description of the check, never a customer name, identifier, or secret. Status comes from the NDJSON evidence, not the adapter's process exit code.

## Run

Run the proof against one target using the [run commands](../README.md#run-a-ticket). `--only api` runs just this adapter; `--ac <id,...>` filters to matching AC requests while automatically keeping folder prerequisites and variable captures, and `--debug` (or any failure) retains private failure details in `<run-dir>/diagnostics/api/api.log` (`0o600`) without leaking raw values into `report.md`:

```bash
node "$HARNESS/run.mjs" TEAM-42 --worktree "$CHECKOUT" --only api      # a local checkout, started by the runtime
node "$HARNESS/run.mjs" TEAM-42 --url https://dev.example.com --only api   # a running environment
node "$HARNESS/run.mjs" TEAM-42 --url http://127.0.0.1:4100 --only api --ac AC1 --debug
```

To compare a change with its base, run the same ticket once on each checkout and read the two reports.

## Adapter verification

- To invoke only the adapter against a fake service, run `node "$HARNESS/api/run.mjs" <absolute-api-input-dir>` with the URL variable(s) it references. Use a private `PROOF_RUN_DIR` for each invocation and set `PROOF_RESULTS` to an absolute NDJSON path inside it.
- In a `--worktree` run the adapter connects directly to the configured loopback address without DNS or proxies. With `--url` it resolves the host normally and reaches only the origins you named. For direct runs that use a private HTTPS certificate, set `NODE_EXTRA_CA_CERTS` to the CA file before starting Node. TLS verification stays enabled.
- Run `npm --prefix api test` from the harness root to verify the adapter against fake loopback services. The HTTPS test uses `openssl` to generate a disposable certificate.
