---
name: proofs
description: "Test a ticket's acceptance criteria (ACs) with this harness: `node proofs/run.mjs <ID>`. Use when asked to test a ticket's ACs, run or write proofs for a ticket, or compare a base and a feature branch against a ticket. One target per run (a local checkout or a running URL); base vs feature is two runs you consolidate."
---

# proofs

Runs a ticket's checks against **one target** and writes one Result per AC. The reference is `README.md`;
this file is the procedure.

`<ID>` is the ticket key (for example `TEAM-42`): take it from the prompt, or from the branch or worktree name;
if it is ambiguous, ask. It names the check folder `.proofs/<ID>/` and the `run.mjs` argument, and must match exactly.
A ticket can have sibling folders such as `.proofs/<ID>-web/` (one per app); a run of `<ID>` prints a
`Note: sibling proof folder(s) ...` line naming them. "Test <ID>" means every one of them: run each ID separately.

## Step 1: gather the ACs from the ticket

Do this first, before any checks or runs. Read the ticket in whatever tracker the team uses (description,
acceptance-criteria field and every comment, because later comments often change an AC), or use criteria the user
pastes. Copy each AC into `.proofs/<ID>/manifest.json` as `{ "id": "AC1", "claim": "<the ticket's wording>" }`,
in the ticket's order. Write ACs from the ticket, not from the diff or the implementation.

- `.proofs/<ID>/` already exists: re-read the ticket and confirm the manifest still matches it.
- The ticket has no testable ACs: do not invent them. Say so and ask the user for the criteria.
- Flag up front any AC that cannot be automated; it will report as Uncovered.

Mark each AC with what it needs from a target, so it is skipped where it cannot run instead of failing or writing
where it must not: `"requires": ["db"]` for checks that read or seed a database directly, `"writes": true` for checks
that create or change data, `"persona": "<name>"` for an AC that runs as another user. If the fixtures need specific
data from the source database, declare it in `sourceRequires` (a read-only probe and/or recorded verdicts per source).

## Step 2: write the checks

In `.proofs/<ID>/` (gitignored): `bdd/` Playwright specs (`*.spec.{mjs,js,ts}`) for what a user sees in a browser, `api/` Bruno
requests for HTTP behavior, `fixtures/` synthetic CSVs. Tag each test with its AC (`{ tag: '@AC1' }`). When a
precondition is missing, block instead of failing: `proof.block('reason')`, where the reason is lowercase letters,
digits and underscores, at most 48 characters, with no credential text (anything else is shown as
`unmet_prerequisite`). For `--worktree` runs, add `runtimeOptions.services` to the manifest (see "Built-in runtime"
in the README). Never put credentials or customer data in a manifest, check or fixture.

## Step 3: run it

From the directory your paths are relative to (or pass `--workspace <path>`). `node proofs/run.mjs --help` lists the
flags, examples, and every ticket folder with the `--worktree <app>=<dir>` names its manifest expects.

1. **Plan:** `node proofs/run.mjs <ID> <target> --plan` starts nothing, fails early on a bad manifest and lists every
   `Problem:` and `Warning:` at once (logins, required profile fields, source qualification, dirty checkouts, links).
   Fix all problems before going on.
2. **Check:** same command with `--check` prints `ready`, `ready with warnings` or `NOT READY — <causes>`, to tell a
   broken environment from a failing AC. `HTTP 401/403` means reachable but not logged in; the login is not verified.
