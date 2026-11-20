# AGENTS.md — Contributing to `proofs`

This file governs **modifying the `proofs` harness itself**. For *running* or *writing* ticket proofs, read [`README.md`](README.md) and [`SKILL.md`](SKILL.md) instead.

## Non-negotiable invariants

1. **Stay strictly project-agnostic.** `proofs` is a standalone public repo. Never add product names, app-specific build commands, NVM paths, Docker assumptions, or workspace-specific paths here. Project-specific runtimes and helpers belong in a consumer's own `.proofs-runtime/` or `.proofs/_shared/`, outside this repo.
2. **Preserve the report redaction boundary.** `report.md` and adapter NDJSON rows may contain only typed facts, static reason codes, and explicitly marked `proofSafe` startup messages — never credentials, raw command text, response bodies, stack traces, or tenant/customer data. Raw logs, `bdd-failures.json`, `api.log`, and `--debug` Playwright artifacts belong **only** under private `0o600` `<run-dir>/diagnostics/`.
3. **Preserve clean-room isolation.** Local `--worktree` runs always export committed `HEAD` only (never mutate checkouts or test uncommitted edits). Adapter inputs are staged read-only and hashed into `Proof inputs digest`.
4. **Keep profiles, the ledger and preflight output secret-free.** Target profiles (`.proofs/targets.json`) hold origins, identifiers and variable names only; `ledger.json` and every `--plan`/`--check`/`--summary` line hold statuses, names and parsed host/port/database only, never a credential, connection string, observed text or row value.
5. **Keep tests self-contained.** Never depend on `.proofs/` or `.proofs-out/` in harness tests; put tests in `test/`, `api/run.test.mjs`, and `bdd/selftest.mjs`.

## Where to read before editing

- CLI, orchestration, diagnostics, `--serve`: `run.mjs`, `lib/`
- Built-in local runtime (`command.mjs`): [`runtime/README.md`](runtime/README.md)
- Browser Gherkin + Playwright adapter: [`bdd/README.md`](bdd/README.md)
- Declarative Bruno HTTP adapter: [`api/README.md`](api/README.md)

## Verify before finishing

Run both commands from the `proofs/` directory (Node.js 22+):

```bash
node --test test/*.test.mjs api/run.test.mjs bdd/selftest.mjs
node examples/built-in-demo.mjs
```
