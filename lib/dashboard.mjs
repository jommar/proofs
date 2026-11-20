import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { maskCommand } from './command.mjs';
import { isAncestor as gitIsAncestor } from './inputs.mjs';
import { PROGRESS_STALE_MS, RUN_DIR, withLock } from './runs.mjs';

const INDEX = 'runs.json';
const DASHBOARD = 'dashboard.html';
const INDEX_LIMIT = 10 * 1024 * 1024;
const REPORT_LIMIT = 1024 * 1024;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_RUNTIME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/@+-]{0,127}$/;
const URL_KEY = /^PROOF_[A-Z0-9_]+_URL$/;
const CONTEXT_KEY = /^PROOF_CONTEXT_([A-Z0-9_]+)$/;
const SAFE_PHASE = /^[a-z][a-z0-9_-]{0,31}$/;
const REFRESH_SECONDS = 5;

export class InvalidRunsIndexError extends Error {
  constructor(message = 'runs.json is not a valid index object') {
    super(message);
    this.name = 'InvalidRunsIndexError';
  }
}

export class UnsafeOutputDirError extends Error {
  constructor(message = 'Output directory must be a private directory owned by the current user.') {
    super(message);
    this.name = 'UnsafeOutputDirError';
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseTs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

function compareDescTs(aIso, bIso) {
  const a = parseTs(aIso);
  const b = parseTs(bIso);
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

function unescapeMarkdownCell(value) {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && i + 1 < value.length) out += value[++i];
    else out += value[i];
  }
  return out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function splitMarkdownRow(line) {
  const cells = [];
  let current = '';
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (escaped) {
      current += '\\' + ch;
      escaped = false;
    } else if (ch === '\\') {
      escaped = true;
    } else if (ch === '|') {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (escaped) current += '\\';
  cells.push(current);
  if (cells.length >= 2 && !cells[0].trim()) cells.shift();
  if (cells.length >= 1 && !cells[cells.length - 1].trim()) cells.pop();
  return cells.map(unescapeMarkdownCell);
}

function classifyVerdict(text) {
  if (/^Pass\b/.test(text)) return 'pass';
  if (/^Fail\b/.test(text)) return 'fail';
  if (/^Skipped\b/.test(text)) return 'skipped';
  if (/^Not applicable here\b/.test(text)) return 'na';
  if (/^Blocked\s*(?:—|-|:)\s*Uncovered\b/i.test(text)) return 'uncovered';
  if (/^Blocked\b/.test(text)) return 'blocked';
  return 'unknown';
}

function parseDurationLine(line) {
  const match = /^Duration:\s*([0-9]+(?:\.[0-9]+)?)s(?:\s*\(([^)]+)\))?\s*$/.exec(line);
  if (!match) return null;
  const durationMs = Math.round(Number(match[1]) * 1000);
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  const timings = { durationMs, adapters: {} };
  if (match[2]) {
    for (const part of match[2].split(',')) {
      const m = /^\s*([A-Za-z0-9._-]+)\s+([0-9]+(?:\.[0-9]+)?)s\s*$/.exec(part);
      if (!m) continue;
      const ms = Math.round(Number(m[2]) * 1000);
      if (!Number.isFinite(ms) || ms < 0) continue;
      if (m[1] === 'startup') timings.startupMs = ms;
      else if (m[1] === 'teardown') timings.teardownMs = ms;
      else timings.adapters[m[1]] = ms;
    }
  }
  return { durationMs, timings };
}

export function parseReportMarkdown(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let proofDigest = null;
  let partial = false;
  let selectedAcs = [];
  let durationMs = null;
  let timings = null;
  const acs = [];
  const notes = [];
  const issues = [];
  let section = null;
  let inTable = false;

  for (const line of lines) {
    const digestMatch = /^Proof inputs digest:\s*`sha256:([a-f0-9]+)`/i.exec(line);
    if (digestMatch) {
      proofDigest = digestMatch[1];
      continue;
    }
    if (line.startsWith('Duration:')) {
      const parsedDuration = parseDurationLine(line);
      if (parsedDuration) {
        durationMs = parsedDuration.durationMs;
        timings = parsedDuration.timings;
      }
      continue;
    }
    if (/^Filtered ACs:/.test(line)) {
      partial = true;
      const acMatch = /^Filtered ACs:\s*`([^`]+)`/.exec(line);
      if (acMatch) {
        selectedAcs = acMatch[1].split(',').map(s => s.trim()).filter(Boolean);
      }
      continue;
    }
    if (/^##\s+Execution notes\s*$/i.test(line)) {
      section = 'notes';
      inTable = false;
      continue;
    }
    if (/^##\s+Run issues\s*$/i.test(line)) {
      section = 'issues';
      inTable = false;
      continue;
    }
    if (/^##\s+/.test(line)) {
      section = null;
      inTable = false;
      continue;
    }
    if (line === '| AC | Result |') {
      inTable = true;
      section = null;
      continue;
    }
    if (inTable) {
      if (/^\|\s*:?-{3,}:?\s*\|\s*:?-{3,}:?\s*\|$/.test(line)) continue;
      if (!line.startsWith('|')) {
        inTable = false;
      } else {
        const [acCell = '', resultCell = ''] = splitMarkdownRow(line);
        const sep = acCell.indexOf(' — ');
        const id = sep >= 0 ? acCell.slice(0, sep).trim() : acCell.trim();
        const claim = sep >= 0 ? acCell.slice(sep + 3).trim() : '';
        const status = classifyVerdict(resultCell);
        const detailSep = resultCell.indexOf(' — ');
        const detail = detailSep >= 0 ? resultCell.slice(detailSep + 3).trim() : resultCell;
        if (id) acs.push({ id, claim, status, result: resultCell, detail });
        continue;
      }
    }
    if (section && line.startsWith('- ')) {
      const item = line.slice(2).trim();
      if (item) (section === 'notes' ? notes : issues).push(item);
    }
  }

  const counts = { pass: 0, fail: 0, blocked: 0, skipped: 0, uncovered: 0, na: 0, unknown: 0, total: acs.length };
  for (const ac of acs) counts[ac.status] = (counts[ac.status] ?? 0) + 1;

  return { proofDigest, partial, selectedAcs, durationMs, timings, acs, counts, notes, issues };
}

function ownedByMe(info) {
  return typeof process.getuid !== 'function' || info.uid === process.getuid();
}

async function checkPrivateDir(dir) {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    throw new UnsafeOutputDirError();
  }
  if (!info.isDirectory() || !ownedByMe(info) || (info.mode & 0o077) !== 0) {
    throw new UnsafeOutputDirError();
  }
}

async function isOwnedRealDir(dir) {
  try {
    const info = await lstat(dir);
    return info.isDirectory() && ownedByMe(info);
  } catch {
    return false;
  }
}

async function readSafeRegularFile(path, limit, { throwOnMissing = false } = {}) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (throwOnMissing && error.code === 'ENOENT') throw error;
    return null;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || !ownedByMe(info) || info.size > limit) return null;
    const chunks = [];
    let total = 0;
    const buf = Buffer.allocUnsafe(Math.min(65536, Math.max(4096, info.size + 1)));
    while (true) {
      const { bytesRead } = await file.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) return null;
      chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks, total));
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

function sanitizeRuntime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  if (trimmed === 'built-in') return 'built-in';
  const base = basename(trimmed);
  return SAFE_RUNTIME_FILE.test(base) ? base : 'custom';
}

function sanitizeBranch(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('..') || !SAFE_BRANCH.test(trimmed)) return null;
  return trimmed;
}

function sanitizeWorktrees(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.app !== 'string' || !item.app.trim()) continue;
    const branch = sanitizeBranch(item.branch);
    out.push({
      app: item.app.trim(),
      sha: typeof item.sha === 'string' ? item.sha.trim() : '',
      dirty: Boolean(item.dirty),
      ...(branch ? { branch } : {}),
    });
  }
  return out;
}

function sanitizeUrls(raw) {
  if (!isRecord(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!URL_KEY.test(key) || typeof value !== 'string') continue;
    try {
      const parsed = new URL(value);
      if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password) {
        out[key] = parsed.origin;
      }
    } catch { /* ignore malformed URL */ }
  }
  return out;
}

function sanitizeContextKeys(raw) {
  if (!isRecord(raw)) return [];
  const keys = [];
  for (const key of Object.keys(raw)) {
    const m = CONTEXT_KEY.exec(key);
    if (m) keys.push(m[1].toLowerCase());
  }
  return keys.sort();
}

function sanitizeTimings(raw) {
  if (!isRecord(raw)) return null;
  const out = {};
  if (Number.isFinite(raw.durationMs) && raw.durationMs >= 0) out.durationMs = raw.durationMs;
  if (Number.isFinite(raw.startupMs) && raw.startupMs >= 0) out.startupMs = raw.startupMs;
  if (Number.isFinite(raw.teardownMs) && raw.teardownMs >= 0) out.teardownMs = raw.teardownMs;
  if (isRecord(raw.adapters)) {
    const adapters = {};
    for (const [name, ms] of Object.entries(raw.adapters)) {
      if (/^[A-Za-z0-9._-]+$/.test(name) && Number.isFinite(ms) && ms >= 0) {
        adapters[name] = ms;
      }
    }
    if (Object.keys(adapters).length) out.adapters = adapters;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeStrings(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim());
}

function summarizeRunStatus(record, parsed) {
  if (parsed?.acs?.length) {
    if (parsed.counts.fail > 0) return 'fail';
    if (parsed.counts.blocked > 0 || parsed.counts.uncovered > 0) return 'blocked';
    if (record.exitCode === 0) return 'pass';
  }
  return record.exitCode === 0 ? 'pass' : 'fail';
}

const processAlive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

// A running entry stays running only while its runner process exists and its heartbeat is recent; otherwise the run
// crashed or was killed and never wrote its final record.
function liveStatus(record, now) {
  const beat = parseTs(record.updatedAt);
  const fresh = beat !== null && now - beat < PROGRESS_STALE_MS;
  return fresh && Number.isInteger(record.pid) && record.pid > 0 && processAlive(record.pid) ? 'running' : 'interrupted';
}

// Extract raw --worktree paths from runs.json args strictly for local Git ancestry / branch lookups.
// Paths are never emitted into dashboard JSON or HTML.
function extractArgWorktreePaths(args, worktrees) {
  const pairs = [];
  if (!Array.isArray(args)) return pairs;
  for (let i = 0; i < args.length; i++) {
    let val = null;
    if (args[i] === '--worktree' && typeof args[i + 1] === 'string') {
      val = args[++i];
    } else if (typeof args[i] === 'string' && args[i].startsWith('--worktree=')) {
      val = args[i].slice('--worktree='.length);
    }
    if (!val) continue;
    const m = /^(?:([A-Za-z0-9][A-Za-z0-9._-]{0,63})=)?(.+)$/.exec(val);
    if (!m) continue;
    const app = m[1] || (worktrees.length === 1 ? worktrees[0].app : null);
    if (app && m[2]) pairs.push([app, m[2]]);
  }
  return pairs;
}

function defaultResolveBranch(repo, sha) {
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return null;
  const res = spawnSync('git', ['--no-optional-locks', '-C', repo, 'branch', '--points-at', sha, '--format=%(refname:short)'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    timeout: 5_000,
    killSignal: 'SIGKILL',
  });
  if (res.status !== 0 || !res.stdout) return null;
  const names = res.stdout.split('\n').map(s => s.trim()).filter(Boolean).filter(s => s !== 'HEAD');
  return names.length === 1 ? sanitizeBranch(names[0]) : null;
}

function worktreeSignature(run) {
  return (run.worktrees ?? []).map(w => `${w.app}@${w.sha}`).sort().join(' ');
}

function targetSignature(run) {
  if (run.type === 'worktree') return `wt:${worktreeSignature(run)}`;
  return `url:${Object.values(run.urls ?? {}).sort().join(',')}|${run.branch ?? ''}`;
}

function orderByGitAncestry(a, b, appRepos, checkAncestor) {
  let aBeforeB = false;
  let bBeforeA = false;
  for (const left of a.worktrees ?? []) {
    const right = (b.worktrees ?? []).find(w => w.app === left.app);
    if (!right || !left.sha || !right.sha || left.sha === right.sha) continue;
    const repos = appRepos.get(left.app);
    if (!repos || !repos.size) continue;
    for (const repo of repos) {
      if (checkAncestor(repo, left.sha, right.sha) === true) { aBeforeB = true; break; }
      if (checkAncestor(repo, right.sha, left.sha) === true) { bBeforeA = true; break; }
    }
  }
  if (aBeforeB && !bBeforeA) return [a, b];
  if (bBeforeA && !aBeforeB) return [b, a];
  return null;
}

function classifyDeltaStatus(bs, fs) {
  if (bs === 'na' || fs === 'na' || bs === 'skipped' || fs === 'skipped' || bs === 'missing' || fs === 'missing') return 'skipped';
  if (bs !== 'pass' && fs === 'pass') return 'delivered';
  if (bs === 'pass' && fs !== 'pass') return 'regression';
  if (bs === 'pass' && fs === 'pass') return 'holds';
  if (bs === 'fail' && fs === 'fail') return 'notMet';
  if (fs === 'fail') return 'regression';
  return 'other';
}

function computeVerdictCounts(base, feat) {
  if (!base || !feat) return null;
  const baseMap = new Map((base.acs ?? []).map(a => [a.id, a.status]));
  const featMap = new Map((feat.acs ?? []).map(a => [a.id, a.status]));
  const ids = [...new Set([...baseMap.keys(), ...featMap.keys()])];
  if (!ids.length) return null;
  const counts = { delivered: 0, holds: 0, notMet: 0, regression: 0, skipped: 0, other: 0, total: ids.length };
  for (const id of ids) {
    const key = classifyDeltaStatus(baseMap.get(id) ?? 'missing', featMap.get(id) ?? 'missing');
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function collectDashboardData(outDir, { now = Date.now(), isAncestor, resolveBranch } = {}) {
  await checkPrivateDir(outDir);
  const indexRaw = await readSafeRegularFile(join(outDir, INDEX), INDEX_LIMIT, { throwOnMissing: true });
  if (indexRaw === null) throw new InvalidRunsIndexError('runs.json is unreadable, oversized, or unsafe.');
  const index = JSON.parse(indexRaw);
  if (!isRecord(index)) throw new InvalidRunsIndexError();

  const ancestorCache = new Map();
  const checkAncestor = (repo, a, b) => {
    const key = `${repo}\0${a}\0${b}`;
    if (ancestorCache.has(key)) return ancestorCache.get(key);
    const val = isAncestor ? isAncestor(repo, a, b) : gitIsAncestor(repo, a, b);
    ancestorCache.set(key, val);
    return val;
  };
  const branchCache = new Map();
  const lookupBranch = (repo, sha) => {
    const key = `${repo}\0${sha}`;
    if (branchCache.has(key)) return branchCache.get(key);
    const val = sanitizeBranch(resolveBranch ? resolveBranch(repo, sha) : defaultResolveBranch(repo, sha));
    branchCache.set(key, val);
    return val;
  };

  const runs = [];
  const appRepos = new Map();
  const runOwnRepos = new Map();
  const dirValidCache = new Map();
  const checkDir = async dir => {
    if (dirValidCache.has(dir)) return dirValidCache.get(dir);
    const ok = await isOwnedRealDir(dir);
    dirValidCache.set(dir, ok);
    return ok;
  };

  for (const [ticket, ticketRuns] of Object.entries(index)) {
    if (!SAFE_TICKET.test(ticket) || !isRecord(ticketRuns)) continue;
    const ticketDir = join(outDir, ticket);
    const ticketDirOk = await isOwnedRealDir(ticketDir);

    for (const [runId, record] of Object.entries(ticketRuns)) {
      if (!RUN_DIR.test(runId) || !isRecord(record)) continue;
      const runDir = join(ticketDir, runId);
      const runDirOk = ticketDirOk && await isOwnedRealDir(runDir);
      const reportText = runDirOk ? await readSafeRegularFile(join(runDir, 'report.md'), REPORT_LIMIT) : null;
      const parsed = reportText !== null ? parseReportMarkdown(reportText) : null;
      const hasDiagnostics = runDirOk && await isOwnedRealDir(join(runDir, 'diagnostics'));

      const recordSelectedAcs = sanitizeStrings(record.selectedAcs);
      const selectedAcs = recordSelectedAcs.length ? recordSelectedAcs : (parsed?.selectedAcs ?? []);
      const recordDurationMs = Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : null;
      const durationMs = recordDurationMs ?? parsed?.durationMs ?? null;
      const timings = sanitizeTimings(record.timings) ?? parsed?.timings ?? null;
      const live = record.state === 'running';
      const worktrees = sanitizeWorktrees(record.worktrees);
      const partial = selectedAcs.length > 0 || Boolean(parsed?.partial);
      const debug = Boolean(record.debug);

      const ownRepos = new Map();
      for (const [app, dir] of extractArgWorktreePaths(record.args, worktrees)) {
        if (await checkDir(dir)) {
          ownRepos.set(app, dir);
          if (!appRepos.has(app)) appRepos.set(app, new Set());
          appRepos.get(app).add(dir);
        }
      }
      runOwnRepos.set(`${ticket}/${runId}`, ownRepos);

      const sourceName = isRecord(record.source) && typeof record.source.name === 'string' && SAFE_TICKET.test(record.source.name)
        ? record.source.name : null;

      runs.push({
        ticket,
        id: runId,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
        durationMs,
        timings,
        exitCode: live ? null : Number.isInteger(record.exitCode) ? record.exitCode : 1,
        status: live ? liveStatus(record, now) : summarizeRunStatus(record, parsed),
        phase: live && SAFE_PHASE.test(record.phase) ? record.phase : null,
        updatedAt: live && parseTs(record.updatedAt) !== null ? record.updatedAt : null,
        type: record.type === 'url' ? 'url' : 'worktree',
        runtime: sanitizeRuntime(record.runtime),
        adapters: sanitizeStrings(record.only),
        selectedAcs,
        partial,
        debug,
        complete: !partial && !debug,
        role: null,
        hasDiagnostics,
        worktrees,
        urls: sanitizeUrls(record.urls),
        contextKeys: sanitizeContextKeys(record.context),
        branch: sanitizeBranch(record.branch),
        command: maskCommand(record.args),
        profile: typeof record.profile === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(record.profile) ? record.profile : null,
        persona: typeof record.persona === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(record.persona) ? record.persona : null,
        sourceName,
        report: `${ticket}/${runId}/report.md`,
        reportMissing: parsed === null,
        proofDigest: parsed?.proofDigest ?? null,
        counts: parsed?.counts ?? { pass: 0, fail: 0, blocked: 0, skipped: 0, uncovered: 0, na: 0, unknown: 0, total: 0 },
        acs: parsed?.acs ?? [],
        notes: parsed?.notes ?? [],
        issues: parsed?.issues ?? [],
      });
    }
  }

  runs.sort((a, b) => compareDescTs(a.startedAt, b.startedAt) || b.id.localeCompare(a.id) || a.ticket.localeCompare(b.ticket));

  // Best-effort branch resolution for historical worktree runs whose runs.json entry lacks `branch`.
  for (const run of runs) {
    if (run.type !== 'worktree') continue;
    const own = runOwnRepos.get(`${run.ticket}/${run.id}`);
    for (const wt of run.worktrees) {
      if (wt.branch || !wt.sha) continue;
      const candidates = [];
      if (own?.has(wt.app)) candidates.push(own.get(wt.app));
      for (const dir of appRepos.get(wt.app) ?? []) {
        if (!candidates.includes(dir)) candidates.push(dir);
      }
      for (const repo of candidates) {
        const resolved = lookupBranch(repo, wt.sha);
        if (resolved) { wt.branch = resolved; break; }
      }
    }
  }

  const runsByTicket = new Map();
  for (const run of runs) {
    if (!runsByTicket.has(run.ticket)) runsByTicket.set(run.ticket, []);
    runsByTicket.get(run.ticket).push(run);
  }

  const tickets = [];
  for (const [ticket, ticketRuns] of runsByTicket.entries()) {
    const latest = ticketRuns[0];
    let passCount = 0;
    let failCount = 0;
    let blockedCount = 0;
    let completeCount = 0;
    for (const run of ticketRuns) {
      if (run.status === 'pass') passCount++;
      else if (run.status === 'blocked') blockedCount++;
      else if (run.status === 'fail') failCount++;
      if (run.complete) completeCount++;
    }

    const completeRuns = ticketRuns.filter(r => r.complete);
    const completeWorktrees = completeRuns.filter(r => r.type === 'worktree' && r.worktrees.length > 0);
    const bySig = new Map();
    for (const r of completeWorktrees) {
      const sig = worktreeSignature(r);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(r);
    }
    const sigSets = [...bySig.values()];

    let comparePair = null;
    let baseRun = null;
    let featureRun = null;

    if (sigSets.length >= 2) {
      const ordered = orderByGitAncestry(sigSets[1][0], sigSets[0][0], appRepos, checkAncestor);
      if (ordered) {
        [baseRun, featureRun] = ordered;
        const baseSig = worktreeSignature(baseRun);
        const featSig = worktreeSignature(featureRun);
        for (const r of ticketRuns) {
          if (r.type !== 'worktree') continue;
          const sig = worktreeSignature(r);
          if (sig === featSig) r.role = 'feature';
          else if (sig === baseSig) r.role = 'base';
        }
        comparePair = { baseId: baseRun.id, featureId: featureRun.id, source: 'git' };
      }
    }

    if (!comparePair && ticketRuns.length >= 2) {
      const pool = completeRuns.length >= 2 ? completeRuns : ticketRuns;
      featureRun = pool[0];
      const featSig = targetSignature(featureRun);
      baseRun = pool.find(r => r.id !== featureRun.id && targetSignature(r) !== featSig) || pool[1];
      comparePair = { baseId: baseRun.id, featureId: featureRun.id, source: 'recent' };
    }

    const verdictCounts = comparePair ? computeVerdictCounts(baseRun, featureRun) : null;
    const primary = (comparePair?.source === 'git' && featureRun)
      ? featureRun
      : (completeRuns[0] || latest);

    tickets.push({
      ticket,
      runCount: ticketRuns.length,
      completeCount,
      noisyCount: ticketRuns.length - completeCount,
      passCount,
      failCount,
      blockedCount,
      latestRunId: latest.id,
      latestStatus: latest.status,
      latestStartedAt: latest.startedAt,
      latestCounts: latest.counts,
      primaryRunId: primary.id,
      primaryStatus: primary.status,
      primaryCounts: primary.counts,
      comparePair,
      verdictCounts,
    });
  }

  tickets.sort((a, b) => compareDescTs(a.latestStartedAt, b.latestStartedAt) || a.ticket.localeCompare(b.ticket));

  return {
    generatedAt: new Date(now).toISOString(),
    ticketCount: tickets.length,
    runCount: runs.length,
    tickets,
    runs,
  };
}

function safeJsonForHtml(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const CLIENT_SCRIPT = `
    (function () {
      const DATA = JSON.parse(document.getElementById('proofs-data').textContent || '{}');
      const RUNS = Array.isArray(DATA.runs) ? DATA.runs : [];
      const TICKETS = Array.isArray(DATA.tickets) ? DATA.tickets : [];
      // The page outlives a crashed run: a running entry whose heartbeat stopped is shown as interrupted.
      for (const run of RUNS) {
        if (run.status !== 'running' || Date.now() - Date.parse(run.updatedAt) < ${PROGRESS_STALE_MS}) continue;
        run.status = 'interrupted';
        for (const t of TICKETS) {
          if (t.ticket !== run.ticket) continue;
          if (t.latestRunId === run.id) t.latestStatus = 'interrupted';
          if (t.primaryRunId === run.id) t.primaryStatus = 'interrupted';
        }
      }

      const ADAPTER_PALETTE = ['#818cf8', '#34d399', '#f472b6', '#22d3ee', '#fb923c', '#a78bfa'];
      const SVG_NS = 'http://www.w3.org/2000/svg';
      const runKey = (run) => run.ticket + '/' + run.id;
      const ticketMap = new Map(TICKETS.map(t => [t.ticket, t]));

      // Compute unchanged worktree apps per ticket so cards & compare focus on what actually changed.
      const unchangedAppsByTicket = new Map();
      for (const t of TICKETS) {
        const wtRuns = RUNS.filter(r => r.ticket === t.ticket && r.type === 'worktree' && r.worktrees.length > 0);
        if (wtRuns.length < 2) { unchangedAppsByTicket.set(t.ticket, new Set()); continue; }
        const shasByApp = new Map();
        for (const r of wtRuns) {
          for (const w of r.worktrees) {
            if (!shasByApp.has(w.app)) shasByApp.set(w.app, new Set());
            shasByApp.get(w.app).add(w.sha || '');
          }
        }
        const unchanged = new Set();
        for (const [app, shas] of shasByApp.entries()) {
          if (shas.size === 1) unchanged.add(app);
        }
        unchangedAppsByTicket.set(t.ticket, unchanged);
      }

      const hasAnyComplete = RUNS.some(r => r.complete !== false && !r.partial && !r.debug);

      const state = {
        ticket: 'all',
        status: 'all',
        mode: 'all',
        scope: hasAnyComplete ? 'complete' : 'all',
        search: '',
        selectedKey: RUNS[0] ? runKey(RUNS[0]) : null,
        activeTab: 'inspect',
        acFilter: 'all',
        inspectShowDetails: false,
        compareBaseKey: null,
        compareFeatureKey: null,
        compareVerdictFilter: 'all',
        compareChangedOnly: false,
        compareShowDetails: false,
        timingExpanded: true,
      };

      function isCompleteRun(run) {
        return typeof run.complete === 'boolean' ? run.complete : (!run.partial && !run.debug);
      }

      function readHash() {
        const raw = (location.hash || '').replace(/^#/, '');
        if (!raw) return;
        const params = new URLSearchParams(raw);
        const t = params.get('ticket');
        if (t && (t === 'all' || ticketMap.has(t))) state.ticket = t;
        const r = params.get('run');
        if (r && RUNS.some(x => runKey(x) === r)) {
          state.selectedKey = r;
          const matched = RUNS.find(x => runKey(x) === r);
          if (matched && !isCompleteRun(matched)) state.scope = 'all';
        }
        const tab = params.get('tab');
        if (tab === 'inspect' || tab === 'compare') state.activeTab = tab;
        const b = params.get('base');
        if (b && RUNS.some(x => runKey(x) === b)) state.compareBaseKey = b;
        const f = params.get('feature');
        if (f && RUNS.some(x => runKey(x) === f)) state.compareFeatureKey = f;
      }

      function writeHash() {
        try {
          const params = new URLSearchParams();
          if (state.ticket !== 'all') params.set('ticket', state.ticket);
          if (state.selectedKey) params.set('run', state.selectedKey);
          if (state.activeTab !== 'inspect') params.set('tab', state.activeTab);
          if (state.activeTab === 'compare' && state.compareBaseKey && state.compareFeatureKey) {
            params.set('base', state.compareBaseKey);
            params.set('feature', state.compareFeatureKey);
          }
          const next = params.toString();
          const targetHash = next ? '#' + next : '';
          if (location.hash !== targetHash) history.replaceState(null, '', targetHash || location.pathname + location.search);
        } catch { /* ignore file:// history restrictions */ }
      }

      const el = (tag, props = {}, children = []) => {
        const node = document.createElement(tag);
        if (tag === 'button' && !('type' in props)) node.setAttribute('type', 'button');
        for (const [k, v] of Object.entries(props)) {
          if (k === 'className') node.className = v;
          else if (k === 'text') node.textContent = v;
          else if (k === 'style' && typeof v === 'object' && v !== null) {
            for (const [sk, sv] of Object.entries(v)) {
              if (sk.startsWith('--')) node.style.setProperty(sk, String(sv));
              else node.style[sk] = sv;
            }
          } else if (k.startsWith('on') && typeof v === 'function') {
            node.addEventListener(k.slice(2).toLowerCase(), v);
          } else if (k === 'value') {
            node.value = String(v ?? '');
          } else if (k === 'open') {
            if (v) node.setAttribute('open', '');
          } else if (v !== undefined && v !== null) {
            node.setAttribute(k, String(v));
          }
        }
        for (const child of Array.isArray(children) ? children : [children]) {
          if (child === null || child === undefined) continue;
          node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
        }
        return node;
      };

      const sEl = (tag, attrs = {}) => {
        const n = document.createElementNS(SVG_NS, tag);
        for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
        return n;
      };

      const fmtDur = (ms) => {
        if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return 'n/a';
        if (ms < 1000) return Math.round(ms) + 'ms';
        if (ms < 59950) return (ms / 1000).toFixed(1) + 's';
        const totalSec = Math.round(ms / 1000);
        const m = Math.floor(totalSec / 60);
        const s = totalSec % 60;
        return m + 'm ' + s + 's';
      };

      const fmtTime = (iso) => {
        if (!iso) return 'n/a';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return iso;
        return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      };

      const fmtClock = (iso) => {
        if (!iso) return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
      };

      const shortSha = (sha) => (sha ? String(sha).slice(0, 7) : '');

      const adapterColor = (name) => {
        if (name === 'bdd') return '#818cf8';
        if (name === 'api') return '#34d399';
        let h = 0;
        for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
        return ADAPTER_PALETTE[h % ADAPTER_PALETTE.length];
      };

      const extractPhaseSegments = (run) => {
        const t = run.timings || {};
        const segs = [];
        if (Number.isFinite(t.startupMs) && t.startupMs > 0) segs.push({ key: 'startup', ms: t.startupMs, color: '#38bdf8' });
        if (t.adapters && typeof t.adapters === 'object') {
          for (const [name, ms] of Object.entries(t.adapters)) {
            if (Number.isFinite(ms) && ms > 0) segs.push({ key: name, ms, color: adapterColor(name) });
          }
        }
        if (Number.isFinite(t.teardownMs) && t.teardownMs > 0) segs.push({ key: 'teardown', ms: t.teardownMs, color: '#fbbf24' });
        return segs;
      };

      const changedWorktrees = (run) => {
        if (run.type !== 'worktree' || !run.worktrees.length) return [];
        const unchanged = unchangedAppsByTicket.get(run.ticket);
        if (!unchanged || !unchanged.size) return run.worktrees;
        const diff = run.worktrees.filter(w => !unchanged.has(w.app));
        return diff.length ? diff : run.worktrees;
      };

      const runBranchHeadline = (run) => {
        if (run.type === 'worktree') {
          const focus = changedWorktrees(run);
          const branches = [...new Set(focus.map(w => w.branch).filter(Boolean))];
          if (branches.length === 1) return branches[0];
          if (branches.length > 1) return branches.join(', ');
          if (run.role === 'base') return 'base checkout';
          if (run.role === 'feature') return 'feature checkout';
          return focus.map(w => w.app + '@' + (shortSha(w.sha) || '?')).join(', ') || (run.profile || 'worktree');
        }
        if (run.branch) return run.branch;
        const urls = Object.values(run.urls || {});
        if (urls.length === 1) return urls[0];
        if (urls.length > 1) return urls[0] + ' (+' + (urls.length - 1) + ')';
        return run.profile || 'url';
      };

      const runCompactTarget = (run) => {
        if (run.type === 'worktree') {
          const focus = changedWorktrees(run);
          if (!focus.length) return run.profile || 'worktree';
          const branches = [...new Set(focus.map(w => w.branch).filter(Boolean))];
          const shas = focus.map(w => w.app + '@' + (shortSha(w.sha) || '?') + (w.dirty ? '*' : '')).join(', ');
          return branches.length === 1 ? branches[0] + ' · ' + shas : shas;
        }
        const urlList = Object.values(run.urls || {});
        const parts = [];
        if (run.branch) parts.push(run.branch);
        if (urlList.length === 1) parts.push(urlList[0]);
        else if (urlList.length > 1) parts.push(urlList[0] + ' (+' + (urlList.length - 1) + ')');
        if (!parts.length && run.profile) parts.push(run.profile);
        return parts.join(' · ') || 'url';
      };

      const runTargetLabel = (run) => {
        if (run.type === 'worktree') {
          if (!run.worktrees.length) return run.profile || 'worktree';
          const prefix = run.profile ? run.profile + (run.persona ? ' as ' + run.persona : '') + ' | ' : '';
          return prefix + run.worktrees.map(w => w.app + '@' + (shortSha(w.sha) || '?') + (w.branch ? ' (' + w.branch + ')' : '') + (w.dirty ? '*' : '')).join(', ');
        }
        const urlList = Object.values(run.urls || {});
        const parts = [];
        if (run.profile) parts.push(run.profile + (run.persona ? ' as ' + run.persona : ''));
        if (run.branch) parts.push(run.branch);
        if (urlList.length === 1) parts.push(urlList[0]);
        else if (urlList.length > 1) parts.push(urlList[0] + ' (+' + (urlList.length - 1) + ')');
        return parts.join(' | ') || 'url';
      };

      const statusPill = (status, label) => {
        const map = {
          pass: 'pill-pass',
          fail: 'pill-fail',
          blocked: 'pill-blocked',
          uncovered: 'pill-uncovered',
          skipped: 'pill-skipped',
          na: 'pill-skipped',
          running: 'pill-info pill-live',
          interrupted: 'pill-skipped',
        };
        return el('span', { className: 'pill ' + (map[status] || 'pill-muted'), text: label || status });
      };

      const rolePill = (role) => {
        if (role === 'feature') return el('span', { className: 'pill pill-feature', text: 'FEATURE' });
        if (role === 'base') return el('span', { className: 'pill pill-base', text: 'BASE' });
        return null;
      };

      const inProgress = (run) => run.status === 'running' || run.status === 'interrupted';
      const statusLabel = (run) => (inProgress(run) && run.phase ? run.status + ': ' + run.phase : run.status);
      const runDur = (run) => (run.status === 'running' ? fmtDur(Date.now() - Date.parse(run.startedAt)) + ' elapsed' : fmtDur(run.durationMs));

      const svgRing = (pct, color, size = 48, stroke = 4.5, labelText = null) => {
        const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
        const r = (size - stroke) / 2;
        const c = 2 * Math.PI * r;
        const offset = c * (1 - clamped / 100);
        const svg = sEl('svg', {
          width: size, height: size, viewBox: '0 0 ' + size + ' ' + size,
          class: 'ring-svg', 'aria-hidden': 'true',
        });
        svg.appendChild(sEl('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none',
          stroke: 'rgba(148,163,184,0.16)', 'stroke-width': stroke,
        }));
        svg.appendChild(sEl('circle', {
          cx: size / 2, cy: size / 2, r, fill: 'none',
          stroke: color, 'stroke-width': stroke, 'stroke-linecap': 'round',
          'stroke-dasharray': c.toFixed(2),
          'stroke-dashoffset': offset.toFixed(2),
          transform: 'rotate(-90 ' + (size / 2) + ' ' + (size / 2) + ')',
          class: 'ring-progress',
        }));
        const wrap = el('div', { className: 'ring-wrap', style: { width: size + 'px', height: size + 'px' } }, [
          svg,
          el('span', { className: 'ring-label mono', text: labelText !== null ? labelText : Math.round(clamped) + '%' }),
        ]);
        return wrap;
      };

      const acSegBar = (counts, height = 6) => {
        const total = counts?.total || 0;
        const bar = el('div', { className: 'seg-bar', style: { height: height + 'px' } });
        if (!total) return bar;
        const parts = [
          { n: counts.pass || 0, color: 'var(--emerald)', label: 'Pass' },
          { n: counts.fail || 0, color: 'var(--rose)', label: 'Fail' },
          { n: (counts.blocked || 0) + (counts.uncovered || 0), color: 'var(--amber)', label: 'Blocked' },
          { n: (counts.skipped || 0) + (counts.na || 0) + (counts.unknown || 0), color: '#475569', label: 'Skipped / N/A' },
        ];
        for (const p of parts) {
          if (!p.n) continue;
          bar.appendChild(el('span', {
            className: 'seg-fill',
            style: { width: ((p.n / total) * 100).toFixed(2) + '%', background: p.color },
            title: p.label + ': ' + p.n + '/' + total,
          }));
        }
        return bar;
      };

      const copyButton = (textToCopy, ariaLabel) => {
        const btn = el('button', {
          className: 'btn btn-xs',
          'aria-label': ariaLabel || 'Copy value',
          text: 'Copy',
          onClick: async (e) => {
            e.stopPropagation();
            try {
              await navigator.clipboard.writeText(textToCopy);
              btn.textContent = '✓ Copied';
              btn.classList.add('btn-copied');
              setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('btn-copied'); }, 1300);
            } catch {
              btn.textContent = 'No clipboard';
              setTimeout(() => { btn.textContent = 'Copy'; }, 1300);
            }
          },
        });
        return btn;
      };

      const applicableTotal = (counts) => Math.max(0, (counts?.total || 0) - (counts?.na || 0));
      const passPercent = (counts) => {
        const denom = applicableTotal(counts) || (counts?.total || 0);
        return denom ? ((counts?.pass || 0) / denom) * 100 : 0;
      };
      const formatAcRatio = (counts) => {
        const pass = counts?.pass || 0;
        const na = counts?.na || 0;
        const total = counts?.total || 0;
        if (na > 0 && total > na) return pass + '/' + (total - na) + ' ACs · ' + na + ' N/A';
        return pass + '/' + total + ' ACs';
      };

      const humanizeKey = (key) => String(key)
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toLowerCase();

      function parseEvidence(ac) {
        const raw = (ac && (ac.detail || ac.result)) ? String(ac.detail || ac.result) : '';
        const failing = [];
        const passing = [];
        const notes = [];
        const adapters = [];
        for (const segment of raw.split(';')) {
          const s = segment.trim();
          if (!s) continue;
          const m = /^([A-Za-z0-9._-]+):\\s*([a-z]+)\\s*(?:—|-)\\s*(.*)$/i.exec(s);
          let body = s;
          if (m) {
            adapters.push({ name: m[1], status: m[2].toLowerCase() });
            body = m[3].trim();
          }
          if (!body) continue;
          for (const token of body.split(',')) {
            const t = token.trim();
            if (!t) continue;
            const kv = /^([A-Za-z0-9_.-]+)=(true|false)$/i.exec(t);
            if (kv) {
              if (kv[2].toLowerCase() === 'false') failing.push(kv[1]);
              else passing.push(kv[1]);
            } else {
              notes.push(t);
            }
          }
        }
        return { failing, passing, notes, adapters, raw };
      }

      function renderEvidenceChips(ac, showAll, compactForPass = false) {
        const parsed = parseEvidence(ac);
        const container = el('div', { className: 'ev-box' });
        const hasStructured = parsed.failing.length > 0 || parsed.passing.length > 0;

        if (!hasStructured) {
          if (parsed.notes.length) {
            const list = el('div', { className: 'ev-chips' }, parsed.notes.map(n =>
              el('span', { className: 'ev-chip ' + (ac.status === 'fail' ? 'ev-chip-fail' : ac.status === 'blocked' ? 'ev-chip-warn' : 'ev-chip-note'), text: n })
            ));
            container.appendChild(list);
          } else if (showAll && parsed.raw) {
            container.appendChild(el('div', { className: 'cmp-detail mono', text: parsed.raw }));
          }
          return container;
        }

        const chips = [];
        for (const k of parsed.failing) {
          chips.push(el('span', { className: 'ev-chip ev-chip-fail', title: k + '=false', text: '✗ ' + humanizeKey(k) }));
        }
        for (const n of parsed.notes) {
          chips.push(el('span', { className: 'ev-chip ev-chip-note', text: n }));
        }

        if (showAll) {
          for (const k of parsed.passing) {
            chips.push(el('span', { className: 'ev-chip ev-chip-pass', title: k + '=true', text: '✓ ' + humanizeKey(k) }));
          }
          if (chips.length) container.appendChild(el('div', { className: 'ev-chips' }, chips));
          return container;
        }

        if (chips.length) container.appendChild(el('div', { className: 'ev-chips' }, chips));
        if (parsed.passing.length > 0 && (!compactForPass || parsed.failing.length > 0)) {
          const details = el('details', { className: 'ev-more' }, [
            el('summary', { text: '+' + parsed.passing.length + ' passed check' + (parsed.passing.length === 1 ? '' : 's') }),
            el('div', { className: 'ev-chips', style: { marginTop: '6px' } }, parsed.passing.map(k =>
              el('span', { className: 'ev-chip ev-chip-pass', title: k + '=true', text: '✓ ' + humanizeKey(k) })
            )),
          ]);
          container.appendChild(details);
        } else if (parsed.passing.length > 0 && compactForPass) {
          const details = el('details', { className: 'ev-more' }, [
            el('summary', { text: parsed.passing.length + ' check' + (parsed.passing.length === 1 ? '' : 's') + ' verified' }),
            el('div', { className: 'ev-chips', style: { marginTop: '6px' } }, parsed.passing.map(k =>
              el('span', { className: 'ev-chip ev-chip-pass', title: k + '=true', text: '✓ ' + humanizeKey(k) })
            )),
          ]);
          container.appendChild(details);
        }
        return container;
      }

      function hasActiveFilters() {
        const defaultScope = hasAnyComplete ? 'complete' : 'all';
        return state.ticket !== 'all' || state.status !== 'all' || state.mode !== 'all' || state.scope !== defaultScope || state.search.trim() !== '';
      }

      function resetFilters() {
        state.ticket = 'all';
        state.status = 'all';
        state.mode = 'all';
        state.scope = hasAnyComplete ? 'complete' : 'all';
        state.search = '';
        state.acFilter = 'all';
        state.compareVerdictFilter = 'all';
        document.getElementById('searchInput').value = '';
        document.getElementById('statusFilter').value = 'all';
        document.getElementById('modeFilter').value = 'all';
        document.getElementById('scopeFilter').value = state.scope;
        render();
      }

      function filteredRuns() {
        const q = state.search.trim().toLowerCase();
        return RUNS.filter(run => {
          if (state.ticket !== 'all' && run.ticket !== state.ticket) return false;
          if (state.status !== 'all' && run.status !== state.status) return false;
          if (state.mode !== 'all' && run.type !== state.mode) return false;
          if (state.scope === 'complete' && !isCompleteRun(run)) return false;
          if (state.scope === 'partial' && isCompleteRun(run)) return false;
          if (q) {
            const hay = [
              run.ticket,
              run.id,
              run.role || '',
              run.branch || '',
              run.runtime || '',
              run.proofDigest || '',
              runTargetLabel(run),
              ...run.worktrees.map(w => w.app + ' ' + w.sha + ' ' + (w.branch || '')),
              ...Object.values(run.urls || {}),
              ...(run.contextKeys || []),
              ...(run.notes || []),
              ...(run.issues || []),
              ...run.acs.map(a => a.id + ' ' + a.claim + ' ' + a.result),
            ].join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
      }

      function selectRun(key, switchToInspect, restoreSelector) {
        if (state.selectedKey !== key) {
          state.selectedKey = key;
          state.acFilter = 'all';
        }
        if (switchToInspect) state.activeTab = 'inspect';
        render(restoreSelector);
      }

      function autoPickCompareRuns(ticketName, ticketRuns) {
        if (ticketRuns.length < 2) {
          const single = ticketRuns[0] ? runKey(ticketRuns[0]) : null;
          return [single, single];
        }
        const t = ticketMap.get(ticketName);
        if (t?.comparePair?.baseId && t?.comparePair?.featureId) {
          const bKey = ticketName + '/' + t.comparePair.baseId;
          const fKey = ticketName + '/' + t.comparePair.featureId;
          const keys = new Set(ticketRuns.map(runKey));
          if (keys.has(bKey) && keys.has(fKey)) return [bKey, fKey];
        }
        const complete = ticketRuns.filter(isCompleteRun);
        const pool = complete.length >= 2 ? complete : ticketRuns;
        const feature = pool[0];
        const featKey = runTargetLabel(feature);
        const base = pool.find(r => runKey(r) !== runKey(feature) && runTargetLabel(r) !== featKey) || pool[1];
        return [runKey(base), runKey(feature)];
      }

      function classifyDelta(bs, fs) {
        if (bs === 'na' || fs === 'na') return { key: 'skipped', text: bs === fs ? 'N/A' : bs + ' → ' + fs, pill: 'pill-skipped', changed: bs !== fs };
        if (bs === 'skipped' && fs === 'skipped') return { key: 'skipped', text: 'Skipped', pill: 'pill-skipped', changed: false };
        if (bs === 'skipped') return { key: 'skipped', text: 'Skipped in base', pill: 'pill-skipped', changed: true };
        if (fs === 'skipped') return { key: 'skipped', text: 'Skipped in feature', pill: 'pill-skipped', changed: true };
        if (bs === 'missing' || fs === 'missing') return { key: 'skipped', text: bs + ' → ' + fs, pill: 'pill-muted', changed: true };
        if (bs !== 'pass' && fs === 'pass') return { key: 'delivered', text: 'Delivered', pill: 'pill-pass', changed: true };
        if (bs === 'pass' && fs !== 'pass') return { key: 'regression', text: 'Regression', pill: 'pill-fail', changed: true };
        if (bs === 'pass' && fs === 'pass') return { key: 'holds', text: 'Holds', pill: 'pill-info', changed: false };
        if (bs === 'fail' && fs === 'fail') return { key: 'notMet', text: 'Not met', pill: 'pill-fail', changed: false };
        if (fs === 'fail') return { key: 'regression', text: 'Regression', pill: 'pill-fail', changed: true };
        return { key: 'other', text: bs + ' → ' + fs, pill: 'pill-blocked', changed: bs !== fs };
      }

      function renderKpis(list) {
        const grid = document.getElementById('kpiGrid');
        grid.textContent = '';

        const activeTicket = state.ticket !== 'all' ? ticketMap.get(state.ticket) : null;
        const visibleTickets = activeTicket
          ? [activeTicket]
          : TICKETS.filter(t => list.some(r => r.ticket === t.ticket));

        // 1. Verdict / Ticket Readiness card
        let verdictCard;
        if (activeTicket) {
          const vc = activeTicket.verdictCounts;
          const pCounts = activeTicket.primaryCounts || activeTicket.latestCounts || { pass: 0, total: 0 };
          const pct = passPercent(pCounts);
          const status = activeTicket.primaryStatus || activeTicket.latestStatus;
          let headline = status === 'pass' ? 'All ACs Pass' : status === 'fail' ? 'Needs Work' : status;
          let accent = status === 'pass' ? 'var(--emerald)' : status === 'fail' ? 'var(--rose)' : 'var(--amber)';
          let sub = formatAcRatio(pCounts) + ' passing';
          if (vc && activeTicket.comparePair?.source === 'git') {
            if (vc.regression > 0) {
              headline = vc.regression + ' Regression' + (vc.regression === 1 ? '' : 's');
              accent = 'var(--rose)';
            } else if (vc.delivered > 0 && vc.notMet === 0) {
              headline = vc.delivered + ' Delivered';
              accent = 'var(--emerald)';
            } else if (vc.notMet > 0) {
              headline = vc.notMet + ' Not Met';
              accent = 'var(--rose)';
            } else {
              headline = 'All Held';
              accent = 'var(--sky)';
            }
            sub = vc.delivered + ' delivered · ' + vc.holds + ' holds · ' + vc.regression + ' regressed';
          }
          verdictCard = el('div', { className: 'kpi kpi-hero', style: { '--accent': accent } }, [
            svgRing(pct, accent, 52, 5),
            el('div', { className: 'kpi-body' }, [
              el('div', { className: 'kpi-label', text: activeTicket.ticket + ' Verdict' }),
              el('div', { className: 'kpi-value', text: headline }),
              el('div', { className: 'kpi-sub', text: sub }),
            ]),
          ]);
        } else {
          const greenTickets = visibleTickets.filter(t => (t.primaryStatus || t.latestStatus) === 'pass').length;
          const totalTickets = visibleTickets.length;
          const pct = totalTickets ? (greenTickets / totalTickets) * 100 : 0;
          const accent = totalTickets && greenTickets === totalTickets ? 'var(--emerald)' : pct >= 50 ? 'var(--sky)' : 'var(--amber)';
          verdictCard = el('div', { className: 'kpi kpi-hero', style: { '--accent': accent } }, [
            svgRing(pct, accent, 52, 5, totalTickets ? greenTickets + '/' + totalTickets : '0'),
            el('div', { className: 'kpi-body' }, [
              el('div', { className: 'kpi-label', text: 'Tickets Green' }),
              el('div', { className: 'kpi-value', text: totalTickets ? greenTickets + ' of ' + totalTickets : 'n/a' }),
              el('div', { className: 'kpi-sub', text: 'based on feature / latest complete run' }),
            ]),
          ]);
        }

        // 2. AC Coverage card (primary/feature run per ticket, never deflated by expected base failures)
        let acPass = 0, acFail = 0, acBlocked = 0, acSkipped = 0, acTotal = 0;
        for (const t of visibleTickets) {
          const c = t.primaryCounts || t.latestCounts || {};
          acPass += c.pass || 0;
          acFail += c.fail || 0;
          acBlocked += (c.blocked || 0) + (c.uncovered || 0);
          acSkipped += (c.skipped || 0) + (c.na || 0) + (c.unknown || 0);
          acTotal += c.total || 0;
        }
        const acPct = acTotal ? Math.round((acPass / acTotal) * 100) : 0;
        const acCard = el('div', { className: 'kpi', style: { '--accent': acFail ? 'var(--rose)' : 'var(--emerald)' } }, [
          el('div', { className: 'kpi-top-row' }, [
            el('div', { className: 'kpi-label', text: activeTicket ? 'Feature AC Coverage' : 'AC Coverage' }),
            el('span', { className: 'kpi-pct mono', text: acTotal ? acPct + '%' : 'n/a' }),
          ]),
          el('div', { className: 'kpi-value', text: acTotal ? acPass + ' / ' + acTotal : 'n/a' }),
          acSegBar({ pass: acPass, fail: acFail, blocked: acBlocked, skipped: acSkipped, total: acTotal }, 7),
          el('div', { className: 'kpi-sub', text: acPass + ' pass · ' + acFail + ' fail' + (acBlocked ? ' · ' + acBlocked + ' blocked' : '') }),
        ]);

        // 3. Proof Runs card (clean vs authoring/debug)
        const scopeRuns = activeTicket ? RUNS.filter(r => r.ticket === activeTicket.ticket) : RUNS;
        const cleanRuns = scopeRuns.filter(isCompleteRun);
        const noisyCount = scopeRuns.length - cleanRuns.length;
        const runsCard = el('div', { className: 'kpi', style: { '--accent': 'var(--indigo)' } }, [
          el('div', { className: 'kpi-label', text: 'Clean Proof Runs' }),
          el('div', { className: 'kpi-value', text: String(cleanRuns.length) }),
          el('div', { className: 'kpi-sub', text: noisyCount ? '+' + noisyCount + ' partial/debug · ' + list.length + ' shown' : list.length + ' shown in list' }),
        ]);

        // 4. Typical Run Timing card (with quick chart toggle)
        const timedPool = (cleanRuns.length ? cleanRuns : list).filter(r => Number.isFinite(r.durationMs) && r.durationMs > 0);
        const avgMs = timedPool.length ? Math.round(timedPool.reduce((s, r) => s + r.durationMs, 0) / timedPool.length) : null;
        const avgStartup = timedPool.length ? Math.round(timedPool.reduce((s, r) => s + (r.timings?.startupMs || 0), 0) / timedPool.length) : 0;
        const avgAdapters = timedPool.length ? Math.round(timedPool.reduce((s, r) => s + Object.values(r.timings?.adapters || {}).reduce((a, b) => a + b, 0), 0) / timedPool.length) : 0;
        const avgTeardown = timedPool.length ? Math.round(timedPool.reduce((s, r) => s + (r.timings?.teardownMs || 0), 0) / timedPool.length) : 0;
        const phaseSum = avgStartup + avgAdapters + avgTeardown;
        const miniPhase = el('div', { className: 'seg-bar', style: { height: '7px' } });
        if (phaseSum > 0) {
          for (const [label, ms, color] of [['Startup', avgStartup, '#38bdf8'], ['Checks', avgAdapters, '#818cf8'], ['Teardown', avgTeardown, '#fbbf24']]) {
            if (!ms) continue;
            miniPhase.appendChild(el('span', { className: 'seg-fill', style: { width: ((ms / phaseSum) * 100).toFixed(2) + '%', background: color }, title: label + ': ' + fmtDur(ms) }));
          }
        }
        const timingCard = el('div', { className: 'kpi', style: { '--accent': 'var(--violet)' } }, [
          el('div', { className: 'kpi-top-row' }, [
            el('div', { className: 'kpi-label', text: 'Avg Run Duration' }),
            el('button', {
              className: 'link-btn',
              text: state.timingExpanded ? 'Hide chart' : 'Chart ▾',
              onClick: () => { state.timingExpanded = !state.timingExpanded; render(); },
            }),
          ]),
          el('div', { className: 'kpi-value', text: fmtDur(avgMs) }),
          phaseSum > 0 ? miniPhase : null,
          el('div', { className: 'kpi-sub', text: phaseSum > 0 ? 'setup ' + fmtDur(avgStartup) + ' · checks ' + fmtDur(avgAdapters) : timedPool.length + ' timed run(s)' }),
        ]);

        for (const card of [verdictCard, acCard, runsCard, timingCard]) grid.appendChild(card);
      }

      function renderTimingChart(list) {
        const panel = document.getElementById('timingPanel');
        const wrap = document.getElementById('timingChart');
        const legend = document.getElementById('timingLegend');
        const caption = document.getElementById('chartCaption');
        const toggleBtn = document.getElementById('timingToggle');
        wrap.textContent = '';
        legend.textContent = '';

        const timed = list.filter(r => Number.isFinite(r.durationMs) && r.durationMs > 0).slice(0, 18).reverse();
        caption.textContent = timed.length + ' timed run(s)';
        toggleBtn.textContent = state.timingExpanded ? 'Hide chart' : 'Show chart';
        toggleBtn.setAttribute('aria-expanded', String(state.timingExpanded));
        panel.classList.toggle('panel-compact', !state.timingExpanded);
        wrap.style.display = state.timingExpanded ? '' : 'none';
        legend.style.display = state.timingExpanded ? '' : 'none';
        if (!state.timingExpanded) return;

        if (!timed.length) {
          wrap.appendChild(el('div', { className: 'empty empty-compact', text: 'Run timing bars appear here once runs include durationMs or a report Duration line.' }));
          return;
        }

        const legendMap = new Map();
        let hasOther = false;
        let hasTotalOnly = false;
        const prepared = timed.map(run => {
          const segs = extractPhaseSegments(run);
          const segTotal = segs.reduce((a, b) => a + b.ms, 0);
          const barSegs = [...segs];
          if (!barSegs.length) {
            barSegs.push({ key: 'total', ms: run.durationMs, color: '#64748b' });
            hasTotalOnly = true;
          } else {
            for (const s of barSegs) legendMap.set(s.key, s.color);
            if (run.durationMs > segTotal) {
              barSegs.push({ key: 'other', ms: run.durationMs - segTotal, color: '#475569' });
              hasOther = true;
            }
          }
          const totalMs = Math.max(run.durationMs, barSegs.reduce((a, b) => a + b.ms, 0));
          return { run, segs: barSegs, totalMs };
        });

        for (const [key, color] of legendMap.entries()) {
          legend.appendChild(el('span', {}, [el('span', { className: 'swatch', style: { background: color } }), key]));
        }
        if (hasOther) legend.appendChild(el('span', {}, [el('span', { className: 'swatch', style: { background: '#475569' } }), 'other']));
        if (hasTotalOnly) legend.appendChild(el('span', {}, [el('span', { className: 'swatch', style: { background: '#64748b' } }), 'total']));

        const maxMs = Math.max(...prepared.map(p => p.totalMs), 1000);
        const singleTicket = new Set(timed.map(r => r.ticket)).size === 1;
        const barW = 46, gap = 14, padL = 62, padR = 16, padT = 16, chartH = 114, padB = 38;
        const width = Math.max(640, padL + padR + prepared.length * (barW + gap));
        const height = padT + chartH + padB;
        const svg = sEl('svg', {
          viewBox: '0 0 ' + width + ' ' + height,
          width: String(width),
          height: String(height),
          role: 'img',
          'aria-label': 'Stacked phase duration chart for recent proof runs',
        });
        svg.style.display = 'block';

        for (let i = 0; i <= 2; i++) {
          const y = padT + Math.round((chartH * i) / 2);
          svg.appendChild(sEl('line', { x1: padL, y1: y, x2: width - padR, y2: y, stroke: 'rgba(148,163,184,0.16)', 'stroke-dasharray': '3 4' }));
          const labelVal = Math.round(((2 - i) / 2) * maxMs);
          const lbl = sEl('text', { x: padL - 8, y: y + 3, fill: '#94a3b8', 'font-size': 10, 'font-family': 'monospace', 'text-anchor': 'end' });
          lbl.textContent = fmtDur(labelVal);
          svg.appendChild(lbl);
        }

        prepared.forEach(({ run, segs, totalMs }, idx) => {
          const x = padL + idx * (barW + gap);
          const key = runKey(run);
          const isSelected = key === state.selectedKey;
          const focusWt = changedWorktrees(run)[0] || run.worktrees[0];
          const barLabel = run.ticket + (run.role ? ' [' + run.role + ']' : '') + ' (' + run.status + '), ' + runBranchHeadline(run) + ', ' + fmtDur(run.durationMs) + ', ' + fmtTime(run.startedAt);
          const g = sEl('g', {
            class: 'svg-bar',
            tabindex: '0',
            role: 'button',
            'aria-label': 'Inspect ' + barLabel,
          });
          const activate = () => selectRun(key, true);
          g.addEventListener('click', activate);
          g.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
          });

          const totalBarH = Math.max(4, Math.min(chartH, Math.round((totalMs / maxMs) * chartH)));
          const sumSegMs = segs.reduce((a, b) => a + b.ms, 0) || 1;
          let yCursor = padT + chartH;
          const topLimit = padT + chartH - totalBarH;
          segs.forEach((seg, sIdx) => {
            const rawH = sIdx === segs.length - 1
              ? Math.max(1, yCursor - topLimit)
              : Math.max(1, Math.round((seg.ms / sumSegMs) * totalBarH));
            const h = Math.min(rawH, Math.max(0, yCursor - padT));
            if (h <= 0) return;
            yCursor -= h;
            g.appendChild(sEl('rect', {
              x, y: yCursor, width: barW, height: h, rx: 3,
              fill: seg.color,
              opacity: isSelected ? '1' : '0.84',
            }));
          });

          if (isSelected) {
            g.appendChild(sEl('rect', {
              x: x - 2, y: yCursor - 2, width: barW + 4, height: (padT + chartH) - yCursor + 4,
              fill: 'none', stroke: '#f8fafc', 'stroke-width': 1.5, rx: 4,
            }));
          }

          const dotColor = run.status === 'pass' ? '#34d399' : run.status === 'blocked' ? '#fbbf24' : '#fb7185';
          g.appendChild(sEl('circle', { cx: x + barW / 2, cy: padT + chartH + 11, r: 3.3, fill: dotColor }));

          let xText = run.ticket.length > 10 ? run.ticket.slice(0, 8).replace(/-$/, '') + '…' : run.ticket;
          if (singleTicket) {
            if (run.role) xText = run.role;
            else if (focusWt?.sha) xText = '@' + shortSha(focusWt.sha);
            else xText = fmtClock(run.startedAt) || run.id.slice(0, 6);
          }
          const lbl = sEl('text', {
            x: x + barW / 2, y: padT + chartH + 27,
            fill: run.role === 'feature' ? '#7dd3fc' : '#cbd5e1',
            'font-size': 9.5, 'font-family': 'monospace', 'text-anchor': 'middle',
          });
          lbl.textContent = xText;
          g.appendChild(lbl);

          const title = document.createElementNS(SVG_NS, 'title');
          title.textContent = barLabel;
          g.appendChild(title);
          svg.appendChild(g);
        });

        wrap.appendChild(svg);
      }

      function renderTicketCards() {
        const bar = document.getElementById('ticketChips');
        const meta = document.getElementById('ticketCountMeta');
        bar.textContent = '';
        const cleanTotal = RUNS.filter(isCompleteRun).length;
        meta.textContent = TICKETS.length + ' ticket(s) · ' + cleanTotal + ' clean run(s)' + (RUNS.length > cleanTotal ? ' (+' + (RUNS.length - cleanTotal) + ' dev)' : '');

        const selectTicket = (id) => {
          state.ticket = id;
          state.acFilter = 'all';
          state.compareVerdictFilter = 'all';
          state.compareBaseKey = null;
          state.compareFeatureKey = null;
          if (id !== 'all') {
            const t = ticketMap.get(id);
            if (t?.primaryRunId) state.selectedKey = id + '/' + t.primaryRunId;
          }
          render('[data-ticket-chip="' + CSS.escape(id) + '"]');
        };

        const allActive = state.ticket === 'all';
        bar.appendChild(el('button', {
          className: 'tcard tcard-all' + (allActive ? ' active' : ''),
          'aria-pressed': String(allActive),
          'data-ticket-chip': 'all',
          onClick: () => selectTicket('all'),
        }, [
          el('div', { className: 'tcard-top' }, [
            el('span', { className: 'tcard-name', text: 'All tickets' }),
            el('span', { className: 'pill pill-muted', text: String(TICKETS.length) }),
          ]),
          el('div', { className: 'tcard-foot', text: RUNS.length + ' total runs' }),
        ]));

        for (const t of TICKETS) {
          const active = state.ticket === t.ticket;
          const pStatus = t.primaryStatus || t.latestStatus;
          const pCounts = t.primaryCounts || t.latestCounts || { pass: 0, total: 0 };
          const vc = t.verdictCounts;
          let deltaPill = null;
          if (vc && t.comparePair?.source === 'git') {
            if (vc.regression > 0) deltaPill = el('span', { className: 'pill pill-fail', text: vc.regression + ' regressed' });
            else if (vc.delivered > 0) deltaPill = el('span', { className: 'pill pill-pass', text: '+' + vc.delivered + ' delivered' });
            else deltaPill = el('span', { className: 'pill pill-info', text: 'all held' });
          }
          const card = el('button', {
            className: 'tcard' + (active ? ' active' : '') + ' tcard-' + pStatus,
            'aria-pressed': String(active),
            'data-ticket-chip': t.ticket,
            onClick: () => selectTicket(t.ticket),
          }, [
            el('div', { className: 'tcard-top' }, [
              el('span', { className: 'tcard-name mono', text: t.ticket }),
              statusPill(pStatus),
            ]),
            acSegBar(pCounts, 5),
            el('div', { className: 'tcard-foot' }, [
              el('span', { className: 'mono', text: formatAcRatio(pCounts) }),
              deltaPill || el('span', { text: (t.completeCount ?? t.runCount) + ' run' + ((t.completeCount ?? t.runCount) === 1 ? '' : 's') }),
            ]),
          ]);
          bar.appendChild(card);
        }
      }

      function renderRunList(list) {
        const container = document.getElementById('runList');
        const meta = document.getElementById('runListMeta');
        container.textContent = '';

        const ticketTotal = state.ticket === 'all' ? RUNS.length : RUNS.filter(r => r.ticket === state.ticket).length;
        const hiddenNoisy = state.scope === 'complete'
          ? (state.ticket === 'all' ? RUNS : RUNS.filter(r => r.ticket === state.ticket)).filter(r => !isCompleteRun(r)).length
          : 0;
        meta.textContent = list.length + (ticketTotal !== list.length ? ' of ' + ticketTotal : '') + ' shown';

        if (!list.length) {
          container.appendChild(el('div', { className: 'empty' }, [
            el('div', { text: 'No runs match the current filters.' }),
            hasActiveFilters() || hiddenNoisy > 0 ? el('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', justifyContent: 'center' } }, [
              hiddenNoisy > 0 ? el('button', {
                className: 'btn btn-primary',
                text: 'Show all (' + hiddenNoisy + ' partial/debug)',
                onClick: () => { state.scope = 'all'; document.getElementById('scopeFilter').value = 'all'; render(); },
              }) : null,
              hasActiveFilters() ? el('button', { className: 'btn', text: 'Reset filters', onClick: resetFilters }) : null,
            ]) : null,
          ]));
          return;
        }

        list.forEach((run, idx) => {
          const key = runKey(run);
          const selected = key === state.selectedKey;
          const badges = [];
          const rp = rolePill(run.role);
          if (rp) badges.push(rp);
          badges.push(statusPill(run.status, statusLabel(run)));
          if (run.partial) badges.push(el('span', { className: 'pill pill-muted', text: 'partial' }));
          if (run.debug) badges.push(el('span', { className: 'pill pill-muted', text: 'debug' }));

          const item = el('button', {
            className: 'run-item' + (selected ? ' selected' : '') + (run.role ? ' run-role-' + run.role : ''),
            style: { '--i': String(Math.min(idx, 12)) },
            'aria-current': selected ? 'true' : null,
            'data-run-key': key,
            onClick: () => selectRun(key, true, '[data-run-key="' + CSS.escape(key) + '"]'),
          }, [
            el('div', { className: 'run-item-top' }, [
              el('span', { className: 'run-ticket', text: state.ticket === 'all' ? run.ticket : runBranchHeadline(run) }),
              el('span', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'flex-end' } }, badges),
            ]),
            el('div', { className: 'run-target mono', text: runCompactTarget(run) }),
            acSegBar(run.counts, 4),
            el('div', { className: 'run-sub' }, [
              el('span', { text: formatAcRatio(run.counts) }),
              el('span', { text: '·' }),
              el('span', { text: runDur(run) }),
              el('span', { text: '·' }),
              el('span', { text: fmtTime(run.startedAt) }),
            ]),
          ]);
          container.appendChild(item);
        });

