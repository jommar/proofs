import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const INDEX = 'runs.json';
const LOCK_TRIES = 100;
const LOCK_WAIT_MS = 50;
const LOCK_STALE_MS = 30_000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// A run folder is created before its index entry, so a young unindexed folder may be a run still in progress.
const IN_PROGRESS_GRACE_MS = 24 * 60 * 60 * 1000;
export const RUN_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// What was tested, without values that could be secret: origins, context, checkout commits and the raw flags.
// Credentials never appear in args (--login names environment variables) or in the target's PROOF_*_URL/CONTEXT keys.
function describeTarget({ target, worktrees }) {
  if (!target) return { type: 'worktree', worktrees: worktrees.map(({ app, sha, dirty }) => ({ app, sha, dirty })) };
  const pick = pattern => Object.fromEntries(Object.entries(target.env).filter(([key]) => pattern.test(key)));
  return { type: 'url', urls: pick(/^PROOF_[A-Z0-9_]+_URL$/), context: pick(/^PROOF_CONTEXT_/), branch: target.branch ?? null };
}

// The run's settings, shared by the running entry and the final record.
function describeInput(input, args) {
  return {
    args,
    runtime: input.runtimeLabel ?? null,
    only: input.adapters.map(({ name }) => name),
    ...(input.selectedAcs?.length ? { selectedAcs: input.selectedAcs } : {}),
    ...(input.debug ? { debug: true } : {}),
    ...describeTarget(input),
    ...(input.profile ? { profile: input.profile.name } : {}),
    ...(input.persona ? { persona: input.persona } : {}),
    ...(input.source ? { source: { name: input.source.name, ...input.source.parts } } : {}),
    ...(input.notApplicable?.size ? { notApplicable: Object.fromEntries(input.notApplicable) } : {}),
  };
}

export function describeRun(input, args, id, { startedAt, exitCode, reportPath, durationMs, timings }) {
  return {
    startedAt,
    ...(Number.isFinite(durationMs) ? { durationMs } : {}),
    ...(timings ? { timings } : {}),
    exitCode,
    ...describeInput(input, args),
    report: relative(input.proofsRoot, reportPath),
  };
}

// A run still in progress: its settings plus a coarse phase name, the runner's pid and a heartbeat. The final record
// from describeRun replaces it. An entry whose pid is gone or whose heartbeat is older than PROGRESS_STALE_MS belongs
// to a run that crashed or was killed, and the dashboard shows it as interrupted.
export const PROGRESS_STALE_MS = 60_000;

export function describeProgress(input, args, { startedAt, phase, now = Date.now() }) {
  return { startedAt, state: 'running', phase, pid: process.pid, updatedAt: new Date(now).toISOString(), ...describeInput(input, args) };
}

// Entries older than the retention window are dropped from the index; the run folders and reports stay.
// The index lives in .proofs-out/runs.json as { [ticket]: { [runId]: record } }. Concurrent runs (a base and a
// feature side by side) take a directory lock so neither drops the other's entry.
export async function withLock(dir, fn) {
  const lock = join(dir, '.runs.lock');
  for (let tries = 0; ; tries++) {
    try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
      if (error.code !== 'EEXIST' || tries >= LOCK_TRIES) throw error;
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs >= LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(LOCK_WAIT_MS);
    }
  }
  try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
}

export async function recordRun(outDir, ticket, id, record, now = Date.now()) {
  await withLock(outDir, async () => {
    const cutoff = now - RETENTION_MS;
    const path = join(outDir, INDEX);
    let index = {};
    try { index = JSON.parse(await readFile(path, 'utf8')); } catch { /* first run, or an unreadable index: start fresh */ }
    index[ticket] = { ...index[ticket], [id]: record };
    for (const [name, runs] of Object.entries(index)) {
      const kept = Object.entries(runs).filter(([, { startedAt }]) => Date.parse(startedAt) >= cutoff);
      if (kept.length) index[name] = Object.fromEntries(kept); else delete index[name];
    }
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, path);
  });
}

// Run folders (<ticket>/<uuid>, nothing else) that runs.json does not list and that are old enough not to be in
// progress. Refuses when the index is missing or unreadable, since every folder would then look unlisted.
export async function unindexedRunDirs(outDir, now = Date.now()) {
  const index = JSON.parse(await readFile(join(outDir, INDEX), 'utf8'));
  const orphans = [];
  for (const ticket of await readdir(outDir, { withFileTypes: true })) {
    if (!ticket.isDirectory() || ticket.name.startsWith('.')) continue;
    for (const run of await readdir(join(outDir, ticket.name), { withFileTypes: true })) {
      const path = join(outDir, ticket.name, run.name);
      if (!run.isDirectory() || !RUN_DIR.test(run.name) || Object.hasOwn(index[ticket.name] ?? {}, run.name)) continue;
      if (now - (await stat(path)).mtimeMs >= IN_PROGRESS_GRACE_MS) orphans.push({ ticket: ticket.name, id: run.name, path });
    }
  }
  return orphans;
}
