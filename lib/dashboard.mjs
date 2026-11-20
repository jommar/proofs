import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { maskCommand } from './command.mjs';
import { RUN_DIR, withLock } from './runs.mjs';

const INDEX = 'runs.json';
const DASHBOARD = 'dashboard.html';
const INDEX_LIMIT = 10 * 1024 * 1024;
const REPORT_LIMIT = 1024 * 1024;
const SAFE_TICKET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_RUNTIME_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const URL_KEY = /^PROOF_[A-Z0-9_]+_URL$/;
const CONTEXT_KEY = /^PROOF_CONTEXT_([A-Z0-9_]+)$/;

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

function sanitizeWorktrees(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.app !== 'string' || !item.app.trim()) continue;
    out.push({
      app: item.app.trim(),
      sha: typeof item.sha === 'string' ? item.sha.trim() : '',
      dirty: Boolean(item.dirty),
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

export async function collectDashboardData(outDir, { now = Date.now() } = {}) {
  await checkPrivateDir(outDir);
  const indexRaw = await readSafeRegularFile(join(outDir, INDEX), INDEX_LIMIT, { throwOnMissing: true });
  if (indexRaw === null) throw new InvalidRunsIndexError('runs.json is unreadable, oversized, or unsafe.');
  const index = JSON.parse(indexRaw);
  if (!isRecord(index)) throw new InvalidRunsIndexError();

  const runs = [];
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

      runs.push({
        ticket,
        id: runId,
        startedAt: typeof record.startedAt === 'string' ? record.startedAt : '',
        durationMs,
        timings,
        exitCode: Number.isInteger(record.exitCode) ? record.exitCode : 1,
        status: summarizeRunStatus(record, parsed),
        type: record.type === 'url' ? 'url' : 'worktree',
        runtime: sanitizeRuntime(record.runtime),
        adapters: sanitizeStrings(record.only),
        selectedAcs,
        partial: selectedAcs.length > 0 || Boolean(parsed?.partial),
        debug: Boolean(record.debug),
        hasDiagnostics,
        worktrees: sanitizeWorktrees(record.worktrees),
        urls: sanitizeUrls(record.urls),
        contextKeys: sanitizeContextKeys(record.context),
        branch: typeof record.branch === 'string' && record.branch.trim() ? record.branch.trim() : null,
        command: maskCommand(record.args),
        profile: typeof record.profile === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(record.profile) ? record.profile : null,
        persona: typeof record.persona === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(record.persona) ? record.persona : null,
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

  const ticketMap = new Map();
  for (const run of runs) {
    let entry = ticketMap.get(run.ticket);
    if (!entry) {
      entry = {
        ticket: run.ticket,
        runCount: 0,
        passCount: 0,
        failCount: 0,
        blockedCount: 0,
        latestRunId: run.id,
        latestStatus: run.status,
        latestStartedAt: run.startedAt,
        latestCounts: run.counts,
      };
      ticketMap.set(run.ticket, entry);
    }
    entry.runCount++;
    if (run.status === 'pass') entry.passCount++;
    else if (run.status === 'blocked') entry.blockedCount++;
    else entry.failCount++;
  }

  const tickets = Array.from(ticketMap.values()).sort(
    (a, b) => compareDescTs(a.latestStartedAt, b.latestStartedAt) || a.ticket.localeCompare(b.ticket),
  );

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
      const ADAPTER_PALETTE = ['#818cf8', '#34d399', '#f472b6', '#22d3ee', '#fb923c', '#a78bfa'];

      const runKey = (run) => run.ticket + '/' + run.id;

      const state = {
        ticket: 'all',
        status: 'all',
        mode: 'all',
        scope: 'all',
        search: '',
        selectedKey: RUNS[0] ? runKey(RUNS[0]) : null,
        activeTab: 'inspect',
        acFilter: 'all',
        compareBaseKey: null,
        compareFeatureKey: null,
        compareChangedOnly: false,
        compareShowDetails: true,
        timingExpanded: null,
      };

      function readHash() {
        const raw = (location.hash || '').replace(/^#/, '');
        if (!raw) return;
        const params = new URLSearchParams(raw);
        const t = params.get('ticket');
        if (t && (t === 'all' || TICKETS.some(x => x.ticket === t))) state.ticket = t;
        const r = params.get('run');
        if (r && RUNS.some(x => runKey(x) === r)) state.selectedKey = r;
        const tab = params.get('tab');
        if (tab === 'inspect' || tab === 'compare') state.activeTab = tab;
      }

      function writeHash() {
        try {
          const params = new URLSearchParams();
          if (state.ticket !== 'all') params.set('ticket', state.ticket);
          if (state.selectedKey) params.set('run', state.selectedKey);
          if (state.activeTab !== 'inspect') params.set('tab', state.activeTab);
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

      const runTargetLabel = (run) => {
        if (run.type === 'worktree') {
          if (!run.worktrees.length) return run.profile || 'worktree';
          return (run.profile ? run.profile + (run.persona ? ' as ' + run.persona : '') + ' | ' : '') + run.worktrees.map(w => w.app + '@' + (shortSha(w.sha) || '?') + (w.dirty ? '*' : '')).join(', ');
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
        };
        return el('span', { className: 'pill ' + (map[status] || 'pill-muted'), text: label || status });
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
              btn.textContent = 'Copied';
              setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
            } catch {
              btn.textContent = 'No clipboard';
              setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
            }
          },
        });
        return btn;
      };

      function hasActiveFilters() {
        return state.ticket !== 'all' || state.status !== 'all' || state.mode !== 'all' || state.scope !== 'all' || state.search.trim() !== '';
      }

      function resetFilters() {
        state.ticket = 'all';
        state.status = 'all';
        state.mode = 'all';
        state.scope = 'all';
        state.search = '';
        state.acFilter = 'all';
        document.getElementById('searchInput').value = '';
        document.getElementById('statusFilter').value = 'all';
        document.getElementById('modeFilter').value = 'all';
        document.getElementById('scopeFilter').value = 'all';
        render();
      }

      function filteredRuns() {
        const q = state.search.trim().toLowerCase();
        return RUNS.filter(run => {
          if (state.ticket !== 'all' && run.ticket !== state.ticket) return false;
          if (state.status !== 'all' && run.status !== state.status) return false;
          if (state.mode !== 'all' && run.type !== state.mode) return false;
          if (state.scope === 'full' && run.partial) return false;
          if (state.scope === 'partial' && !run.partial) return false;
          if (q) {
            const hay = [
              run.ticket,
              run.id,
              run.branch || '',
              run.runtime || '',
              run.proofDigest || '',
              runTargetLabel(run),
              ...run.worktrees.map(w => w.app + ' ' + w.sha),
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

      function renderKpis(list) {
        const grid = document.getElementById('kpiGrid');
        grid.textContent = '';
        const ticketSet = new Set(list.map(r => r.ticket));
        const passRuns = list.filter(r => r.status === 'pass').length;
        const failRuns = list.filter(r => r.status === 'fail').length;
        const blockedRuns = list.filter(r => r.status === 'blocked').length;
        const passRate = list.length ? Math.round((passRuns / list.length) * 100) : 0;
        const timed = list.map(r => r.durationMs).filter(v => Number.isFinite(v) && v > 0);
        const avgMs = timed.length ? Math.round(timed.reduce((a, b) => a + b, 0) / timed.length) : null;
        const diagCount = list.filter(r => r.hasDiagnostics).length;

        const latestByTicket = new Map();
        for (const r of list) if (!latestByTicket.has(r.ticket)) latestByTicket.set(r.ticket, r);
        let acPass = 0, acTotal = 0;
        for (const r of latestByTicket.values()) {
          acPass += r.counts.pass || 0;
          acTotal += r.counts.total || 0;
        }

        const tiles = [
          { label: 'Tickets Shown', value: String(ticketSet.size), sub: TICKETS.length + ' indexed (30d)', accent: 'var(--sky)' },
          { label: 'Runs Matched', value: String(list.length), sub: passRuns + ' pass | ' + failRuns + ' fail | ' + blockedRuns + ' blocked', accent: 'var(--indigo)' },
          { label: 'Run Pass Rate', value: list.length ? passRate + '%' : 'n/a', sub: passRuns + ' of ' + list.length + ' runs passed', accent: passRate >= 70 ? 'var(--emerald)' : 'var(--amber)' },
          { label: 'Latest AC Coverage', value: acTotal ? acPass + '/' + acTotal : 'n/a', sub: 'passing ACs across latest ticket runs', accent: 'var(--emerald)' },
          { label: 'Avg Run Duration', value: fmtDur(avgMs), sub: timed.length + ' timed run(s)', accent: 'var(--violet)' },
          { label: 'Local Diagnostics', value: String(diagCount), sub: 'runs with private 0o600 diagnostics/', accent: 'var(--amber)' },
        ];

        for (const t of tiles) {
          grid.appendChild(el('div', { className: 'kpi', style: { '--accent': t.accent } }, [
            el('div', { className: 'kpi-label', text: t.label }),
            el('div', { className: 'kpi-value', text: t.value }),
            el('div', { className: 'kpi-sub', text: t.sub }),
          ]));
        }
      }

      function renderTimingChart(list) {
        const panel = document.getElementById('timingPanel');
        const wrap = document.getElementById('timingChart');
        const cap = document.getElementById('chartCaption');
        const legend = document.getElementById('timingLegend');
        const toggleBtn = document.getElementById('timingToggle');
        wrap.textContent = '';
        legend.textContent = '';

        const timed = list.filter(r => Number.isFinite(r.durationMs) && r.durationMs > 0).slice(0, 20).reverse();
        const expanded = state.timingExpanded === null ? timed.length > 0 : state.timingExpanded;
        toggleBtn.textContent = expanded ? 'Hide chart' : 'Show chart';
        toggleBtn.setAttribute('aria-expanded', String(expanded));
        cap.textContent = timed.length ? 'Last ' + timed.length + ' timed run(s)' : 'No timed runs in filter';
        wrap.style.display = expanded ? 'block' : 'none';
        panel.classList.toggle('panel-compact', !expanded);
        if (!expanded) return;

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
        const barW = 42, gap = 12, padL = 62, padR = 16, padT = 16, chartH = 112, padB = 34;
        const width = Math.max(640, padL + padR + prepared.length * (barW + gap));
        const height = padT + chartH + padB;
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
        svg.setAttribute('width', String(width));
        svg.setAttribute('height', String(height));
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', 'Stacked phase duration chart for recent proof runs');
        svg.style.display = 'block';

        const sEl = (tag, attrs) => {
          const n = document.createElementNS(ns, tag);
          for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
          return n;
        };

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
          const barLabel = run.ticket + ' (' + run.status + '), ' + fmtDur(run.durationMs) + ', ' + fmtTime(run.startedAt);
          const g = sEl('g', {
            class: 'svg-bar',
            tabindex: '0',
            role: 'button',
            'aria-label': 'Inspect ' + barLabel,
          });
          const activate = () => selectRun(key, true);
          g.addEventListener('click', activate);
          g.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              activate();
            }
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
              x, y: yCursor, width: barW, height: h, rx: 2,
              fill: seg.color,
              opacity: isSelected ? '1' : '0.84',
            }));
          });

          if (isSelected) {
            g.appendChild(sEl('rect', {
              x: x - 2, y: yCursor - 2, width: barW + 4, height: (padT + chartH) - yCursor + 4,
              fill: 'none', stroke: '#f8fafc', 'stroke-width': 1.5, rx: 3,
            }));
          }

          const dotColor = run.status === 'pass' ? '#34d399' : run.status === 'blocked' ? '#fbbf24' : '#fb7185';
          g.appendChild(sEl('circle', { cx: x + barW / 2, cy: padT + chartH + 10, r: 3.2, fill: dotColor }));

          const xText = singleTicket
            ? (run.worktrees[0]?.sha ? '@' + shortSha(run.worktrees[0].sha) : fmtClock(run.startedAt) || run.id.slice(0, 6))
            : run.ticket.slice(0, 8);
          const lbl = sEl('text', {
            x: x + barW / 2, y: padT + chartH + 25,
            fill: '#cbd5e1', 'font-size': 9.5, 'font-family': 'monospace', 'text-anchor': 'middle',
          });
          lbl.textContent = xText;
          g.appendChild(lbl);

          const title = document.createElementNS(ns, 'title');
          title.textContent = barLabel;
          g.appendChild(title);
          svg.appendChild(g);
        });

        wrap.appendChild(svg);
      }

      function renderTicketChips() {
        const bar = document.getElementById('ticketChips');
        const meta = document.getElementById('ticketCountMeta');
        bar.textContent = '';
        meta.textContent = TICKETS.length + ' ticket(s) | ' + RUNS.length + ' run(s)';

        const addChip = (id, label, badgeStatus, countText) => {
          const active = state.ticket === id;
          const btn = el('button', {
            className: 'chip' + (active ? ' active' : ''),
            'aria-pressed': String(active),
            'data-ticket-chip': id,
            onClick: () => {
              state.ticket = id;
              state.acFilter = 'all';
              state.compareBaseKey = null;
              state.compareFeatureKey = null;
              render('[data-ticket-chip="' + CSS.escape(id) + '"]');
            },
          }, [
            el('span', { text: label }),
            badgeStatus ? statusPill(badgeStatus, countText) : el('span', { className: 'pill pill-muted', text: countText }),
          ]);
          bar.appendChild(btn);
        };

        addChip('all', 'All tickets', null, String(RUNS.length));
        for (const t of TICKETS) {
          addChip(t.ticket, t.ticket, t.latestStatus, String(t.runCount));
        }
      }

      function renderRunList(list) {
        const container = document.getElementById('runList');
        const meta = document.getElementById('runListMeta');
        container.textContent = '';
        meta.textContent = list.length + ' shown';

        if (!list.length) {
          const empty = el('div', { className: 'empty' }, [
            el('div', { text: 'No runs match the current filters.' }),
            hasActiveFilters() ? el('div', { style: { marginTop: '10px' } }, [
              el('button', { className: 'btn btn-primary', text: 'Reset filters', onClick: resetFilters }),
            ]) : null,
          ]);
          container.appendChild(empty);
          return;
        }

        for (const run of list) {
          const key = runKey(run);
          const selected = key === state.selectedKey;
          const badges = [statusPill(run.status)];
          if (run.partial) badges.push(el('span', { className: 'pill pill-info', text: '--ac' }));
          if (run.debug) badges.push(el('span', { className: 'pill pill-muted', text: 'debug' }));
          if (run.hasDiagnostics) badges.push(el('span', { className: 'pill pill-blocked', text: 'diag' }));

          const item = el('button', {
            className: 'run-item' + (selected ? ' selected' : ''),
            'aria-current': selected ? 'true' : null,
            'data-run-key': key,
            onClick: () => selectRun(key, true, '[data-run-key="' + CSS.escape(key) + '"]'),
          }, [
            el('div', { className: 'run-item-top' }, [
              el('span', { className: 'run-ticket', text: run.ticket }),
              el('span', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } }, badges),
            ]),
            el('div', { className: 'run-sub' }, [
              el('span', { text: run.type }),
              el('span', { text: '|' }),
              el('span', { text: runTargetLabel(run) }),
            ]),
            el('div', { className: 'run-sub' }, [
              el('span', { text: fmtTime(run.startedAt) }),
              el('span', { text: '|' }),
              el('span', { text: fmtDur(run.durationMs) }),
              el('span', { text: '|' }),
              el('span', { text: run.counts.pass + '/' + run.counts.total + ' AC pass' }),
            ]),
          ]);
          container.appendChild(item);
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

        const headerRow = el('div', { className: 'detail-header-row' }, [
          el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' } }, [
            el('strong', { className: 'mono', text: run.ticket }),
            statusPill(run.status, 'exit ' + run.exitCode + ' (' + run.status + ')'),
            el('span', { className: 'pill pill-info', text: run.type }),
            run.partial ? el('span', { className: 'pill pill-blocked', text: partialBadgeText }) : null,
            run.debug ? el('span', { className: 'pill pill-muted', text: '--debug' }) : null,
            run.hasDiagnostics ? el('span', { className: 'pill pill-blocked', text: 'local diagnostics/ present' }) : null,
          ]),
          el('div', { className: 'controls' }, [
            ticketRuns.length >= 2 ? el('button', {
              className: 'btn btn-primary btn-xs',
              text: 'Compare runs',
              onClick: () => {
                const key = runKey(run);
                const featLabel = runTargetLabel(run);
                const base = ticketRuns.find(r => runKey(r) !== key && runTargetLabel(r) !== featLabel)
                  || ticketRuns.find(r => runKey(r) !== key)
                  || run;
                state.compareBaseKey = runKey(base);
                state.compareFeatureKey = key;
                state.activeTab = 'compare';
                render();
              },
            }) : null,
            el('span', { className: 'brand-meta', text: run.id }),
            copyButton(run.id, 'Copy run ID'),
          ]),
        ]);
        body.appendChild(headerRow);

        let targetText = 'n/a';
        if (run.type === 'worktree') {
          targetText = run.worktrees.map(w => w.app + ': ' + (w.sha || 'unknown') + (w.dirty ? ' (dirty)' : ' (clean)')).join('; ') || 'n/a';
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
            el('div', { className: 'meta-k', text: 'Started / Duration / Runtime' }),
            el('div', { className: 'meta-v', text: fmtTime(run.startedAt) + ' | ' + fmtDur(run.durationMs) + ' | ' + (run.runtime || 'none') }),
          ]),
          el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k-row' }, [
              el('span', { className: 'meta-k', text: 'Adapters / Context Keys / Report' }),
              copyButton(run.report, 'Copy report path'),
            ]),
            el('div', { className: 'meta-v', text: (run.adapters.join(', ') || 'none') + ' | keys: ' + ctxKeysText }),
            el('div', { className: 'meta-v meta-sub', text: run.report }),
          ]),
        ]);
        body.appendChild(metaGrid);

        const segs = extractPhaseSegments(run);
        if (segs.length && Number.isFinite(run.durationMs) && run.durationMs > 0) {
          const segSum = segs.reduce((a, b) => a + b.ms, 0);
          const allParts = [...segs];
          if (run.durationMs > segSum) allParts.push({ key: 'other', ms: run.durationMs - segSum, color: '#475569' });
          const total = Math.max(run.durationMs, segSum);
          body.appendChild(el('div', { className: 'meta-card' }, [
            el('div', { className: 'meta-k', text: 'Phase Timing Breakdown (' + fmtDur(run.durationMs) + ')' }),
            el('div', { className: 'phase-bar' }, allParts.map(p =>
              el('div', { style: { width: ((p.ms / total) * 100).toFixed(2) + '%', background: p.color }, title: p.key + ': ' + fmtDur(p.ms) })
            )),
            el('div', { className: 'phase-legend' }, allParts.map(p =>
              el('span', {}, [el('span', { className: 'swatch', style: { background: p.color } }), p.key + ' ' + fmtDur(p.ms)])
            )),
          ]));
        }

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
          ['na', 'Not applicable (' + (run.counts.na || 0) + ')'],
        ];
        if ((run.counts.unknown || 0) > 0) filterOpts.push(['unknown', 'Unknown (' + run.counts.unknown + ')']);

        if (state.acFilter !== 'all' && !run.acs.some(a => a.status === state.acFilter) && run.acs.length > 0) {
          state.acFilter = 'all';
        }

        body.appendChild(el('div', { className: 'controls' }, filterOpts.map(([key, label]) =>
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
        )));

        const acsShown = state.acFilter === 'all' ? run.acs : run.acs.filter(a => a.status === state.acFilter);
        if (!acsShown.length) {
          body.appendChild(el('div', { className: 'empty', text: 'No acceptance criteria in this filter.' }));
        } else {
          const table = el('table', {}, [
            el('thead', {}, el('tr', {}, [
              el('th', { style: { width: '90px' }, text: 'AC' }),
              el('th', { style: { width: '110px' }, text: 'Status' }),
              el('th', { text: 'Claim' }),
              el('th', { text: 'Evidence / Result' }),
            ])),
            el('tbody', {}, acsShown.map(ac => el('tr', {}, [
              el('td', { className: 'mono', text: ac.id }),
              el('td', {}, statusPill(ac.status)),
              el('td', { text: ac.claim || 'n/a' }),
              el('td', { className: 'mono', style: { fontSize: '0.76rem', color: '#cbd5e1' }, text: ac.detail || ac.result }),
            ]))),
          ]);
          body.appendChild(el('div', { className: 'table-wrap' }, table));
        }
      }

      function autoPickCompareRuns(ticketRuns) {
        if (ticketRuns.length < 2) return [ticketRuns[0] ? runKey(ticketRuns[0]) : null, ticketRuns[0] ? runKey(ticketRuns[0]) : null];
        const feature = ticketRuns[0];
        const featKey = runTargetLabel(feature);
        const base = ticketRuns.find(r => runKey(r) !== runKey(feature) && runTargetLabel(r) !== featKey) || ticketRuns[1];
        return [runKey(base), runKey(feature)];
      }

      function classifyDelta(bs, fs) {
        if (bs === 'na' || fs === 'na') return { key: 'neutral', text: bs === fs ? 'not applicable in both' : bs + ' -> ' + fs, pill: 'pill-skipped', changed: bs !== fs };
        if (bs === 'skipped' && fs === 'skipped') return { key: 'neutral', text: 'skipped in both', pill: 'pill-skipped', changed: false };
        if (bs === 'skipped') return { key: 'neutral', text: 'skipped in base', pill: 'pill-skipped', changed: true };
        if (fs === 'skipped') return { key: 'neutral', text: 'skipped in feature', pill: 'pill-skipped', changed: true };
        if (bs === 'missing' || fs === 'missing') return { key: 'neutral', text: bs + ' -> ' + fs, pill: 'pill-muted', changed: true };
        if (bs !== 'pass' && fs === 'pass') return { key: 'improved', text: 'improved (' + bs + ' -> pass)', pill: 'pill-pass', changed: true };
        if (bs === 'pass' && fs !== 'pass') return { key: 'regressed', text: 'regressed (pass -> ' + fs + ')', pill: 'pill-fail', changed: true };
        if (bs === 'pass' && fs === 'pass') return { key: 'stillPassing', text: 'still passing', pill: 'pill-info', changed: false };
        if (bs === 'fail' && fs === 'fail') return { key: 'stillFailing', text: 'still failing', pill: 'pill-fail', changed: false };
        if (fs === 'fail') return { key: 'regressed', text: bs + ' -> fail', pill: 'pill-fail', changed: true };
        return { key: 'other', text: bs + ' -> ' + fs, pill: 'pill-blocked', changed: bs !== fs };
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
          const [b, f] = autoPickCompareRuns(ticketRuns);
          state.compareBaseKey = b;
          state.compareFeatureKey = f;
        }

        const makeOptLabel = (r) => fmtTime(r.startedAt) + ' | ' + r.status + ' | ' + runTargetLabel(r) + (r.partial ? ' (--ac)' : '');
        const baseSel = el('select', {
          id: 'compareBaseSelect',
          'aria-label': 'Base run',
          onChange: (e) => {
            state.compareBaseKey = e.target.value;
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
            renderCompare(selectedRun, list);
            const node = document.getElementById('compareFeatSelect');
            if (node) node.focus();
          },
        }, ticketRuns.map(r => el('option', { value: runKey(r), text: makeOptLabel(r) })));
        featSel.value = state.compareFeatureKey;

        const swapBtn = el('button', {
          className: 'btn',
          text: 'Swap',
          onClick: () => {
            const tmp = state.compareBaseKey;
            state.compareBaseKey = state.compareFeatureKey;
            state.compareFeatureKey = tmp;
            renderCompare(selectedRun, list);
          },
        });
        const autoBtn = el('button', {
          className: 'btn btn-primary',
          text: 'Auto-pick 2 SHAs',
          onClick: () => {
            const [b, f] = autoPickCompareRuns(ticketRuns);
            state.compareBaseKey = b;
            state.compareFeatureKey = f;
            renderCompare(selectedRun, list);
          },
        });

        body.appendChild(el('div', { className: 'compare-bar' }, [
          el('strong', { className: 'mono', text: ticketName }),
          el('label', {}, [el('span', { text: 'Base:' }), baseSel]),
          el('label', {}, [el('span', { text: 'Feature:' }), featSel]),
          swapBtn,
          autoBtn,
        ]));

        const base = ticketRuns.find(r => runKey(r) === state.compareBaseKey);
        const feat = ticketRuns.find(r => runKey(r) === state.compareFeatureKey);
        if (!base || !feat) return;

        if (runKey(base) === runKey(feat)) {
          body.appendChild(el('div', { className: 'callout callout-warn', text: 'Base and Feature currently point to the same run.' }));
        }

        const sameDigest = base.proofDigest && feat.proofDigest && base.proofDigest === feat.proofDigest;
        body.appendChild(el('div', {
          className: 'callout ' + (sameDigest ? 'callout-ok' : 'callout-warn'),
          text: sameDigest
            ? 'Proof inputs digest matches: sha256:' + base.proofDigest + ' (identical checks, ACs, and CSV inputs).'
            : 'Proof inputs digest differs or is missing. Base: ' + (base.proofDigest || 'n/a') + ' | Feature: ' + (feat.proofDigest || 'n/a') + '.',
        }));

        if (base.partial || feat.partial) {
          body.appendChild(el('div', {
            className: 'callout callout-warn',
            text: 'Partial run warning: at least one side used --ac filtering. Skipped ACs are shown as neutral and excluded from improvement/regression counts.',
          }));
        }

        const allAcIds = [];
        const seen = new Set();
        for (const a of [...base.acs, ...feat.acs]) {
          if (!seen.has(a.id)) { seen.add(a.id); allAcIds.push(a.id); }
        }
        const baseMap = new Map(base.acs.map(a => [a.id, a]));
        const featMap = new Map(feat.acs.map(a => [a.id, a]));

        const tally = { improved: 0, regressed: 0, stillPassing: 0, stillFailing: 0, neutral: 0, other: 0 };
        const rows = allAcIds.map(id => {
          const b = baseMap.get(id);
          const f = featMap.get(id);
          const bs = b ? b.status : 'missing';
          const fs = f ? f.status : 'missing';
          const delta = classifyDelta(bs, fs);
          tally[delta.key] = (tally[delta.key] || 0) + 1;
          return { id, claim: (f && f.claim) || (b && b.claim) || '', b, f, delta };
        });

        body.appendChild(el('div', { className: 'controls' }, [
          el('span', { className: 'pill pill-pass', text: 'Improved: ' + tally.improved }),
          el('span', { className: 'pill pill-fail', text: 'Regressed: ' + tally.regressed }),
          el('span', { className: 'pill pill-fail', text: 'Still failing: ' + tally.stillFailing }),
          el('span', { className: 'pill pill-info', text: 'Still passing: ' + tally.stillPassing }),
          tally.neutral ? el('span', { className: 'pill pill-skipped', text: 'Skipped / missing: ' + tally.neutral }) : null,
          tally.other ? el('span', { className: 'pill pill-blocked', text: 'Blocked / other: ' + tally.other }) : null,
          el('button', {
            className: 'chip' + (state.compareChangedOnly ? ' active' : ''),
            'aria-pressed': String(state.compareChangedOnly),
            text: 'Changed only',
            onClick: () => { state.compareChangedOnly = !state.compareChangedOnly; renderCompare(selectedRun, list); },
          }),
          el('button', {
            className: 'chip' + (state.compareShowDetails ? ' active' : ''),
            'aria-pressed': String(state.compareShowDetails),
            text: 'Evidence details',
            onClick: () => { state.compareShowDetails = !state.compareShowDetails; renderCompare(selectedRun, list); },
          }),
        ]));

        const shownRows = state.compareChangedOnly ? rows.filter(r => r.delta.changed) : rows;
        if (!shownRows.length) {
          body.appendChild(el('div', { className: 'empty', text: 'No AC status changes between these two runs.' }));
          return;
        }

        const renderSideCell = (ac) => {
          if (!ac) return el('span', { className: 'pill pill-muted', text: 'missing' });
          const nodes = [statusPill(ac.status)];
          if (state.compareShowDetails && (ac.detail || ac.result)) {
            nodes.push(el('div', { className: 'cmp-detail mono', text: ac.detail || ac.result }));
          }
          return el('div', {}, nodes);
        };

        const table = el('table', {}, [
          el('thead', {}, el('tr', {}, [
            el('th', { style: { width: '78px' }, text: 'AC' }),
            el('th', { text: 'Claim' }),
            el('th', { style: { width: '210px' }, text: 'Base' }),
            el('th', { style: { width: '210px' }, text: 'Feature' }),
            el('th', { style: { width: '170px' }, text: 'Delta' }),
          ])),
          el('tbody', {}, shownRows.map(row => el('tr', {}, [
            el('td', { className: 'mono', text: row.id }),
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

        document.getElementById('resetFiltersBtn').style.display = hasActiveFilters() ? 'inline-flex' : 'none';

        const list = filteredRuns();
        if (list.length && !list.some(r => runKey(r) === state.selectedKey)) {
          state.selectedKey = runKey(list[0]);
          state.acFilter = 'all';
        }
        const selected = list.find(r => runKey(r) === state.selectedKey) || null;

        renderKpis(list);
        renderTimingChart(list);
        renderTicketChips();
        renderRunList(list);

        const tabInspect = document.getElementById('tabInspect');
        const tabCompare = document.getElementById('tabCompare');
        const detailBody = document.getElementById('detailBody');
        tabInspect.classList.toggle('active', state.activeTab === 'inspect');
        tabCompare.classList.toggle('active', state.activeTab === 'compare');
        tabInspect.setAttribute('aria-selected', String(state.activeTab === 'inspect'));
        tabCompare.setAttribute('aria-selected', String(state.activeTab === 'compare'));
        detailBody.setAttribute('aria-labelledby', state.activeTab === 'inspect' ? 'tabInspect' : 'tabCompare');
        document.getElementById('detailHeading').textContent = state.activeTab === 'inspect' ? 'Run Inspector' : 'Base vs Feature Compare';

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
        const list = filteredRuns();
        const hasTimed = list.some(r => Number.isFinite(r.durationMs) && r.durationMs > 0);
        const cur = state.timingExpanded === null ? hasTimed : state.timingExpanded;
        state.timingExpanded = !cur;
        renderTimingChart(list);
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
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <title>Proofs Dashboard</title>
  <style>
    :root {
      --bg: #0b1120;
      --surface: #111827;
      --surface-2: #172033;
      --surface-3: #1e293b;
      --border: rgba(148, 163, 184, 0.18);
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
      --radius: 12px;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--sans);
      background: radial-gradient(circle at top right, rgba(56, 189, 248, 0.08), transparent 36%), var(--bg);
      color: var(--text);
      line-height: 1.45;
      min-height: 100vh;
    }
    code, pre, .mono { font-family: var(--mono); }
    :focus-visible {
      outline: 2px solid var(--sky);
      outline-offset: 2px;
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
      padding: 14px 22px;
      background: rgba(11, 17, 32, 0.92);
      backdrop-filter: blur(10px);
      border-bottom: 1px solid var(--border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--sky);
      box-shadow: 0 0 12px rgba(56, 189, 248, 0.7);
    }
    .brand h1 {
      margin: 0;
      font-size: 1.05rem;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .brand-meta {
      font-size: 0.78rem;
      color: var(--text-muted);
      font-family: var(--mono);
    }
    .wrap {
      max-width: 1440px;
      margin: 0 auto;
      padding: 18px 22px 42px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(185px, 1fr));
      gap: 12px;
    }
    .kpi {
      background: var(--surface);
      border: 1px solid var(--border);
      border-top: 2px solid var(--accent, var(--sky));
      border-radius: var(--radius);
      padding: 13px 15px;
    }
    .kpi-label {
      font-size: 0.74rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-dim);
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 1.55rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .kpi-sub {
      margin-top: 4px;
      font-size: 0.76rem;
      color: var(--text-muted);
      font-family: var(--mono);
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
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
      background: rgba(23, 32, 51, 0.55);
    }
    .panel-title {
      margin: 0;
      font-size: 0.9rem;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    input[type="search"], select {
      background: var(--bg);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 6px 10px;
      font-size: 0.82rem;
      font-family: var(--sans);
      max-width: 100%;
      min-width: 0;
    }
    input[type="search"]:focus, select:focus { border-color: var(--sky); }
    button.btn {
      background: var(--surface-3);
      color: var(--text);
      border: 1px solid var(--border-strong);
      border-radius: 8px;
      padding: 6px 11px;
      font-size: 0.8rem;
      cursor: pointer;
      transition: background 0.15s, border-color 0.15s;
    }
    button.btn:hover { background: #263449; border-color: var(--sky); }
    button.btn-xs { padding: 3px 8px; font-size: 0.72rem; border-radius: 6px; }
    button.btn-primary {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.45);
      color: #7dd3fc;
    }
    .chip-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding: 10px 16px;
    }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      color: var(--text-dim);
      font-size: 0.78rem;
      font-family: var(--mono);
      cursor: pointer;
    }
    .chip:hover { border-color: var(--sky); color: var(--text); }
    .chip.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.55);
      color: #e0f2fe;
    }
    .workspace {
      display: grid;
      grid-template-columns: minmax(310px, 380px) minmax(0, 1fr);
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 980px) {
      .workspace { grid-template-columns: 1fr; }
    }
    .run-list {
      max-height: 760px;
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
      padding: 11px 14px;
      color: var(--text);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      gap: 5px;
      transition: background 0.12s;
    }
    .run-item:focus-visible { outline-offset: -2px; }
    .run-item:hover { background: rgba(56, 189, 248, 0.06); }
    .run-item.selected {
      background: rgba(56, 189, 248, 0.12);
      box-shadow: inset 3px 0 0 var(--sky);
    }
    .run-item-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .run-ticket {
      font-weight: 700;
      font-size: 0.86rem;
      font-family: var(--mono);
    }
    .run-sub {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 6px;
      font-size: 0.74rem;
      color: var(--text-muted);
      font-family: var(--mono);
    }
    .pill {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 0.7rem;
      font-weight: 600;
      font-family: var(--mono);
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .pill-pass { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; border-color: rgba(52, 211, 153, 0.35); }
    .pill-fail { background: rgba(251, 113, 133, 0.15); color: #fda4af; border-color: rgba(251, 113, 133, 0.35); }
    .pill-blocked { background: rgba(251, 191, 36, 0.14); color: #fde68a; border-color: rgba(251, 191, 36, 0.35); }
    .pill-uncovered { background: rgba(167, 139, 250, 0.14); color: #ddd6fe; border-color: rgba(167, 139, 250, 0.35); }
    .pill-skipped { background: rgba(148, 163, 184, 0.16); color: #e2e8f0; border-color: rgba(148, 163, 184, 0.32); }
    .pill-info { background: rgba(56, 189, 248, 0.14); color: #7dd3fc; border-color: rgba(56, 189, 248, 0.35); }
    .pill-muted { background: rgba(100, 116, 139, 0.18); color: #cbd5e1; border-color: rgba(148, 163, 184, 0.25); }
    .tabs { display: flex; gap: 6px; }
    .tab {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-dim);
      padding: 5px 11px;
      border-radius: 8px;
      font-size: 0.8rem;
      cursor: pointer;
    }
    .tab.active {
      background: rgba(56, 189, 248, 0.16);
      border-color: rgba(56, 189, 248, 0.5);
      color: #e0f2fe;
      font-weight: 600;
    }
    .detail-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .detail-header-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .meta-card {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .meta-k-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .meta-k {
      font-size: 0.7rem;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted);
      margin-bottom: 4px;
    }
    .meta-k-row .meta-k { margin-bottom: 0; }
    .meta-v {
      font-size: 0.8rem;
      font-family: var(--mono);
      word-break: break-word;
    }
    .meta-sub {
      margin-top: 4px;
      font-size: 0.73rem;
      color: var(--text-muted);
    }
    .phase-bar {
      display: flex;
      height: 10px;
      border-radius: 999px;
      overflow: hidden;
      background: var(--surface-3);
      margin-top: 6px;
    }
    .phase-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 6px;
      font-size: 0.74rem;
      color: var(--text-dim);
      font-family: var(--mono);
    }
    .swatch {
      display: inline-block;
      width: 9px;
      height: 9px;
      border-radius: 2px;
      margin-right: 4px;
      vertical-align: middle;
    }
    .svg-bar { cursor: pointer; }
    .svg-bar:focus-visible { outline: 2px solid var(--sky); }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.82rem;
    }
    th, td {
      text-align: left;
      padding: 9px 11px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-dim);
      background: rgba(23, 32, 51, 0.5);
    }
    .cmp-detail {
      margin-top: 5px;
      font-size: 0.72rem;
      color: var(--text-muted);
      word-break: break-word;
    }
    .callout {
      border-radius: 10px;
      padding: 10px 13px;
      border: 1px solid var(--border);
      background: var(--surface-2);
      font-size: 0.82rem;
    }
    .callout-warn { border-color: rgba(251, 191, 36, 0.4); background: rgba(251, 191, 36, 0.08); color: #fde68a; }
    .callout-err { border-color: rgba(251, 113, 133, 0.4); background: rgba(251, 113, 133, 0.08); color: #fecdd3; }
    .callout-ok { border-color: rgba(52, 211, 153, 0.35); background: rgba(52, 211, 153, 0.08); color: #a7f3d0; }
    .callout ul { margin: 6px 0 0 18px; padding: 0; }
    .chart-wrap {
      padding: 12px 16px 14px;
      overflow-x: auto;
    }
    .empty {
      padding: 32px 18px;
      text-align: center;
      color: var(--text-dim);
      font-size: 0.88rem;
    }
    .empty-compact { padding: 14px 12px; }
    .compare-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 10px 12px;
    }
    .compare-bar label {
      font-size: 0.78rem;
      color: var(--text-dim);
      display: flex;
      align-items: center;
      gap: 6px;
      flex: 1 1 240px;
      min-width: 0;
      max-width: 100%;
    }
    .compare-bar select {
      flex: 1 1 180px;
      min-width: 0;
      width: 100%;
      text-overflow: ellipsis;
    }
    .footer {
      text-align: center;
      font-size: 0.74rem;
      color: var(--text-muted);
      font-family: var(--mono);
      padding-top: 6px;
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
      <input type="search" id="searchInput" placeholder="Filter ticket, AC, SHA, branch... (/)" aria-label="Filter runs" />
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
      <select id="scopeFilter" aria-label="Filter by coverage">
        <option value="all">Full + partial</option>
        <option value="full">Full runs only</option>
        <option value="partial">Partial (--ac)</option>
      </select>
      <button type="button" class="btn btn-primary" id="resetFiltersBtn" style="display:none;">Reset filters</button>
    </div>
  </header>

  <main class="wrap">
    <section class="kpi-grid" id="kpiGrid" aria-label="Summary metrics"></section>

    <section class="panel" id="timingPanel">
      <div class="panel-head">
        <h2 class="panel-title">
          <span>Recent Run Timings</span>
          <span class="pill pill-muted" id="chartCaption"></span>
        </h2>
        <div class="controls">
          <div class="phase-legend" id="timingLegend" style="margin-top:0;"></div>
          <button type="button" class="btn btn-xs" id="timingToggle" aria-controls="timingChart" aria-expanded="false">Show chart</button>
        </div>
      </div>
      <div class="chart-wrap" id="timingChart"></div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <h2 class="panel-title">Tickets (30-Day Index)</h2>
        <span class="brand-meta" id="ticketCountMeta"></span>
      </div>
      <div class="chip-bar" id="ticketChips"></div>
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
            <button type="button" class="tab" id="tabCompare" role="tab" aria-selected="false" aria-controls="detailBody">Compare Base vs Feature</button>
          </div>
        </div>
        <div class="detail-body" id="detailBody" role="tabpanel" aria-labelledby="tabInspect"></div>
      </div>
    </section>

    <footer class="footer">
      Static snapshot generated from allowlisted runs.json metadata and redacted report.md files. Private diagnostics/ contents and context values are never embedded. Keys: / search, j/k next/prev run, i/c inspect/compare.
    </footer>
  </main>

  <script id="proofs-data" type="application/json">${payload}</script>
  <script>${CLIENT_SCRIPT}</script>
</body>
</html>
`;
}

export async function writeDashboard(outDir, { now = Date.now() } = {}) {
  await checkPrivateDir(outDir);
  return withLock(outDir, async () => {
    const data = await collectDashboardData(outDir, { now });
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
