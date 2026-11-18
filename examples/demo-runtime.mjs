import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function git(repo, ...args) {
  return execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], {
    encoding: 'utf8', timeout: 10_000,
    env: {
      PATH: process.env.PATH, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_ALLOW_PROTOCOL: '',
    },
  });
}

export async function startSandbox({ id, dir, workspace, commits, signal }) {
  // Demo-only: use with the synthetic repo created by demo.mjs. Importing a
  // pinned app still runs its code as the current user, not in an OS sandbox.
  const { repo, sha } = commits.inventory;
  if (repo !== join(workspace, 'inventory') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha)) {
    throw new Error('Expected the synthetic inventory repo and a pinned commit.');
  }
  signal.throwIfAborted();
  const app = join(dir, 'app.mjs');
  await writeFile(app, git(repo, 'show', `${sha}:app.mjs`), { mode: 0o600, flag: 'wx' });
  const { handler } = await import(pathToFileURL(app).href);

  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const PROOF_APP_URL = `http://127.0.0.1:${server.address().port}`;
  const note = event => console.log(`Demo sandbox: ${JSON.stringify({ event, id, dir, sha, origin: PROOF_APP_URL })}`);
  async function close() {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
    note('close');
  }
  if (signal.aborted) {
    await close();
    signal.throwIfAborted();
  }
  note('start');
  return { env: { PROOF_APP_URL }, close };
}
