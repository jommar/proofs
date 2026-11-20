// The command line a run was started with, safe to show and store: paths, `--context` values and URL credentials are
// masked, so the line can be read and re-typed but never carries a local path, a client name or a password.
const VALUE_FLAGS = new Set(['--ac', '--branch', '--context', '--expect-commit', '--login', '--only', '--persona', '--runtime', '--source', '--target', '--url', '--workspace', '--worktree']);
const URL_CREDENTIALS = /\/\/[^/@\s]*:[^@\s]*@/g;
const PLAIN = /^[A-Za-z0-9._:,@+/=<>-]+$/;

function maskValue(flag, value) {
  const eq = value.indexOf('=');
  if (flag === '--context') return `${eq > 0 ? value.slice(0, eq) : value}=<value>`;
  if (flag === '--worktree') return eq > 0 ? `${value.slice(0, eq)}=<dir>` : '<dir>';
  if (flag === '--workspace') return '<dir>';
  if (flag === '--runtime') return value.startsWith('/') ? '<file>' : value;
  return value.replace(URL_CREDENTIALS, '//<redacted>@');
}

const quote = token => (PLAIN.test(token) ? token : `'${token.replace(/'/g, `'\\''`)}'`);

export function maskCommand(args) {
  if (!Array.isArray(args) || !args.length || args.length > 60 || !args.every(arg => typeof arg === 'string' && arg.length > 0 && arg.length <= 400)) return null;
  const out = [];
  let flag = null;
  for (const token of args) {
    if (flag) { out.push(maskValue(flag, token)); flag = null; continue; }
    const inline = /^(--[a-z-]+)=([\s\S]*)$/.exec(token);
    if (inline && VALUE_FLAGS.has(inline[1])) { out.push(`${inline[1]}=${maskValue(inline[1], inline[2])}`); continue; }
    out.push(token.replace(URL_CREDENTIALS, '//<redacted>@'));
    if (VALUE_FLAGS.has(token)) flag = token;
  }
  return `node proofs/run.mjs ${out.map(quote).join(' ')}`;
}