3. **Run:** drop the flag, then read `.proofs-out/<ID>/<run-id>/report.md`. While it runs, `.proofs-out/dashboard.html`
   shows it as `running` with its current phase (`setup`, `startup`, `bdd`, `api`, `teardown`) and elapsed time, and
   reloads itself every few seconds; a run whose process died shows as `interrupted`. On stderr the run prints
   `Run <run-id> started (pid <pid>)` (the pid tells your run from another agent's on the same ticket), a
   `Phase: <name>` line per phase, and at the end one `<AC id> <Result>` line per AC before `Report: <path>`.

Targets and flags:

- `--target <profile>`: an environment named in `.proofs/targets.json` (urls, context, persona logins, capabilities,
  data sources). Prefer it over spelling out `--url`/`--context`/`--login`; flags still override it. One session per
  target (local, dev, UAT, live) runs the same command with a different `--target`. A profile field set to `null`
  (for example the tenant) must be given with a flag; never guess it, ask the user.
- `--persona <name>`: one persona per run. Run once per persona the ACs name; do not merge reports yourself.
- `--source <name>`: pick a named data source for a local run. Read the `Source qualification` lines of `--plan`
  first and choose one that qualifies instead of trying sources one by one.

- `--worktree [app=]<dir>`: test one local checkout (its committed `HEAD`). Run it on the base and again on the feature branch, then compare. An AC that fails on base and passes on the feature is the good result; a pass on the base is valid, so do not manufacture a regression.
- `--url [name=]<origin>`: test a running environment; nothing is started. `--context key=value` passes check inputs (such as a dummy tenant) and `--branch <label>` only labels the report.
- `--login <userVar>,<passVar>`: names the environment variables holding the login, never the values. They are read from the shell, then `<workspace>/.env`. Never print them.
- `--only bdd|api` limits adapters. An empty `bdd/` or `api/` folder is skipped with a `Warning:` (its ACs stay Uncovered), so `--only` is not needed to step around it. `--runtime <file>` uses a custom runtime.
- `--serve` keeps a local `--worktree` sandbox running until `Ctrl-C` and prints the matching `--url` iterate command so you can fix and re-run checks without restarting services.
- `--ac AC1,AC3` runs only the listed ACs and marks unselected ACs as `Skipped — filtered out by --ac` (partial run; never treat as full ticket proof).
- `--debug` retains private `0o600` diagnostics (`<run-dir>/diagnostics/`: `service.log`, `playwright.log`, `bdd-failures.json`, `api.log`, and Playwright failure traces/screenshots) even on a passing run. Any failing or blocked run (including a failed `--check`) automatically retains non-empty diagnostics there while keeping `report.md` strictly redacted.

## Compare a feature branch with its base

There is no Before/After mode: a run tests one target, so a comparison is two runs of the same checks.

1. **Pick the base.** The branch the feature was cut from, as a checkout whose `HEAD` is an ancestor of the feature's (`git merge-base --is-ancestor <base> <feature>`). If the base is a primary checkout you must not disturb, that is fine: only its committed `HEAD` is exported.
2. **Run both with identical inputs:** `node proofs/run.mjs <ID> --worktree <feature-dir> --login ...`, then the same command with `--worktree <base-dir>`. Same ID, same flags, same per-run settings, same check files (the "Proof inputs digest" line in each report must match; it names the adapters it covers, so `--only` changes it and both runs need the same `--only`). Run them one after another.
3. **Confirm what was tested.** Each report lists the commit under "Revisions", and says "clean checkout" or that uncommitted changes were not tested. Commit the feature first if it is dirty.
4. **Consolidate** into one table, one row per AC: `AC | Base | Feature | Verdict`.

| Base | Feature | Verdict |
| --- | --- | --- |
| Fail | Pass | The change delivers the AC. This is the proof. |
| Pass | Pass | Holds, but the check does not distinguish the change (the base already behaved this way). Say so. |
| Fail | Fail | The feature does not meet the AC. |
| Pass | Fail | Regression. |
| Blocked on either side | | Not comparable; fix the environment or fixture and rerun. |

Example (ticket `TEAM-42`, feature in `~/work/app-feature`, base in `~/work/app-base`):

```bash
git -C ~/work/app-feature merge-base --is-ancestor "$(git -C ~/work/app-base rev-parse HEAD)" HEAD && echo base-ok
node proofs/run.mjs TEAM-42 --worktree ~/work/app-feature --login APP_USER,APP_PASS   # report A
node proofs/run.mjs TEAM-42 --worktree ~/work/app-base    --login APP_USER,APP_PASS   # report B
```

Read the Result column of each `.proofs-out/TEAM-42/<run-id>/report.md` and write:

| AC | Base | Feature | Verdict |
| --- | --- | --- | --- |
| AC1 saved name shown | Fail | Pass | Change delivers it |
| AC2 empty name rejected | Pass | Pass | Holds; base already did this |
| AC3 export has the new column | Blocked (login) | Pass | Not comparable; fix the base login, rerun it |
| AC4 audit entry written | Uncovered | Uncovered | No check; write one or flag it |

Example prompts that should work: `Test TEAM-42 on proofs against ~/work/app-feature and ~/work/app-base and consolidate.`
`Test TEAM-42 on proofs against https://dev.example.com with tenant dummy.` `Write proofs for TEAM-42 from its ACs, don't run them yet.`

For an AC that depends on a per-run setting, run both sides for each setting value.
Against a running environment (`--url`) there is no base: test the deployed build, and use `--branch <label>` only to name it in the report.

## Step 4: report

Report each AC as **Pass**, **Fail**, **Blocked** (a fixture, login or response was missing: not a product failure),
**Skipped** (filtered out by `--ac`), **Not applicable here** (the target lacks a capability, denies writes, or the run
used another persona), or **Uncovered** (no check). Across targets, run `node proofs/run.mjs <ID> --summary`: it reads
the ticket's durable `ledger.json` and prints the AC x target matrix (Before/After for base and feature) and a
ticket comment with `Not verified on <target>` lines. Paste that, do not rebuild it by hand. It merges every recorded
run, not just this session's: check the run dates and short ids on each column line (and any `different UTC dates`
line) against the runs you made. State which ACs have no checks; never call a ticket
proven on partial coverage. A report is evidence only for the run that produced it (including its `Duration:` phase
breakdown). For a base-versus-feature comparison, use the table in the previous section.

