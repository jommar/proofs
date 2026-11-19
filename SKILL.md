---
name: proofs
description: "Test a ticket's acceptance criteria (ACs) with this harness: `node proofs/run.mjs <ID>`. Use when asked to test a ticket's ACs, run or write proofs for a ticket, or compare a base and a feature branch against a ticket. One target per run (a local checkout or a running URL); base vs feature is two runs you consolidate."
---

# proofs

Runs a ticket's checks against **one target** and writes one Result per AC. The reference is `README.md`;
this file is the procedure.

`<ID>` is the ticket key (for example `TEAM-42`): take it from the prompt, or from the branch or worktree name;
if it is ambiguous, ask. It names the check folder `.proofs/<ID>/` and the `run.mjs` argument, and must match exactly.

## Step 1: gather the ACs from the ticket

Do this first, before any checks or runs. Read the ticket in whatever tracker the team uses (description,
acceptance-criteria field and every comment, because later comments often change an AC), or use criteria the user
pastes. Copy each AC into `.proofs/<ID>/manifest.json` as `{ "id": "AC1", "claim": "<the ticket's wording>" }`,
in the ticket's order. Write ACs from the ticket, not from the diff or the implementation.

- `.proofs/<ID>/` already exists: re-read the ticket and confirm the manifest still matches it.
- The ticket has no testable ACs: do not invent them. Say so and ask the user for the criteria.
- Flag up front any AC that cannot be automated; it will report as Uncovered.

## Step 2: write the checks

In `.proofs/<ID>/` (gitignored): `bdd/` Gherkin features and steps for what a user sees in a browser, `api/` Bruno
requests for HTTP behavior, `fixtures/` synthetic CSVs. Tag each scenario with its AC (`@AC1`). When a
precondition is missing, block instead of failing: `proof.block('reason')`, where the reason is lowercase letters,
digits and underscores, at most 48 characters, with no credential text (anything else is shown as
`unmet_prerequisite`). For `--worktree` runs, add `runtimeOptions.services` to the manifest (see "Built-in runtime"
in the README). Never put credentials or customer data in a manifest, check or fixture.

## Step 3: run it

From the directory your paths are relative to (or pass `--workspace <path>`):

1. **Plan:** `node proofs/run.mjs <ID> <target> --plan` starts nothing and fails early on a bad manifest.
2. **Check:** same command with `--check` prints `ready` or `NOT READY — <cause>`, to tell a broken environment from a failing AC.
3. **Run:** drop the flag, then read `.proofs-out/<ID>/<run-id>/report.md`.

Targets and flags:

- `--worktree [app=]<dir>`: test one local checkout (its committed `HEAD`). Run it on the base and again on the feature branch, then compare. An AC that fails on base and passes on the feature is the good result; a pass on the base is valid, so do not manufacture a regression.
- `--url [name=]<origin>`: test a running environment; nothing is started. `--context key=value` passes check inputs (such as a dummy tenant) and `--branch <label>` only labels the report.
- `--login <userVar>,<passVar>`: names the environment variables holding the login, never the values. They are read from the shell, then `<workspace>/.env`. Never print them.
- `--only bdd|api` limits adapters. `--runtime <file>` uses a custom runtime.

## Step 4: report

Report each AC as **Pass**, **Fail**, **Blocked** (a fixture, login or response was missing: not a product failure) or
**Uncovered** (no check). State which ACs have no checks; never call a ticket proven on partial coverage. A report
is evidence only for the run that produced it. For a base-versus-feature comparison, put both results side by side.

## Gotchas

- Runs that share a scratch resource (for example one database name per ticket) must run one after another.
- A setting that differs per AC (Yes for one, No for another) needs a run for each value.
- The browser adapter's proxy blocks every host except the target origin. An app that loads a third-party script before it mounts stays blank; stub that one request in the check with `page.route(url, route => route.fulfill(...))`. Nothing leaves the machine.
- For a blank page or a Blocked UI step, put the failing stage in the block reason (counts only, no page text) and reproduce it in a standalone Playwright script before guessing.
- Browser tests get 90 seconds each and 240 seconds overall (`bdd/run.mjs`); a step that waits longer has its page closed.
- Treat worktrees as read-only inputs and do not disturb the user's own running stack.

## Safety

Checks may create and change data on any target, but only on a dummy tenant the user names; never use a real
customer's. Keep credentials out of manifests, reports, commits and messages. Stop any sandbox you start, and confirm
no scratch databases or processes remain.
