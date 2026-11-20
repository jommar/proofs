# Changelog

All notable changes to `proofs` are documented in this file.

## 2026-11-21

### Changed
- **Plain Playwright specs in `bdd/`:** Replaced `playwright-bdd`, `@cucumber/gherkin`, and `@cucumber/messages` (36 packages removed) with direct `@playwright/test` execution (`*.spec.{mjs,js,ts}`).
- **`bdd/fixtures.mjs`:** Exports `{ test, expect }` directly from `@playwright/test` (extended with `_localNavigation` and `proof`), removing `createBdd` and `Given`/`When`/`Then`.
- **`bdd/run.mjs`:** Discovers static `@AC<N>` tags directly from Playwright spec files (`{ tag: '@AC1' }` or inline test titles), filters `--ac` runs via Playwright `grep`, and invokes `playwright test` directly without `bddgen`.
- **Examples and docs:** Converted `examples/acme-1/bdd/` to `inventory.spec.mjs` and updated `bdd/README.md`, `README.md`, `SKILL.md`, and self-tests.

### Added
- Dashboard Base/Feature compare view, branch display, and layout improvements (`b0d0d34`).
- Clearer build lookup reporting when a target profile names no `version` endpoint (`af68690`).
- Live stderr progress announcements: run ID, PID, phases, and per-AC results (`f3cb2f5`).
- `--summary` run labeling by date and short ID, with cross-session UTC date gap notes (`e0677c4`).
- `--help` output with grouped flags, examples, and discovered workspace tickets (`5bef6c9`).
- Sibling proof folder notices for multi-app tickets (`b6a420f`).
- Adapter list included in `Proof inputs digest` output (`312c043`).
- Automatic skipping of empty adapter folders with a warning (`5000cb5`).
- Live run progress tracking and auto-refresh in `dashboard.html` (`e80047b`).
- Masked run command display in `dashboard.html` and `ledger.json` (`cbe5bd8`).
- Target profiles (`targets.json`), capability/write/persona filtering, named data sources, qualification probes, build detection, and durable `ledger.json` with `--summary` (`459c4fd`).

## 2026-11-20

### Added
- Self-contained offline HTML dashboard (`dashboard.mjs`), GitHub Actions CI workflow, additional Bruno API operators, and runtime reliability fixes (`98538f5`).
- `--ac`, `--debug`, `--serve`, private `0o600` diagnostics, `runs.json` index, and `prune.mjs` (`8be7b6a`).
