import { fileURLToPath, pathToFileURL } from 'node:url';
import { InvalidRunsIndexError, UnsafeOutputDirError, writeDashboard } from './lib/dashboard.mjs';

// Builds a self-contained .proofs-out/dashboard.html from runs.json and redacted report.md files.
// Usage: node proofs/dashboard.mjs [--out <.proofs-out dir>]
const args = process.argv.slice(2);
let out;
if (args.length === 0) {
  out = fileURLToPath(new URL('.proofs-out', import.meta.url));
} else if (args.length === 2 && args[0] === '--out' && args[1] && !args[1].startsWith('-')) {
  out = args[1];
} else {
  console.error('Usage: node proofs/dashboard.mjs [--out <.proofs-out dir>]');
  process.exit(2);
}

try {
  const { path, ticketCount, runCount } = await writeDashboard(out);
  console.log(`Dashboard: ${path} (${ticketCount} ticket(s), ${runCount} run(s))`);
  console.log(`Open: ${pathToFileURL(path).href}`);
} catch (error) {
  if (error instanceof UnsafeOutputDirError) {
    console.error(`Refused unsafe output directory (${out}): it must be a private directory owned by you.`);
  } else if (error?.code === 'ENOENT') {
    console.error(`Cannot read ${out}/runs.json; run a proof first so the index exists.`);
  } else if (error instanceof SyntaxError || error instanceof InvalidRunsIndexError) {
    console.error(`Cannot parse ${out}/runs.json; the index file is corrupted or invalid.`);
  } else {
    console.error(`Cannot write ${out}/dashboard.html.`);
  }
  process.exit(1);
}