        if (hiddenNoisy > 0) {
          container.appendChild(el('div', { className: 'list-footnote' }, [
            el('span', { text: hiddenNoisy + ' partial/debug run' + (hiddenNoisy === 1 ? '' : 's') + ' hidden' }),
            el('button', {
              className: 'link-btn',
              text: 'Show all',
              onClick: () => { state.scope = 'all'; document.getElementById('scopeFilter').value = 'all'; render(); },
            }),
          ]));
        }
      }

      function renderInspect(run) {
        const body = document.getElementById('detailBody');
        body.textContent = '';
        if (!run) {
          body.appendChild(el('div', { className: 'empty', text: 'Select a run on the left to inspect its acceptance criteria and metadata.' }));
          return;
        }

        const ticketRuns = RUNS.filter(r => r.ticket === run.ticket);
        const partialBadgeText = run.selectedAcs.length ? 'partial: ' + run.selectedAcs.join(', ') : 'partial (--ac)';
        const pct = passPercent(run.counts);
        const ringColor = run.status === 'pass' ? 'var(--emerald)' : run.status === 'fail' ? 'var(--rose)' : 'var(--amber)';

        const headerRow = el('div', { className: 'detail-header-row' }, [
          el('div', { className: 'inspect-title-group' }, [
            svgRing(pct, ringColor, 50, 5),
            el('div', {}, [
              el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '7px', alignItems: 'center' } }, [
                el('strong', { className: 'mono', style: { fontSize: '1rem' }, text: run.ticket }),
                rolePill(run.role),
                statusPill(run.status, inProgress(run) ? statusLabel(run) : run.status.toUpperCase()),
                el('span', { className: 'pill pill-muted', text: run.type }),
                run.partial ? el('span', { className: 'pill pill-blocked', text: partialBadgeText }) : null,
                run.debug ? el('span', { className: 'pill pill-muted', text: '--debug' }) : null,
              ]),
              el('div', { className: 'inspect-sub mono', text: runCompactTarget(run) + ' · ' + fmtTime(run.startedAt) + ' · ' + runDur(run) }),
            ]),
          ]),
          el('div', { className: 'controls' }, [
            ticketRuns.length >= 2 ? el('button', {
              className: 'btn btn-primary',
              text: 'Compare Base → Feature',
              onClick: () => {
                const [b, f] = autoPickCompareRuns(run.ticket, ticketRuns);
                state.compareBaseKey = b;
                state.compareFeatureKey = f;
                state.activeTab = 'compare';
                render();
              },
            }) : null,
          ]),
        ]);
        body.appendChild(headerRow);

        body.appendChild(acSegBar(run.counts, 8));

        if (run.reportMissing) {
          body.appendChild(el('div', { className: 'callout callout-warn', text: 'report.md was not found on disk (or failed safety checks) for this indexed run.' }));
        }
        if (run.issues.length) {
          body.appendChild(el('div', { className: 'callout callout-err' }, [
            el('strong', { text: 'Run Issues (' + run.issues.length + ')' }),
            el('ul', {}, run.issues.map(i => el('li', { text: i }))),
          ]));
        }
        if (run.notes.length) {
          body.appendChild(el('div', { className: 'callout' }, [
            el('strong', { text: 'Execution Notes' }),
            el('ul', {}, run.notes.map(n => el('li', { text: n }))),
          ]));
        }

        const filterOpts = [
          ['all', 'All (' + run.counts.total + ')'],
          ['pass', 'Pass (' + run.counts.pass + ')'],
          ['fail', 'Fail (' + run.counts.fail + ')'],
          ['blocked', 'Blocked (' + run.counts.blocked + ')'],
          ['uncovered', 'Uncovered (' + run.counts.uncovered + ')'],
          ['skipped', 'Skipped (' + run.counts.skipped + ')'],
          ['na', 'N/A (' + (run.counts.na || 0) + ')'],
        ].filter(([k]) => k === 'all' || (run.counts[k] || 0) > 0);
        if ((run.counts.unknown || 0) > 0) filterOpts.push(['unknown', 'Unknown (' + run.counts.unknown + ')']);

        if (state.acFilter !== 'all' && !run.acs.some(a => a.status === state.acFilter) && run.acs.length > 0) {
          state.acFilter = 'all';
        }

        body.appendChild(el('div', { className: 'toolbar-row' }, [
          el('div', { className: 'controls' }, filterOpts.map(([key, label]) =>
            el('button', {
              className: 'chip' + (state.acFilter === key ? ' active' : ''),
              'aria-pressed': String(state.acFilter === key),
              'data-ac-filter': key,
              onClick: () => {
                state.acFilter = key;
                renderInspect(run);
                const focusEl = document.querySelector('[data-ac-filter="' + CSS.escape(key) + '"]');
                if (focusEl) focusEl.focus();
              },
              text: label,
            })
          )),
          el('button', {
            className: 'chip' + (state.inspectShowDetails ? ' active' : ''),
            'aria-pressed': String(state.inspectShowDetails),
            text: state.inspectShowDetails ? '✓ Full evidence' : 'Full evidence',
            onClick: () => { state.inspectShowDetails = !state.inspectShowDetails; renderInspect(run); },
          }),
        ]));

        const acsShown = state.acFilter === 'all' ? run.acs : run.acs.filter(a => a.status === state.acFilter);
        if (!acsShown.length) {
          body.appendChild(el('div', { className: 'empty', text: 'No acceptance criteria in this filter.' }));
        } else {
          const table = el('table', { className: 'ac-table' }, [
            el('thead', {}, el('tr', {}, [
              el('th', { style: { width: '74px' }, text: 'AC' }),
              el('th', { style: { width: '94px' }, text: 'Status' }),
              el('th', { text: 'Acceptance Criterion' }),
              el('th', { style: { width: '34%' }, text: 'Checks' }),
            ])),
            el('tbody', {}, acsShown.map((ac, idx) => el('tr', { className: 'ac-row row-' + ac.status, style: { '--i': String(Math.min(idx, 14)) } }, [
              el('td', { className: 'mono ac-id', text: ac.id }),
              el('td', {}, statusPill(ac.status)),
              el('td', { text: ac.claim || 'n/a' }),
              el('td', {}, renderEvidenceChips(ac, state.inspectShowDetails, true)),
            ]))),
          ]);
          body.appendChild(el('div', { className: 'table-wrap' }, table));
        }

        // Collapsible provenance & technical details — full information preserved, zero clutter.
        let targetText = 'n/a';
        if (run.type === 'worktree') {
          targetText = run.worktrees.map(w => w.app + ': ' + (w.sha || 'unknown') + (w.branch ? ' [' + w.branch + ']' : '') + (w.dirty ? ' (dirty)' : ' (clean)')).join('; ') || 'n/a';
        } else {
          const urlParts = Object.entries(run.urls || {}).map(([k, v]) => k + '=' + v);
          if (run.branch) urlParts.push('branch=' + run.branch);
          targetText = urlParts.join(' | ') || 'n/a';
        }
        const digestText = run.proofDigest ? 'sha256:' + run.proofDigest : 'unavailable';
        const ctxKeysText = (run.contextKeys && run.contextKeys.length) ? run.contextKeys.join(', ') : 'none';

        const metaGrid = el('div', { className: 'meta-grid' }, [
          el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k', text: run.type === 'worktree' ? 'Revisions' : 'Target Origins' }),
            el('div', { className: 'meta-v', text: targetText }),
          ]),
          run.command ? el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k-row' }, [
              el('span', { className: 'meta-k', text: 'Command' }),
              copyButton(run.command, 'Copy command'),
            ]),
            el('div', { className: 'meta-v', text: run.command }),
          ]) : null,
          el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k-row' }, [
              el('span', { className: 'meta-k', text: 'Proof Inputs Digest' }),
              run.proofDigest ? copyButton(digestText, 'Copy proof inputs digest') : null,
            ]),
            el('div', { className: 'meta-v', text: digestText }),
          ]),
          el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k-row' }, [
              el('span', { className: 'meta-k', text: 'Run ID / Environment' }),
              copyButton(run.id, 'Copy run ID'),
            ]),
            el('div', { className: 'meta-v', text: run.id }),
            el('div', { className: 'meta-v meta-sub', text: [
              run.profile ? 'profile: ' + run.profile : null,
              run.persona ? 'persona: ' + run.persona : null,
              run.sourceName ? 'source: ' + run.sourceName : null,
              'runtime: ' + (run.runtime || 'none'),
              'adapters: ' + (run.adapters.join(', ') || 'none'),
              'context keys: ' + ctxKeysText,
            ].filter(Boolean).join(' · ') }),
          ]),
          el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k-row' }, [
              el('span', { className: 'meta-k', text: 'Report Path' }),
              copyButton(run.report, 'Copy report path'),
            ]),
            el('div', { className: 'meta-v', text: run.report }),
            run.hasDiagnostics ? el('div', { className: 'meta-v meta-sub', text: 'Local 0o600 diagnostics/ present on disk (not embedded).' }) : null,
          ]),
        ]);

        const segs = extractPhaseSegments(run);
        let phaseBox = null;
        if (segs.length && Number.isFinite(run.durationMs) && run.durationMs > 0) {
          const segSum = segs.reduce((a, b) => a + b.ms, 0);
          const allParts = [...segs];
          if (run.durationMs > segSum) allParts.push({ key: 'other', ms: run.durationMs - segSum, color: '#475569' });
          const total = Math.max(run.durationMs, segSum);
          phaseBox = el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k', text: 'Phase Timing Breakdown (' + fmtDur(run.durationMs) + ')' }),
            el('div', { className: 'phase-bar' }, allParts.map(p =>
              el('div', { style: { width: ((p.ms / total) * 100).toFixed(2) + '%', background: p.color }, title: p.key + ': ' + fmtDur(p.ms) })
            )),
            el('div', { className: 'phase-legend' }, allParts.map(p =>
              el('span', {}, [el('span', { className: 'swatch', style: { background: p.color } }), p.key + ' ' + fmtDur(p.ms)])
            )),
          ]);
        }

        body.appendChild(el('details', { className: 'tech-details' }, [
          el('summary', { text: 'Provenance, revisions & technical details' }),
          el('div', { className: 'tech-body' }, [metaGrid, phaseBox]),
        ]));
      }

      function renderCompare(selectedRun, list) {
        const body = document.getElementById('detailBody');
        body.textContent = '';
        if (!list.length && state.ticket === 'all') {
          body.appendChild(el('div', { className: 'empty', text: 'No runs match the current filters. Reset filters or pick a ticket to compare runs.' }));
          return;
        }
        const ticketName = state.ticket !== 'all' ? state.ticket : (selectedRun ? selectedRun.ticket : null);
        const ticketRuns = ticketName ? RUNS.filter(r => r.ticket === ticketName) : [];
        if (ticketRuns.length < 2) {
          body.appendChild(el('div', { className: 'empty', text: 'Need at least 2 runs for ' + (ticketName || 'a ticket') + ' to compare Base vs Feature.' }));
          return;
        }
        const keys = new Set(ticketRuns.map(runKey));
        if (!keys.has(state.compareBaseKey) || !keys.has(state.compareFeatureKey)) {
          const [b, f] = autoPickCompareRuns(ticketName, ticketRuns);
          state.compareBaseKey = b;
          state.compareFeatureKey = f;
        }

        const base = ticketRuns.find(r => runKey(r) === state.compareBaseKey);
        const feat = ticketRuns.find(r => runKey(r) === state.compareFeatureKey);
        if (!base || !feat) return;

        const allAcIds = [];
        const seen = new Set();
        for (const a of [...base.acs, ...feat.acs]) {
          if (!seen.has(a.id)) { seen.add(a.id); allAcIds.push(a.id); }
        }
        const baseMap = new Map(base.acs.map(a => [a.id, a]));
        const featMap = new Map(feat.acs.map(a => [a.id, a]));

        const tally = { delivered: 0, holds: 0, notMet: 0, regression: 0, skipped: 0, other: 0 };
        const rows = allAcIds.map(id => {
          const b = baseMap.get(id);
          const f = featMap.get(id);
          const bs = b ? b.status : 'missing';
          const fs = f ? f.status : 'missing';
          const delta = classifyDelta(bs, fs);
          tally[delta.key] = (tally[delta.key] || 0) + 1;
          return { id, claim: (f && f.claim) || (b && b.claim) || '', b, f, delta };
        });

        const sameDigest = base.proofDigest && feat.proofDigest && base.proofDigest === feat.proofDigest;
        const makeOptLabel = (r) => {
          const roleTag = r.role ? '[' + r.role.toUpperCase() + '] ' : '';
          const tag = !isCompleteRun(r) ? ' (' + (r.partial ? '--ac' : 'debug') + ')' : '';
          return roleTag + runBranchHeadline(r) + ' · ' + r.counts.pass + '/' + r.counts.total + ' · ' + fmtTime(r.startedAt) + tag;
        };

        const baseSel = el('select', {
          id: 'compareBaseSelect',
          'aria-label': 'Base run',
          onChange: (e) => {
            state.compareBaseKey = e.target.value;
            writeHash();
            renderCompare(selectedRun, list);
            const node = document.getElementById('compareBaseSelect');
            if (node) node.focus();
          },
        }, ticketRuns.map(r => el('option', { value: runKey(r), text: makeOptLabel(r) })));
        baseSel.value = state.compareBaseKey;

        const featSel = el('select', {
          id: 'compareFeatSelect',
          'aria-label': 'Feature run',
          onChange: (e) => {
            state.compareFeatureKey = e.target.value;
            writeHash();
            renderCompare(selectedRun, list);
            const node = document.getElementById('compareFeatSelect');
            if (node) node.focus();
          },
        }, ticketRuns.map(r => el('option', { value: runKey(r), text: makeOptLabel(r) })));
        featSel.value = state.compareFeatureKey;

        const swapBtn = el('button', {
          className: 'btn btn-xs',
          text: '⇄ Swap',
          onClick: () => {
            const tmp = state.compareBaseKey;
            state.compareBaseKey = state.compareFeatureKey;
            state.compareFeatureKey = tmp;
            writeHash();
            renderCompare(selectedRun, list);
          },
        });
        const autoBtn = el('button', {
          className: 'btn btn-xs btn-primary',
          text: 'Auto-pick',
          onClick: () => {
            const [b, f] = autoPickCompareRuns(ticketName, ticketRuns);
            state.compareBaseKey = b;
            state.compareFeatureKey = f;
            writeHash();
            renderCompare(selectedRun, list);
          },
        });

        const basePct = passPercent(base.counts);
        const featPct = passPercent(feat.counts);
        const baseColor = base.status === 'pass' ? 'var(--emerald)' : base.status === 'fail' ? 'var(--rose)' : 'var(--amber)';
        const featColor = feat.status === 'pass' ? 'var(--emerald)' : feat.status === 'fail' ? 'var(--rose)' : 'var(--amber)';

        let heroHeadline = 'No changes';
        let heroTone = 'neutral';
        if (tally.regression > 0) {
          heroHeadline = tally.regression + ' Regression' + (tally.regression === 1 ? '' : 's');
          heroTone = 'bad';
        } else if (tally.delivered > 0 && tally.notMet === 0) {
          heroHeadline = tally.delivered + ' Delivered · All Pass';
          heroTone = 'good';
        } else if (tally.delivered > 0) {
          heroHeadline = tally.delivered + ' Delivered · ' + tally.notMet + ' Remaining';
          heroTone = 'warn';
        } else if (tally.notMet > 0) {
          heroHeadline = tally.notMet + ' Not Met';
          heroTone = 'bad';
        } else if (tally.holds > 0) {
          heroHeadline = 'All ' + tally.holds + ' Held';
          heroTone = 'info';
        }

        const sideCard = (label, run, pct, color, sel, sideCls) => el('div', { className: 'cmp-side ' + sideCls }, [
          el('div', { className: 'cmp-side-head' }, [
            el('span', { className: 'pill ' + (sideCls === 'cmp-side-feat' ? 'pill-feature' : 'pill-base'), text: label }),
            statusPill(run.status, run.counts.pass + '/' + run.counts.total + ' pass'),
          ]),
          el('div', { className: 'cmp-side-main' }, [
            svgRing(pct, color, 46, 4.5),
            el('div', { className: 'cmp-side-info' }, [
              el('div', { className: 'cmp-branch mono', text: runBranchHeadline(run) }),
              el('div', { className: 'cmp-meta mono', text: fmtTime(run.startedAt) + ' · ' + runDur(run) }),
            ]),
          ]),
          sel,
        ]);

        const flowCenter = el('div', { className: 'cmp-center cmp-tone-' + heroTone }, [
          el('div', { className: 'cmp-arrow', 'aria-hidden': 'true', text: '→' }),
          el('div', { className: 'cmp-verdict', text: heroHeadline }),
          el('span', {
            className: 'pill ' + (sameDigest ? 'pill-pass' : 'pill-blocked'),
            title: sameDigest ? 'sha256:' + base.proofDigest : 'Base: ' + (base.proofDigest || 'n/a') + ' | Feature: ' + (feat.proofDigest || 'n/a'),
            text: sameDigest ? '✓ Identical checks' : '⚠ Different checks',
          }),
          el('div', { className: 'controls', style: { justifyContent: 'center', marginTop: '4px' } }, [swapBtn, autoBtn]),
        ]);

        body.appendChild(el('div', { className: 'cmp-hero' }, [
          sideCard('BASE', base, basePct, baseColor, baseSel, 'cmp-side-base'),
          flowCenter,
          sideCard('FEATURE', feat, featPct, featColor, featSel, 'cmp-side-feat'),
        ]));

        // Compact changed-revisions strip for worktree comparisons.
        if (base.type === 'worktree' && feat.type === 'worktree') {
          const apps = [...new Set([...base.worktrees.map(w => w.app), ...feat.worktrees.map(w => w.app)])];
          const changed = [];
          const unchanged = [];
          for (const app of apps) {
            const bw = base.worktrees.find(w => w.app === app);
            const fw = feat.worktrees.find(w => w.app === app);
            if (bw?.sha && fw?.sha && bw.sha === fw.sha) {
              unchanged.push(app + '@' + shortSha(fw.sha));
            } else {
              changed.push({ app, bSha: shortSha(bw?.sha) || '?', fSha: shortSha(fw?.sha) || '?', bBr: bw?.branch, fBr: fw?.branch });
            }
          }
          if (changed.length || unchanged.length) {
            body.appendChild(el('div', { className: 'rev-strip' }, [
              ...changed.map(c => el('span', { className: 'rev-pill rev-changed mono' }, [
                el('strong', { text: c.app }),
                el('span', { text: ' ' + c.bSha + (c.bBr ? ' (' + c.bBr + ')' : '') + ' → ' + c.fSha + (c.fBr ? ' (' + c.fBr + ')' : '') }),
              ])),
              unchanged.length ? el('span', { className: 'rev-pill rev-same mono', text: 'Unchanged: ' + unchanged.join(', ') }) : null,
            ]));
          }
        }

        if (runKey(base) === runKey(feat)) {
          body.appendChild(el('div', { className: 'callout callout-warn', text: 'Base and Feature currently point to the same run.' }));
        }
        if (base.partial || feat.partial) {
          body.appendChild(el('div', {
            className: 'callout callout-warn',
            text: 'Partial run: at least one side used --ac filtering. Skipped ACs are excluded from delivery/regression counts.',
          }));
        }

        // Visual Verdict Distribution Bar
        const verdictBar = el('div', { className: 'seg-bar', style: { height: '9px' } });
        const totalRows = rows.length || 1;
        for (const [k, color, label] of [
          ['delivered', 'var(--emerald)', 'Delivered'],
          ['holds', 'var(--sky)', 'Holds'],
          ['notMet', 'var(--rose)', 'Not met'],
          ['regression', '#f43f5e', 'Regression'],
          ['other', 'var(--amber)', 'Other'],
          ['skipped', '#475569', 'Skipped / N/A'],
        ]) {
          if (!tally[k]) continue;
          verdictBar.appendChild(el('span', {
            className: 'seg-fill',
            style: { width: ((tally[k] / totalRows) * 100).toFixed(2) + '%', background: color },
            title: label + ': ' + tally[k] + '/' + rows.length,
          }));
        }
        body.appendChild(verdictBar);

        const verdictChips = [
          ['all', 'All (' + rows.length + ')', ''],
          ['delivered', 'Delivered (' + tally.delivered + ')', 'chip-pass'],
          ['holds', 'Holds (' + tally.holds + ')', 'chip-info'],
          ['notMet', 'Not met (' + tally.notMet + ')', 'chip-fail'],
          ['regression', 'Regression (' + tally.regression + ')', 'chip-fail'],
          ['skipped', 'Skipped / N/A (' + tally.skipped + ')', ''],
          ['other', 'Other (' + tally.other + ')', ''],
        ].filter(([k]) => k === 'all' || (tally[k] || 0) > 0);

        if (state.compareVerdictFilter !== 'all' && !tally[state.compareVerdictFilter]) {
          state.compareVerdictFilter = 'all';
        }

        body.appendChild(el('div', { className: 'toolbar-row' }, [
          el('div', { className: 'controls' }, verdictChips.map(([key, label, tone]) =>
            el('button', {
              className: 'chip ' + tone + (state.compareVerdictFilter === key ? ' active' : ''),
              'aria-pressed': String(state.compareVerdictFilter === key),
              onClick: () => { state.compareVerdictFilter = key; renderCompare(selectedRun, list); },
              text: label,
            })
          )),
          el('div', { className: 'controls' }, [
            el('button', {
              className: 'chip' + (state.compareChangedOnly ? ' active' : ''),
              'aria-pressed': String(state.compareChangedOnly),
              text: 'Changed only',
              onClick: () => { state.compareChangedOnly = !state.compareChangedOnly; renderCompare(selectedRun, list); },
            }),
            el('button', {
              className: 'chip' + (state.compareShowDetails ? ' active' : ''),
              'aria-pressed': String(state.compareShowDetails),
              text: state.compareShowDetails ? '✓ Full evidence' : 'Full evidence',
              onClick: () => { state.compareShowDetails = !state.compareShowDetails; renderCompare(selectedRun, list); },
            }),
          ]),
        ]));

        let shownRows = rows;
        if (state.compareVerdictFilter !== 'all') shownRows = shownRows.filter(r => r.delta.key === state.compareVerdictFilter);
        if (state.compareChangedOnly) shownRows = shownRows.filter(r => r.delta.changed);

        if (!shownRows.length) {
          body.appendChild(el('div', { className: 'empty', text: 'No acceptance criteria match this filter.' }));
          return;
        }

        const renderSideCell = (ac) => {
          if (!ac) return el('span', { className: 'pill pill-muted', text: 'missing' });
          const nodes = [statusPill(ac.status)];
          if (state.compareShowDetails || ac.status === 'fail' || ac.status === 'blocked') {
            nodes.push(renderEvidenceChips(ac, state.compareShowDetails, true));
          }
          return el('div', { className: 'cmp-cell' }, nodes);
        };

        const table = el('table', { className: 'ac-table' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { style: { width: '70px' }, text: 'AC' }),
            el('th', { text: 'Acceptance Criterion' }),
            el('th', { style: { width: '21%' }, text: 'Base' }),
            el('th', { style: { width: '21%' }, text: 'Feature' }),
            el('th', { style: { width: '115px' }, text: 'Verdict' }),
          ])),
          el('tbody', {}, shownRows.map((row, idx) => el('tr', {
            className: 'ac-row row-delta-' + row.delta.key,
            style: { '--i': String(Math.min(idx, 14)) },
          }, [
            el('td', { className: 'mono ac-id', text: row.id }),
            el('td', { text: row.claim }),
            el('td', {}, renderSideCell(row.b)),
            el('td', {}, renderSideCell(row.f)),
            el('td', {}, el('span', { className: 'pill ' + row.delta.pill, text: row.delta.text })),
          ]))),
        ]);
        body.appendChild(el('div', { className: 'table-wrap' }, table));
      }

      function render(restoreSelector) {
        const gen = document.getElementById('generatedMeta');
        gen.textContent = 'Updated ' + fmtTime(DATA.generatedAt);
        gen.setAttribute('title', DATA.generatedAt || '');

        document.getElementById('scopeFilter').value = state.scope;
        document.getElementById('resetFiltersBtn').style.display = hasActiveFilters() ? 'inline-flex' : 'none';

        const list = filteredRuns();
        if (list.length && !list.some(r => runKey(r) === state.selectedKey)) {
          const t = state.ticket !== 'all' ? ticketMap.get(state.ticket) : null;
          const primaryKey = t?.primaryRunId ? t.ticket + '/' + t.primaryRunId : null;
          state.selectedKey = (primaryKey && list.some(r => runKey(r) === primaryKey)) ? primaryKey : runKey(list[0]);
          state.acFilter = 'all';
        }
        const selected = list.find(r => runKey(r) === state.selectedKey) || RUNS.find(r => runKey(r) === state.selectedKey) || null;

        renderKpis(list);
        renderTimingChart(list);
        renderTicketCards();
        renderRunList(list);

        const tabInspect = document.getElementById('tabInspect');
        const tabCompare = document.getElementById('tabCompare');
        const detailBody = document.getElementById('detailBody');
        tabInspect.classList.toggle('active', state.activeTab === 'inspect');
        tabCompare.classList.toggle('active', state.activeTab === 'compare');
        tabInspect.setAttribute('aria-selected', String(state.activeTab === 'inspect'));
        tabCompare.setAttribute('aria-selected', String(state.activeTab === 'compare'));
        detailBody.setAttribute('aria-labelledby', state.activeTab === 'inspect' ? 'tabInspect' : 'tabCompare');
        document.getElementById('detailHeading').textContent = state.activeTab === 'inspect' ? 'Run Inspector' : 'Base → Feature Comparison';

        if (state.activeTab === 'inspect') renderInspect(selected);
        else renderCompare(selected, list);

        writeHash();
        if (restoreSelector) {
          const target = document.querySelector(restoreSelector);
          if (target) target.focus();
        }
      }

      document.getElementById('searchInput').addEventListener('input', (e) => { state.search = e.target.value; render(); });
      document.getElementById('statusFilter').addEventListener('change', (e) => { state.status = e.target.value; render(); });
      document.getElementById('modeFilter').addEventListener('change', (e) => { state.mode = e.target.value; render(); });
      document.getElementById('scopeFilter').addEventListener('change', (e) => { state.scope = e.target.value; render(); });
      document.getElementById('resetFiltersBtn').addEventListener('click', resetFilters);
      document.getElementById('timingToggle').addEventListener('click', () => {
        state.timingExpanded = !state.timingExpanded;
        render();
      });

      const tabInspect = document.getElementById('tabInspect');
      const tabCompare = document.getElementById('tabCompare');
      tabInspect.addEventListener('click', () => { state.activeTab = 'inspect'; render('#tabInspect'); });
      tabCompare.addEventListener('click', () => { state.activeTab = 'compare'; render('#tabCompare'); });
      const handleTabKey = (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          state.activeTab = state.activeTab === 'inspect' ? 'compare' : 'inspect';
          render(state.activeTab === 'inspect' ? '#tabInspect' : '#tabCompare');
        }
      };
      tabInspect.addEventListener('keydown', handleTabKey);
      tabCompare.addEventListener('keydown', handleTabKey);

      document.addEventListener('keydown', (e) => {
        const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
        const inField = tag === 'input' || tag === 'select' || tag === 'textarea';
        if (e.key === 'Escape' && inField && e.target.id === 'searchInput') {
          state.search = '';
          e.target.value = '';
          e.target.blur();
          render();
          return;
        }
        if (inField || e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === '/') {
          e.preventDefault();
          document.getElementById('searchInput').focus();
        } else if (e.key === 'j' || e.key === 'k') {
          const list = filteredRuns();
          if (!list.length) return;
          const idx = list.findIndex(r => runKey(r) === state.selectedKey);
          const next = e.key === 'j' ? Math.min(list.length - 1, idx + 1) : Math.max(0, idx - 1);
          selectRun(runKey(list[next]), true);
        } else if (e.key === 'c') {
          state.activeTab = 'compare';
          render();
        } else if (e.key === 'i') {
          state.activeTab = 'inspect';
          render();
        }
      });

      readHash();
      render();
    })();
