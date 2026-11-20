import { readFile, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { maskCommand } from './command.mjs';
import { withLock } from './runs.mjs';

// A small, durable, secret-free record of every run of a ticket, kept beside its inputs at .proofs/<ID>/ledger.json.
// Unlike .proofs-out/runs.json it is never pruned, so `--summary` can merge local, dev, UAT and live runs made in
// separate sessions weeks apart. It holds statuses, names, origins, commits and digests only: no observed text,
// credentials, source passwords or connection strings. `command` is the masked command line (paths, context values and
// URL credentials replaced), so a later session can see how a result was produced.
export const LEDGER = 'ledger.json';
const STATUSES = new Set(['pass', 'fail', 'blocked', 'uncovered', 'skipped', 'na']);

const insideWorkspace = (workspace, path) => {
  const rel = relative(workspace, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : null;
};

export function ledgerEntry(input, id, { startedAt, exitCode, statuses, build, args }) {
  const urls = input.target ? Object.fromEntries(Object.entries(input.target.env).filter(([key]) => /^PROOF_[A-Z0-9_]+_URL$/.test(key))
    .map(([key, origin]) => [key.slice(6, -4).toLowerCase(), origin])) : {};
  return {
    id, startedAt, exitCode,
    command: maskCommand(args),
    target: input.profile?.name ?? null,
    persona: input.persona ?? null,
    mode: input.target ? 'url' : 'worktree',
    ...(input.target ? { urls, branch: input.target.branch ?? null } : {}),
    ...(input.worktrees.length ? {
      worktrees: input.worktrees.map(({ app, sha, dirty, repo }) => ({ app, sha, dirty, ...(insideWorkspace(input.workspace, repo) ? { repo: insideWorkspace(input.workspace, repo) } : {}) })),
    } : {}),
    ...(input.source ? { source: { name: input.source.name, ...input.source.parts } } : {}),
    build: build ?? null,
    digest: input.proofDigest,
    partial: input.selectedAcs.length > 0,
    debug: input.debug === true,
    results: statuses,
  };
}

export async function readLedger(ticketDir) {
  try {
    const parsed = JSON.parse(await readFile(join(ticketDir, LEDGER), 'utf8'));
    if (!Array.isArray(parsed?.runs)) return [];
    return parsed.runs.filter(entry => entry && typeof entry.id === 'string' && entry.results && typeof entry.results === 'object' &&
      Object.values(entry.results).every(status => STATUSES.has(status)));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`.proofs/<ID>/${LEDGER} is not valid JSON; fix or remove it.`);
  }
}

export async function appendLedger(ticketDir, ticket, entry) {
  await withLock(ticketDir, async () => {
    const runs = await readLedger(ticketDir);
    runs.push(entry);
    const path = join(ticketDir, LEDGER);
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ ticket, runs }, null, 2)}\n`, { mode: 0o644 });
    await rename(temp, path);
  });
}
