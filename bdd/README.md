# Browser Playwright proofs

Follow the [proof runbook](../README.md) first. Put browser checks under `.proofs/<ID>/bdd/` in the harness repo (or a workspace-level `.proofs/`). Use this surface when an acceptance criterion (AC) depends on something a person can see or do in the browser. An API response alone does not prove a label, a rendered state, navigation, or a browser interaction.

Keep the manifest, specs, and synthetic CSVs in the harness's [ignored `.proofs/` directory](../README.md#write-a-tickets-proofs), not in a shared repo. Another checkout or machine needs a private handoff of the same inputs, without credentials or customer data.

## Set up the proof tools

From the harness root, install the pinned Playwright dependency and Chromium using Node.js 22 or later. Do not install them in an app checkout:

```bash
npm --prefix bdd ci
npm --prefix bdd exec -- playwright install chromium
```

The runner does not install dependencies during a proof. If you install Chromium to a non-default directory, pass the same absolute `PLAYWRIGHT_BROWSERS_PATH` when installing and running.

## Add Playwright specs

- Place Playwright spec files (`*.spec.mjs`, `*.spec.js`, or `*.spec.ts`) under `.proofs/<ID>/bdd/` (or nested subdirectories).
- For a spec directly inside `bdd/`, import `{ test }` (and optionally `expect`) from `'../fixtures.mjs'` (for one nested directory, `'../../fixtures.mjs'`). The runner resolves that import to the trusted harness fixture in its staged snapshot. Do not copy the fixture into your workspace.
- Tag each test with exactly one distinct manifest AC ID, using `{ tag: '@AC1' }` or an inline `@AC1` token in the test title (static literal so the runner can discover tagged ACs before starting Playwright). After `@AC`, use a positive integer with no leading zero, hyphen, or suffix. Multiple distinct AC IDs, including tags inherited from `test.describe`, block that test's evidence for every attached ID.
- Test functions receive `{ page, proof }` (plus standard Playwright fixtures). `page` is Playwright's browser page.
- Call `proof.check(condition, observations)` to assert the criterion and record the facts. Use 1 to 12 nonsensitive fact keys with boolean or nonnegative integer values, such as `{ nameVisible: false, matchingRows: 0 }`. Do not report record IDs. Use `proof.block('missing_fixture')` if a prerequisite prevents the check. Give a static, short `snake_case` reason, never an exception message or a value from the page. A refused navigation, navigation transport failure, or prerequisite blocker overrides assertions in the same test. An app's own HTTP 502 remains a response you can check; a proxy-generated 502 means the app was unreachable. Normal browser cancellations such as downloads do not by themselves block evidence. A test without an explicit check is blocked.

## Write the check

1. Identify the manifest AC ID, the local role, and the approved starting fixture. Keep setup, the user action, and the observable assertion clear inside the test.
2. Select an origin from the runtime, such as `process.env.PROOF_APP_URL`, and construct an absolute URL, e.g. `new URL('/inventory', process.env.PROOF_APP_URL).href`. There is no implicit default origin. The adapter starts a fresh browser context for each test and permits only the configured run-owned origins. Use `page` for browser interactions. Use `proof.fetch(absoluteUrl, options)` for local setup: it shares that context's cookies, works over both HTTP and HTTPS loopback origins, and never follows redirects. Do not call Node HTTP or `page.request` directly. Use the API adapter for HTTP assertions that do not need a browser.
3. Prefer selectors based on visible labels, roles, and names. Wait for the UI outcome instead of adding a fixed sleep. Check the visible state before and after the action if the difference is what proves the claim.
4. Use the same assertion, route, role, action, and logical fixture on every target, so the same check can run against a base checkout, a feature checkout, and a running environment. Do not assert on source code, browser console text, or a screenshot alone when the AC is about what the user sees.
5. Record the observed visible result for the AC. If a prerequisite failed, record a blocker instead of interpreting the login page, a missing fixture, or a connection error as a product failure.

Example spec (`.proofs/TEAM-42/bdd/confirmation.spec.mjs`) for a fictional AC:

```js
import { test } from '../fixtures.mjs';

test('The confirmation names the saved item', { tag: '@AC1' }, async ({ page, proof }) => {
  await page.goto(new URL('/inventory', process.env.PROOF_APP_URL).href);
  await page.getByLabel('Item name').fill('Example Item');
  await page.getByRole('button', { name: 'Save' }).click();
  const nameVisible = await page.getByRole('dialog').getByText('Example Item', { exact: true }).isVisible();
  proof.check(nameVisible, { nameVisible });
});
```

If the AC itself requires a dialog to open, assert that outcome as product behavior too. Do not treat its absence as a missing fixture.

Trusted specs can read `PROOF_CONTEXT_<NAME>` values for nonsecret context and optional `PROOF_USERNAME`/`PROOF_PASSWORD` for a local identity. Implement the app's sign-in in the spec (or a shared helper); there is no built-in sign-in, and API authentication headers are not available to browser specs. If sign-in is required and the runtime cannot provide the necessary fixture, use `proof.block('missing_auth_fixture')`. Never reuse saved auth state or put credentials in URLs or test titles.

Record evidence with `proof.check` or `proof.block`, not by creating extra captures or result files. `PROOF_RUN_DIR` is the adapter's private scratch directory. Do not put runtime values in observation keys or reason codes.

**Diagnostics, filtering, and timeouts:**
- Passing runs without `--debug` retain no logs, traces, or screenshots.
- On any failure or `--debug` run, the runner retains private `0o600` diagnostics under `<run-dir>/diagnostics/bdd/` (`stdio.log`, `playwright.log`, and structured `bdd-failures.json` with error messages/stacks). Passing `--debug` also retains Playwright traces and failure screenshots under `diagnostics/bdd/playwright/`. `report.md` remains strictly redacted.
- `--ac AC1,AC3` sets `PROOF_ACS` so only matching `@AC` tests run.
- Each test has a 90s timeout and the browser run has a 270s global timeout. If one test times out, already-passing ACs in the same run are preserved instead of being wiped to `bdd_execution_incomplete`.

## Run

Run the proof against one target using the [run commands](../README.md#run-a-ticket). `--only bdd` runs just this adapter; `--ac <id,...>` filters to matching `@AC` tests, and `--debug` (or any failure) retains private failure details under `<run-dir>/diagnostics/bdd/` (`0o600`) without leaking raw values into `report.md`:

```bash
node "$HARNESS/run.mjs" TEAM-42 --worktree "$CHECKOUT" --only bdd      # a local checkout, started by the runtime
node "$HARNESS/run.mjs" TEAM-42 --url https://dev.example.com --only bdd   # a running environment
node "$HARNESS/run.mjs" TEAM-42 --url http://127.0.0.1:4100 --only bdd --ac AC1 --debug
```

To compare a change with its base, run the same ticket once on each checkout and read the two reports. Do not count browser startup failure or missing evidence as a product failure.

Run `node --test bdd/selftest.mjs` from the harness root to verify the adapter against fake loopback services. The test uses `openssl` for a disposable certificate and the installed Chromium browser.