`;

export function renderDashboardHtml(data) {
  const payload = safeJsonForHtml(data);
  const scriptHash = createHash('sha256').update(CLIENT_SCRIPT, 'utf8').digest('base64');
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'`;
  // A file:// page cannot fetch runs.json, so while a run is live it reloads itself to pick up the rebuilt file. The
  // tag is dropped from the page written once nothing is running.
  const refresh = data.runs.some(run => run.status === 'running') ? `\n  <meta http-equiv="refresh" content="${REFRESH_SECONDS}" />` : '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />${refresh}
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Proofs Dashboard</title>
  <style>
    :root {
      --bg: #070c18;
      --surface: #0f172a;
      --surface-2: #162036;
      --surface-3: #1e2b45;
      --border: rgba(148, 163, 184, 0.16);
      --border-strong: rgba(148, 163, 184, 0.34);
      --text: #f1f5f9;
      --text-dim: #cbd5e1;
      --text-muted: #94a3b8;
      --sky: #38bdf8;
      --indigo: #818cf8;
      --emerald: #34d399;
      --amber: #fbbf24;
      --rose: #fb7185;
      --violet: #a78bfa;
      --radius: 14px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background:
        radial-gradient(ellipse 60% 40% at 88% -8%, rgba(56, 189, 248, 0.12), transparent 55%),
        radial-gradient(ellipse 50% 35% at 10% -6%, rgba(129, 140, 248, 0.10), transparent 55%),
        var(--bg);
      color: var(--text);
      line-height: 1.48;
      min-height: 100vh;
    }
    code, pre, .mono { font-family: var(--mono); }
    :focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }

    @keyframes riseIn {
      from { opacity: 0.01; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulseBeacon {
      0%, 100% { box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.55), 0 0 12px rgba(56, 189, 248, 0.7); }
      50% { box-shadow: 0 0 0 6px rgba(56, 189, 248, 0), 0 0 16px rgba(56, 189, 248, 0.9); }
    }
    @keyframes arrowDrift {
      0%, 100% { transform: translateX(0); }
      50% { transform: translateX(4px); }
    }
    @keyframes segGrow {
      from { transform: scaleX(0); }
      to { transform: scaleX(1); }
    }

    .topbar {
      position: sticky;
      top: 0;
      z-index: 20;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 13px 24px;
      background: rgba(7, 12, 24, 0.86);
      backdrop-filter: blur(14px);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    .brand-dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: var(--sky);
      animation: pulseBeacon 3s ease-in-out infinite;
    }
    .brand h1 { margin: 0; font-size: 1.05rem; font-weight: 700; letter-spacing: -0.015em; }
    .brand-meta { font-size: 0.76rem; color: var(--text-muted); font-family: var(--mono); }

    .wrap {
      max-width: 1480px;
      margin: 0 auto;
      padding: 20px 24px 48px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
    }
    .kpi {
      position: relative;
      background: linear-gradient(180deg, rgba(22, 32, 54, 0.75), rgba(15, 23, 42, 0.96));
      border: 1px solid var(--border);
      border-top: 2px solid var(--accent, var(--sky));
      border-radius: var(--radius);
      padding: 15px 17px;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: transform 0.2s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.2s ease, box-shadow 0.2s ease;
      animation: riseIn 0.22s ease both;
    }
    .kpi:hover {
      transform: translateY(-2px);
      border-color: var(--border-strong);
      box-shadow: 0 10px 28px -12px rgba(0, 0, 0, 0.65);
    }
    .kpi-hero { flex-direction: row; align-items: center; gap: 14px; }
    .kpi-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
    .kpi-top-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .kpi-label {
      font-size: 0.71rem;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      color: var(--text-muted);
      font-weight: 600;
    }
    .kpi-pct { font-size: 0.78rem; color: var(--text-dim); font-weight: 600; }
    .kpi-value { font-size: 1.48rem; font-weight: 700; letter-spacing: -0.025em; line-height: 1.15; }
    .kpi-sub { font-size: 0.75rem; color: var(--text-muted); font-family: var(--mono); }

    .ring-wrap {
      position: relative;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .ring-svg { display: block; overflow: visible; }
    .ring-progress { transition: stroke-dashoffset 0.65s cubic-bezier(0.22, 1, 0.36, 1); }
    .ring-label {
      position: absolute;
      font-size: 0.72rem;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.02em;
    }

    .seg-bar {
      width: 100%;
      display: flex;
      gap: 2px;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(148, 163, 184, 0.12);
    }
    .seg-fill {
      display: block;
      height: 100%;
      border-radius: 2px;
      transform-origin: left center;
      animation: segGrow 0.45s cubic-bezier(0.22, 1, 0.36, 1) both;
      transition: width 0.35s ease, filter 0.15s ease;
    }
    .seg-fill:hover { filter: brightness(1.2); }

    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      box-shadow: 0 4px 20px -10px rgba(0, 0, 0, 0.55);
    }
    .panel-compact .panel-head { border-bottom: 0; }
    .panel-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(22, 32, 54, 0.58);
    }
    .panel-title {
      margin: 0;
      font-size: 0.88rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      letter-spacing: -0.01em;
    }
    .controls { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }

    input[type="search"], select {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 9px;
      padding: 6px 10px;
      font-size: 0.8rem;
      font-family: var(--sans);
      max-width: 100%;
      min-width: 0;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    input[type="search"]:hover, select:hover { border-color: rgba(56, 189, 248, 0.5); }
    input[type="search"]:focus, select:focus { border-color: var(--sky); box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.14); }

    button.btn {
      background: var(--surface-3);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 9px;
      padding: 6px 12px;
      font-size: 0.79rem;
      font-weight: 500;
      cursor: pointer;
      transition: transform 0.14s ease, background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
    }
    button.btn:hover { background: #263654; border-color: var(--sky); transform: translateY(-1px); }
    button.btn:active { transform: translateY(0); }
    button.btn-xs { padding: 3px 9px; font-size: 0.72rem; border-radius: 7px; }
    button.btn-primary {
      background: linear-gradient(180deg, rgba(56, 189, 248, 0.22), rgba(56, 189, 248, 0.12));
      border-color: rgba(56, 189, 248, 0.5);
      color: #bae6fd;
    }
    button.btn-primary:hover { background: rgba(56, 189, 248, 0.28); box-shadow: 0 4px 14px -4px rgba(56, 189, 248, 0.4); }
    button.btn-copied { border-color: var(--emerald); color: #6ee7b7; background: rgba(52, 211, 153, 0.16); }
    button.link-btn {
      background: transparent; border: 0; padding: 2px 4px;
      color: var(--sky); font-size: 0.75rem; font-family: var(--mono);
      cursor: pointer; border-radius: 5px;
      transition: color 0.15s ease, background 0.15s ease;
    }
    button.link-btn:hover { color: #bae6fd; background: rgba(56, 189, 248, 0.12); }

    .ticket-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 9px;
      padding: 12px 16px;
    }
    .tcard {
      text-align: left;
      min-width: 175px;
      flex: 0 1 215px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 11px;
      padding: 10px 12px;
      color: var(--text);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 7px;
      transition: transform 0.18s cubic-bezier(0.22, 1, 0.36, 1), border-color 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
    }
    .tcard-all { flex: 0 0 140px; min-width: 132px; justify-content: space-between; }
    .tcard:hover {
      transform: translateY(-2px);
      border-color: rgba(56, 189, 248, 0.5);
      background: #1b2842;
      box-shadow: 0 8px 20px -10px rgba(0, 0, 0, 0.7);
    }
    .tcard.active {
      background: rgba(56, 189, 248, 0.12);
      border-color: rgba(56, 189, 248, 0.65);
      box-shadow: 0 0 0 1px rgba(56, 189, 248, 0.28), 0 8px 20px -10px rgba(56, 189, 248, 0.35);
    }
    .tcard-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .tcard-name { font-weight: 700; font-size: 0.84rem; }
    .tcard-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 6px;
      font-size: 0.72rem; color: var(--text-muted);
    }

    .chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text-dim);
      font-size: 0.75rem;
      font-family: var(--mono);
      cursor: pointer;
      transition: transform 0.14s ease, border-color 0.15s ease, background 0.15s ease, color 0.15s ease;
    }
    .chip:hover { border-color: var(--sky); color: var(--text); transform: translateY(-1px); }
    .chip.active {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.6);
      color: #e0f2fe;
    }
    .chip-pass.active { background: rgba(52, 211, 153, 0.18); border-color: rgba(52, 211, 153, 0.6); color: #a7f3d0; }
    .chip-fail.active { background: rgba(251, 113, 133, 0.18); border-color: rgba(251, 113, 133, 0.6); color: #fecdd3; }
    .chip-info.active { background: rgba(56, 189, 248, 0.18); border-color: rgba(56, 189, 248, 0.6); color: #bae6fd; }

    .workspace {
      display: grid;
      grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1020px) { .workspace { grid-template-columns: 1fr; } }

    .run-list {
      max-height: 780px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
    }
    .run-item {
      text-align: left;
      width: 100%;
      background: transparent;
      border: 0;
      border-bottom: 1px solid var(--border);
      padding: 12px 14px;
      color: var(--text);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 6px;
      transition: background 0.15s ease, padding-left 0.15s ease, box-shadow 0.15s ease;
      animation: riseIn 0.2s ease both;
      animation-delay: calc(var(--i, 0) * 12ms);
    }
    .run-item:focus-visible { outline-offset: -2px; }
    .run-item:hover { background: rgba(56, 189, 248, 0.07); padding-left: 17px; }
    .run-item.selected {
      background: rgba(56, 189, 248, 0.13);
      box-shadow: inset 3px 0 0 var(--sky);
    }
    .run-item-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .run-ticket { font-weight: 700; font-size: 0.84rem; font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-target { font-size: 0.72rem; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .run-sub {
      display: flex; flex-wrap: wrap; align-items: center; gap: 6px;
      font-size: 0.72rem; color: var(--text-muted); font-family: var(--mono);
    }
    .list-footnote {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 10px 14px; font-size: 0.74rem; color: var(--text-muted);
      background: rgba(22, 32, 54, 0.45);
    }

    .pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 0.69rem;
      font-weight: 600;
      font-family: var(--mono);
      border: 1px solid transparent;
      white-space: nowrap;
      letter-spacing: 0.01em;
    }
    .pill-pass { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; border-color: rgba(52, 211, 153, 0.38); }
    .pill-fail { background: rgba(251, 113, 133, 0.15); color: #fda4af; border-color: rgba(251, 113, 133, 0.38); }
    .pill-blocked { background: rgba(251, 191, 36, 0.14); color: #fde68a; border-color: rgba(251, 191, 36, 0.38); }
    .pill-uncovered { background: rgba(167, 139, 250, 0.14); color: #ddd6fe; border-color: rgba(167, 139, 250, 0.38); }
    .pill-skipped { background: rgba(148, 163, 184, 0.15); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.28); }
    .pill-info { background: rgba(56, 189, 248, 0.14); color: #7dd3fc; border-color: rgba(56, 189, 248, 0.38); }
    .pill-muted { background: rgba(100, 116, 139, 0.18); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.24); }
    .pill-feature { background: rgba(129, 140, 248, 0.2); color: #c7d2fe; border-color: rgba(129, 140, 248, 0.5); }
    .pill-base { background: rgba(148, 163, 184, 0.14); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.35); }
    .pill-live { animation: pulseBeacon 2.2s ease-in-out infinite; }

    .tabs { display: flex; gap: 6px; }
    .tab {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 5px 12px;
      border-radius: 9px;
      font-size: 0.79rem;
      cursor: pointer;
      transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .tab:hover { border-color: rgba(56, 189, 248, 0.45); color: var(--text); }
    .tab.active {
      background: rgba(56, 189, 248, 0.18);
      border-color: rgba(56, 189, 248, 0.55);
      color: #e0f2fe;
      font-weight: 600;
    }

    .detail-body {
      padding: 18px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .detail-header-row {
      display: flex; flex-wrap: wrap; gap: 12px;
      align-items: center; justify-content: space-between;
    }
    .inspect-title-group { display: flex; align-items: center; gap: 13px; min-width: 0; }
    .inspect-sub { font-size: 0.74rem; color: var(--text-muted); margin-top: 4px; word-break: break-word; }

    .toolbar-row {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px;
    }

    .cmp-hero {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(175px, 230px) minmax(0, 1fr);
      gap: 12px;
      align-items: stretch;
      animation: riseIn 0.3s ease both;
    }
    @media (max-width: 820px) { .cmp-hero { grid-template-columns: 1fr; } }

    .cmp-side {
      background: linear-gradient(180deg, rgba(22, 32, 54, 0.85), rgba(15, 23, 42, 0.96));
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: border-color 0.2s ease, transform 0.2s ease;
    }
    .cmp-side:hover { border-color: var(--border-strong); transform: translateY(-1px); }
    .cmp-side-feat { border-top: 2px solid var(--indigo); }
    .cmp-side-base { border-top: 2px solid #64748b; }
    .cmp-side-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .cmp-side-main { display: flex; align-items: center; gap: 11px; min-width: 0; }
    .cmp-side-info { min-width: 0; flex: 1; }
    .cmp-branch { font-size: 0.82rem; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cmp-meta { font-size: 0.71rem; color: var(--text-muted); margin-top: 2px; }
    .cmp-side select { width: 100%; font-size: 0.74rem; padding: 5px 8px; }

    .cmp-center {
      background: rgba(22, 32, 54, 0.55);
      border: 1px dashed var(--border-strong);
      border-radius: 12px;
      padding: 12px 10px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 6px;
    }
    .cmp-tone-good { border-color: rgba(52, 211, 153, 0.45); background: rgba(52, 211, 153, 0.06); }
    .cmp-tone-bad { border-color: rgba(251, 113, 133, 0.45); background: rgba(251, 113, 133, 0.06); }
    .cmp-tone-warn { border-color: rgba(251, 191, 36, 0.45); background: rgba(251, 191, 36, 0.06); }
    .cmp-tone-info { border-color: rgba(56, 189, 248, 0.45); background: rgba(56, 189, 248, 0.06); }
    .cmp-arrow {
      font-size: 1.4rem; line-height: 1; font-weight: 700; color: var(--sky);
      animation: arrowDrift 2.4s ease-in-out infinite;
    }
    .cmp-tone-good .cmp-arrow { color: var(--emerald); }
    .cmp-tone-bad .cmp-arrow { color: var(--rose); }
    .cmp-verdict { font-size: 0.92rem; font-weight: 700; letter-spacing: -0.015em; }

    .rev-strip { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .rev-pill {
      font-size: 0.72rem;
      padding: 4px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text-dim);
    }
    .rev-changed { border-color: rgba(129, 140, 248, 0.35); background: rgba(129, 140, 248, 0.09); color: #e0e7ff; }
    .rev-same { color: var(--text-muted); }

    .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 11px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: top; }
    tbody tr:last-child td { border-bottom: 0; }
    th {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      background: rgba(22, 32, 54, 0.72);
    }
    .ac-row {
      transition: background 0.14s ease;
      animation: riseIn 0.18s ease both;
      animation-delay: calc(var(--i, 0) * 10ms);
    }
    .ac-row:hover { background: rgba(56, 189, 248, 0.06); }
    .ac-row.row-delta-delivered:hover, .ac-row.row-pass:hover { background: rgba(52, 211, 153, 0.06); }
    .ac-row.row-delta-regression, .ac-row.row-fail { background: rgba(251, 113, 133, 0.035); }
    .ac-row.row-delta-regression:hover, .ac-row.row-fail:hover { background: rgba(251, 113, 133, 0.09); }
    .ac-id { font-weight: 700; color: var(--text); white-space: nowrap; }

    .cmp-cell { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; }
    .ev-box { display: flex; flex-direction: column; gap: 5px; }
    .ev-chips { display: flex; flex-wrap: wrap; gap: 4px; }
    .ev-chip {
      font-family: var(--sans);
      font-size: 0.72rem;
      line-height: 1.3;
      padding: 2px 8px;
      border-radius: 6px;
      border: 1px solid transparent;
      overflow-wrap: break-word;
    }
    .ev-chip-fail { background: rgba(251, 113, 133, 0.14); color: #fda4af; border-color: rgba(251, 113, 133, 0.34); }
    .ev-chip-pass { background: rgba(52, 211, 153, 0.10); color: #86efac; border-color: rgba(52, 211, 153, 0.25); }
    .ev-chip-warn { background: rgba(251, 191, 36, 0.12); color: #fde68a; border-color: rgba(251, 191, 36, 0.3); }
    .ev-chip-note { background: rgba(148, 163, 184, 0.12); color: var(--text-dim); border-color: rgba(148, 163, 184, 0.24); }
    .ev-more summary {
      cursor: pointer;
      font-size: 0.71rem;
      font-family: var(--mono);
      color: var(--text-muted);
      user-select: none;
      transition: color 0.14s ease;
    }
    .ev-more summary:hover { color: var(--sky); }
    .cmp-detail { font-size: 0.72rem; color: var(--text-muted); word-break: break-word; }

    .tech-details {
      border: 1px solid var(--border);
      border-radius: 11px;
      background: rgba(22, 32, 54, 0.4);
      overflow: hidden;
    }
    .tech-details summary {
      padding: 10px 14px;
      font-size: 0.79rem;
      font-weight: 600;
      color: var(--text-dim);
      cursor: pointer;
      user-select: none;
      transition: background 0.15s ease, color 0.15s ease;
    }
    .tech-details summary:hover { background: rgba(56, 189, 248, 0.06); color: var(--text); }
    .tech-body { padding: 0 14px 14px; display: flex; flex-direction: column; gap: 10px; }

    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
    .meta-card {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .meta-k-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
    .meta-k { font-size: 0.69rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 4px; }
    .meta-k-row .meta-k { margin-bottom: 0; }
    .meta-v { font-size: 0.77rem; font-family: var(--mono); word-break: break-word; }
    .meta-sub { margin-top: 4px; font-size: 0.71rem; color: var(--text-muted); }

    .phase-bar {
      display: flex; height: 9px; border-radius: 999px; overflow: hidden;
      background: var(--surface-3); margin-top: 6px;
    }
    .phase-legend {
      display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px;
      font-size: 0.73rem; color: var(--text-dim); font-family: var(--mono);
    }
    .swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 4px; vertical-align: middle; }
    .svg-bar { cursor: pointer; transition: opacity 0.15s ease, filter 0.15s ease; }
    .svg-bar:hover { filter: brightness(1.18); }
    .svg-bar:focus-visible { outline: 2px solid var(--sky); }

    .callout {
      border-radius: 10px; padding: 10px 13px;
      border: 1px solid var(--border); background: var(--surface-2); font-size: 0.81rem;
    }
    .callout-warn { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.08); color: #fde68a; }
    .callout-err { border-color: rgba(251, 113, 133, 0.4); background: rgba(251, 113, 133, 0.08); color: #fecdd3; }
    .callout ul { margin: 6px 0 0 18px; padding: 0; }
    .chart-wrap { padding: 12px 16px 14px; overflow-x: auto; }
    .empty { padding: 30px 18px; text-align: center; color: var(--text-dim); font-size: 0.86rem; }
    .empty-compact { padding: 14px 12px; }

    .footer {
      text-align: center;
      font-size: 0.72rem;
      color: var(--text-muted);
      font-family: var(--mono);
      padding-top: 4px;
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after {
        animation-duration: 0.01ms !important;
        animation-iteration-count: 1 !important;
        transition-duration: 0.01ms !important;
      }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="brand-dot" aria-hidden="true"></span>
      <h1>Proofs Dashboard</h1>
      <span class="brand-meta" id="generatedMeta"></span>
    </div>
    <div class="controls">
      <input type="search" id="searchInput" placeholder="Filter ticket, AC, branch, SHA... (/)" aria-label="Filter runs" />
      <select id="scopeFilter" aria-label="Filter by run type">
        <option value="complete">Complete runs</option>
        <option value="all">All runs (+debug/partial)</option>
        <option value="partial">Partial / debug only</option>
      </select>
      <select id="statusFilter" aria-label="Filter by status">
        <option value="all">All statuses</option>
        <option value="pass">Pass only</option>
        <option value="fail">Fail only</option>
        <option value="blocked">Blocked only</option>
      </select>
      <select id="modeFilter" aria-label="Filter by mode">
        <option value="all">All modes</option>
        <option value="worktree">Worktree</option>
        <option value="url">Running URL</option>
      </select>
      <button type="button" class="btn btn-primary" id="resetFiltersBtn" style="display:none;">Reset filters</button>
    </div>
  </header>

  <main class="wrap">
    <section class="kpi-grid" id="kpiGrid" aria-label="Summary metrics"></section>

    <section class="panel" id="timingPanel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span>Run Timings</span>
          <span class="pill pill-muted" id="chartCaption"></span>
        </h2>
        <div class="controls">
          <div class="phase-legend" id="timingLegend" style="margin-top:0;"></div>
          <button type="button" class="btn btn-xs" id="timingToggle" aria-controls="timingChart" aria-expanded="true">Hide chart</button>
        </div>
      </div>
      <div class="chart-wrap" id="timingChart"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Tickets</h2>
        <span class="brand-meta" id="ticketCountMeta"></span>
      </div>
      <div class="ticket-grid" id="ticketChips"></div>
    </section>

    <section class="workspace">
      <div class="panel">
        <div class="panel-head">
          <h2 class="panel-title">Runs</h2>
          <span class="brand-meta" id="runListMeta"></span>
        </div>
        <div class="run-list" id="runList"></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2 class="panel-title" id="detailHeading">Run Inspector</h2>
          <div class="tabs" role="tablist" aria-label="Detail view">
            <button type="button" class="tab active" id="tabInspect" role="tab" aria-selected="true" aria-controls="detailBody">Inspect Run</button>
            <button type="button" class="tab" id="tabCompare" role="tab" aria-selected="false" aria-controls="detailBody">Base → Feature</button>
          </div>
        </div>
        <div class="detail-body" id="detailBody" role="tabpanel" aria-labelledby="tabInspect"></div>
      </div>
    </section>

    <footer class="footer">
      Static snapshot from allowlisted runs.json metadata &amp; redacted report.md files · Diagnostics &amp; context values are never embedded · Keys: / search · j/k runs · i/c inspect/compare
    </footer>
  </main>

  <script id="proofs-data" type="application/json">${payload}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

export async function writeDashboard(outDir, { now = Date.now(), isAncestor, resolveBranch } = {}) {
  await checkPrivateDir(outDir);
  return withLock(outDir, async () => {
    const data = await collectDashboardData(outDir, { now, isAncestor, resolveBranch });
    const html = renderDashboardHtml(data);
    const target = join(outDir, DASHBOARD);
    const temp = join(outDir, `.${DASHBOARD}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(temp, html, { flag: 'wx', mode: 0o600 });
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return { path: target, ticketCount: data.ticketCount, runCount: data.runCount };
  });
}