## Use subagents to go faster

If your agent runtime has subagents, split the independent work and keep the judgment in the main session.

- **Step 1 (read the ticket):** one subagent reads a long ticket, its comments and linked PR text and returns the ACs verbatim plus any comment that changes one. The main session writes `manifest.json` (it is the only writer of that file).
- **Step 2 (write checks):** one subagent per AC or per adapter (`bdd/` vs `api/`), each writing only its own files (`bdd/ac3.spec.mjs`, never a shared one). Give each the AC text, the target and how to read the app's behavior. The main session reviews every check against the AC's claim before any run.
- **Step 3 (run):** the main session runs the proofs. Base and feature runs can go in parallel only when they share nothing (for example two `--url` targets); runs that share a scratch resource such as a database name must stay sequential. Do not hand a full run to a subagent to debug open-endedly.
- **Bound every subagent:** tell it to stop and report after two failed fix attempts or 15 minutes, to report names, counts and paths only (no credentials, no customer data), and not to start long-lived services without stopping them.
- **Verify, don't trust:** read the report yourself; a subagent's "all pass" is a claim, not evidence.

## Gotchas

- Runs that share a scratch resource (for example one database name per ticket) must run one after another.
- A setting that differs per AC (Yes for one, No for another) needs a run for each value.
- The browser adapter's proxy blocks every host except the target origin. An app that loads a third-party script before it mounts stays blank; stub that one request in the check with `page.route(url, route => route.fulfill(...))`. Nothing leaves the machine.
- For a blank page or a Blocked UI step, inspect `<run-dir>/diagnostics/bdd/bdd-failures.json` and `diagnostics/service.log` first, or re-run that AC with `--serve` + `--url ... --ac <ID> --debug` to capture Playwright traces and screenshots before guessing.
- Browser tests get 90 seconds each and 270 seconds overall (`bdd/run.mjs`); a step that waits longer has its page closed. A single timed-out scenario no longer wipes already-passing ACs in the same run.
- Treat worktrees as read-only inputs and do not disturb the user's own running stack.

## Safety

Checks that create or change data must declare `"writes": true`; they then run only where the target profile
allows writes (local profiles do by default). The guard skips whole ACs; steps are trusted code, so an undeclared write
still writes. Use only a dummy tenant the user names; never a real customer's. A data source is only ever read. Keep credentials out of manifests, reports, commits and messages. Stop any sandbox you start, and confirm
no scratch databases or processes remain.
