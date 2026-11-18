import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const privateNames = /^(?:\.(?:env(?:\..*)?|git|private|features-gen|auth|proofs-out|npmrc|netrc|ssh|aws)|node_modules|test-results|playwright-report|blob-report|(?:auth|storage[-_]?state|trace)\.json)$/i;
const artifactExtensions = /\.(?:ndjson|log|har|zip|png|jpe?g|webm|pem|key|p12|pfx|sql)$/i;
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Read each source once. Both sides are materialized from these bytes, never
// from live inputs. Ticket authors are trusted JS running as this OS user:
// permissions prevent accidental edits, not deliberate same-user access.
export async function readProofInputs({ acs, ticketDir: ticketRoot, adapters, fixtures }) {
  let bytesLeft = MAX_BYTES;
  let entriesLeft = MAX_ENTRIES;
  const count = () => {
    if (--entriesLeft < 0) throw new Error('Proof inputs exceed the 4096-entry snapshot limit.');
  };
  async function read(path, label) {
    count();
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || await realpath(path) !== path) {
      throw new Error(`${label} must be a regular file without links.`);
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await file.stat();
      if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev || current.nlink !== 1) {
        throw new Error(`${label} changed during snapshot setup.`);
      }
      if (current.size > bytesLeft) throw new Error('Proof inputs exceed the 64 MiB snapshot limit.');
      const data = Buffer.alloc(current.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const end = await file.stat();
      if (offset !== data.length || end.size !== current.size || end.mtimeMs !== current.mtimeMs || end.ctimeMs !== current.ctimeMs) {
        throw new Error(`${label} changed during snapshot setup.`);
      }
      bytesLeft -= data.length;
      return data;
    } finally { await file.close(); }
  }

  const checks = [];
  for (const { name, ticketDir } of adapters) {
    const files = [];
    const dirs = [];
    async function walk(path) {
      count();
      if (!(await lstat(path)).isDirectory() || await realpath(path) !== path) {
        throw new Error(`${name} ticket check directory must not contain links.`);
      }
      dirs.push(relative(ticketDir, path));
      for (const child of (await readdir(path)).sort()) {
        if (privateNames.test(child) || artifactExtensions.test(child)) {
          throw new Error(`${name} ticket checks must not contain generated or private artifacts.`);
        }
        const source = join(path, child);
        const info = await lstat(source);
        if (info.isDirectory()) await walk(source);
        else files.push({ name: relative(ticketDir, source), data: await read(source, `${name} ticket check`) });
      }
    }
    await walk(ticketDir);
    checks.push({ name, dirs, files });
  }

  const csv = [];
  for (const { path, name } of [...fixtures].sort((a, b) => a.name < b.name ? -1 : a.name === b.name ? 0 : 1)) {
    csv.push({ name, source: relative(ticketRoot, path), data: await read(path, 'CSV fixture') });
  }
  const fileDigests = files => files.map(({ name, data }) => [name, sha256(data)]);
  const digest = sha256(JSON.stringify([
    'proof-inputs-v1', acs.map(({ id, claim }) => [id, claim]),
    checks.map(({ name, dirs, files }) => [name, dirs, fileDigests(files)]),
    csv.map(({ source, data }) => [source, sha256(data)]),
  ]));
  return { checks, csv, digest };
}

export async function stageProofInputs({ checks, csv }, input, side) {
  const csvDir = join(side, 'csv');
  await mkdir(csvDir, { mode: 0o700 });
  for (const { name, data } of csv) await writeFile(join(csvDir, name), data, { mode: 0o400, flag: 'wx' });
  await chmod(csvDir, 0o500);
  if (!checks.length) return;
  const proofDir = join(side, 'proofs');
  await mkdir(proofDir, { mode: 0o700 });
  for (const { name, dirs, files } of checks) {
    const surface = join(proofDir, name);
    const ticketDir = join(surface, input.ticket);
    await mkdir(surface, { mode: 0o700 });
    if (name === 'bdd') {
      // Only this runner-created link may leave the staged surface. Normal
      // module realpath resolution keeps it identical to importTestFrom.
      const fixture = join(dirname(input.adapters.find(adapter => adapter.name === name).entry), 'fixtures.mjs');
      if (!(await lstat(fixture)).isFile() || await realpath(fixture) !== fixture) throw new Error('BDD harness fixture must be a regular file without symlinks.');
      await symlink(fixture, join(surface, 'fixtures.mjs'));
      await writeFile(join(surface, 'package.json'), '{"type":"module"}\n', { mode: 0o400, flag: 'wx' });
    }
    for (const dir of dirs) await mkdir(join(ticketDir, dir), { mode: 0o700 });
    for (const { name: file, data } of files) await writeFile(join(ticketDir, file), data, { mode: 0o400, flag: 'wx' });
    for (const dir of [...dirs].reverse()) await chmod(join(ticketDir, dir), 0o500);
    await chmod(surface, 0o500);
  }
  await chmod(proofDir, 0o500);
}

export async function unlockProofInputs(path) {
  try { if (!(await lstat(path)).isDirectory()) return; }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  await chmod(path, 0o700);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await unlockProofInputs(join(path, entry.name));
  }
}
