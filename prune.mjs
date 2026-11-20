import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { unindexedRunDirs } from './lib/runs.mjs';

// Deletes report folders that .proofs-out/runs.json does not list. Lists them and deletes nothing unless --yes is given.
// Usage: node proofs/prune.mjs [--out <.proofs-out dir>] [--yes]
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const out = outFlag >= 0 ? args[outFlag + 1] : fileURLToPath(new URL('.proofs-out', import.meta.url));
if (!out || args.some((arg, i) => !['--out', '--yes'].includes(arg) && args[i - 1] !== '--out')) {
  console.error('Usage: node proofs/prune.mjs [--out <.proofs-out dir>] [--yes]');
  process.exit(2);
}

let orphans;
try {
  orphans = await unindexedRunDirs(out);
} catch {
  console.error(`Cannot read ${out}/runs.json; nothing was changed. Run a proof first so the index exists.`);
  process.exit(1);
}
const apply = args.includes('--yes');
for (const { ticket, id, path } of orphans) {
  if (apply) await rm(path, { recursive: true, force: true });
  console.log(`${apply ? 'deleted' : 'would delete'} ${ticket}/${id}`);
}
console.log(`${orphans.length} unindexed run folder(s) ${apply ? 'deleted' : 'found; pass --yes to delete them'}.`);
