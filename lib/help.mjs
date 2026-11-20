// `run.mjs --help`: the flags by purpose, example commands, and the ticket folders a workspace holds with the
// --worktree app names each manifest expects. Names only: manifests are parsed as JSON, nothing is executed and no
// environment value is read.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HARNESS_ROOT, MANIFEST_LIMIT, record, resolveWorkspace, SAFE_NAME, serviceApps } from './inputs.mjs';

const GROUPS = [
  ['What to run', [
    ['<ID>', 'the ticket folder .proofs/<ID>/ (exact name; sibling <ID>-* folders are run separately)'],
    ['--only bdd|api', 'run only this adapter (repeatable); the proof inputs digest covers only the adapters run'],
    ['--ac <id[,id...]>', 'run only these ACs; the others report Skipped (a partial run)'],
    ['--workspace <path>', 'directory that relative paths and .proofs/ are resolved from (default: current directory)'],
  ]],
  ['Where to run', [
    ['--worktree [app=]<dir>', 'local: start the committed HEAD of this Git checkout (one per app, repeatable)'],
    ['--url [name=]<origin>', 'running environment: check this origin and start nothing (repeatable)'],
    ['--target <profile>', 'a profile in .proofs/targets.json: local (add --worktree) or a running environment'],
    ['--runtime <module>', 'trusted local runtime module for --worktree (default: built-in command runtime)'],
    ['--branch <name>', 'report label for what a running environment serves (not verified)'],
    ['--insecure-tls', 'skip TLS certificate checks on a running environment you control'],
    ['--require-clean', 'refuse a --worktree checkout with uncommitted changes'],
    ['--expect-commit <sha>', 'refuse a checkout or detected build that does not contain this commit'],
  ]],
  ['Which user and data', [
    ['--login <userVar>,<passVar>', 'names of the environment variables holding the login, never the values'],
    ['--persona <name>', 'run as one persona of the target profile (one persona per run)'],
    ['--source <name>', 'a named data source of the target profile for a local run'],
    ['--context key=value', 'check input for a running environment, such as tenant=<dummy client> (repeatable)'],
  ]],
  ['Diagnostics', [
    ['--plan', 'resolve inputs and list every problem and warning; starts nothing, writes nothing'],
    ['--check', 'start the sandbox (or probe the origins) and report readiness; runs no checks'],
    ['--serve', 'keep a local sandbox up until Ctrl-C and print the --url command to iterate with'],
    ['--debug', 'keep private diagnostics and Playwright failure artifacts even on a pass'],
    ['--summary', 'merge the recorded runs into an AC x target table and a ticket comment'],
    ['-h, --help', 'show this help'],
  ]],
];

const EXAMPLES = [
  ['node proofs/run.mjs TEAM-42 --target local --worktree app=~/work/app-feature', 'the feature checkout'],
  ['node proofs/run.mjs TEAM-42 --target local --worktree app=~/work/app-base', 'its base, same flags'],
  ['node proofs/run.mjs TEAM-42 --target local --persona driver --worktree app=~/work/app-feature', 'another persona'],
  ['node proofs/run.mjs TEAM-42 --target dev --context tenant=<dummy-client>', 'a running environment'],
  ['node proofs/run.mjs TEAM-42 --summary', 'merge every recorded run'],
];

export const isHelp = args => args.some(arg => arg === '--help' || arg === '-h');

const widest = rows => Math.max(...rows.map(([left]) => left.length));
const table = (rows, width = widest(rows)) => rows.map(([left, right]) => `  ${left.padEnd(width)}  ${right}`);
const FLAG_WIDTH = widest(GROUPS.flatMap(([, rows]) => rows));

// The --worktree app names a ticket expects, [] when its manifest names none, or null when there is no manifest.
async function manifestApps(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    if (info.size > MANIFEST_LIMIT) return [];
    const services = JSON.parse(await readFile(path, 'utf8'))?.runtimeOptions?.services;
    return record(services) ? serviceApps(services).filter(app => typeof app === 'string' && SAFE_NAME.test(app)) : [];
  } catch (error) {
    return error.code === 'ENOENT' ? null : [];
  }
}

async function ticketLines(root) {
  const proofs = join(root, '.proofs');
  const entries = await readdir(proofs, { withFileTypes: true }).catch(() => []);
  const rows = [];
  for (const { name } of entries.filter(entry => entry.isDirectory() && SAFE_NAME.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const apps = await manifestApps(join(proofs, name, 'manifest.json'));
    if (apps !== null) rows.push([name, apps.map(app => `--worktree ${app}=<dir>`).join(' ')]);
  }
  return rows.length ? [`Tickets in ${proofs}/ (with the --worktree apps each manifest expects):`, ...table(rows).map(line => line.trimEnd())] : [];
}

export async function helpText(args, defaultWorkspace) {
  const flag = args.indexOf('--workspace');
  const workspace = await resolveWorkspace(flag === -1 ? defaultWorkspace : args[flag + 1]).catch(() => null);
  const roots = [...new Set([workspace, HARNESS_ROOT].filter(Boolean))];
  const tickets = (await Promise.all(roots.map(ticketLines))).filter(lines => lines.length);
  const guide = workspace && await lstat(join(workspace, 'PROOFS-GUIDE.md')).then(info => info.isFile(), () => false);
  return [
    'Usage: node <harness>/run.mjs <ID> (--worktree [app=]<dir> ... | --url [name=]<origin> ... | --target <profile>) [flags]',
    '       node <harness>/run.mjs <ID> --summary [--workspace <path>]',
    '',
    'Runs one ticket\'s acceptance-criteria checks against one target and writes .proofs-out/<ID>/<run-id>/report.md.',
    ...GROUPS.flatMap(([title, rows]) => ['', `${title}:`, ...table(rows, FLAG_WIDTH)]),
    '', 'Examples:', ...table(EXAMPLES.map(([command, what]) => [command, `# ${what}`])),
    ...tickets.flatMap(lines => ['', ...lines]),
    '',
    `More: ${join(HARNESS_ROOT, 'README.md')} (reference) and ${join(HARNESS_ROOT, 'SKILL.md')} (procedure).`,
    ...(guide ? [`Workspace guide: ${join(workspace, 'PROOFS-GUIDE.md')}`] : []),
  ].join('\n');
}
