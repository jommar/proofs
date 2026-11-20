import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const acTag = /^@AC[1-9]\d*$/;
export const blockRow = reason => ({ status: 'blocked', observed: { reason } });

export function safeFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return false;
  const credentials = [process.env.PROOF_USERNAME, process.env.PROOF_PASSWORD].filter(Boolean);
  const fields = Object.entries(facts);
  return fields.length > 0 && fields.length <= 12 && fields.every(([key, value]) =>
    /^[a-zA-Z][a-zA-Z0-9_]{0,47}$/.test(key) &&
    !credentials.some(credential => key.includes(credential)) &&
    (typeof value === 'boolean' || (Number.isSafeInteger(value) && value >= 0)));
}

export function safeReason(reason) {
  const credentials = [process.env.PROOF_USERNAME, process.env.PROOF_PASSWORD].filter(Boolean);
  return typeof reason === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(reason) &&
    !credentials.some(credential => reason.includes(credential)) ? reason : 'unmet_prerequisite';
}

function withCriteria(test, rows) {
  const criteria = [...new Set(test.tags.filter(tag => acTag.test(tag)))].map(tag => tag.slice(1));
  if (criteria.length > 1) return criteria.map(ac => ({ ac, ...blockRow('multiple_ac_tags') }));
  return criteria.flatMap(ac => rows.map(row => ({ ac, ...row })));
}

export default class EvidenceReporter {
  rows = [];
  diagnostics = [];
  completed = new Set();
  fatal = false;

  onBegin(_config, suite) { this.expected = suite.allTests(); }

  onError(error) {
    this.fatal = true;
    this.diagnostics.push({ kind: 'fatal', message: error?.message ?? String(error), stack: error?.stack });
  }

  onTestEnd(test, result) {
    this.completed.add(test.id);
    const evidence = [];
    for (const note of result.annotations.filter(note => note.type === 'proof-evidence')) {
      try {
        const { status, observed } = JSON.parse(note.description);
        if (status === 'blocked') evidence.push(blockRow(safeReason(observed?.reason)));
        else if (['pass', 'fail'].includes(status) && safeFacts(observed)) evidence.push({ status, observed });
      } catch { /* malformed annotation is not evidence */ }
    }
    const blocked = evidence.find(row => row.status === 'blocked');
    const failed = evidence.find(row => row.status === 'fail');
    let rows;
    if (blocked || failed) rows = [blocked ?? failed];
    else if (result.status === 'passed' && evidence.length) rows = evidence;
    else rows = [blockRow(result.status === 'passed' ? 'no_explicit_check' : 'scenario_incomplete')];
    this.rows.push(...withCriteria(test, rows));
    if (process.env.PROOF_DIAGNOSTICS_DIR && (result.status !== 'passed' || blocked || failed || process.env.PROOF_DEBUG === '1')) {
      this.diagnostics.push({
        title: test.title,
        tags: test.tags,
        status: result.status,
        durationMs: result.duration,
        outcome: rows,
        errors: (result.errors ?? []).map(error => ({ message: error?.message ?? String(error), stack: error?.stack })),
      });
    }
  }

  onEnd({ status }) {
    const expected = this.expected ?? [];
    const missing = expected.filter(test => !this.completed.has(test.id));
    const complete = !this.fatal && missing.length === 0 && ['passed', 'failed'].includes(status);
    for (const test of missing) {
      this.rows.push(...withCriteria(test, [blockRow('scenario_not_run')]));
      if (process.env.PROOF_DIAGNOSTICS_DIR) {
        this.diagnostics.push({ title: test.title, tags: test.tags, status: 'not_run' });
      }
    }
    writeFileSync(process.env.PROOF_BDD_EVIDENCE, JSON.stringify({ complete, status, rows: this.rows }), { mode: 0o600 });
    if (process.env.PROOF_DIAGNOSTICS_DIR && this.diagnostics.length) {
      try {
        writeFileSync(
          join(process.env.PROOF_DIAGNOSTICS_DIR, 'bdd-failures.json'),
          `${JSON.stringify({ status, complete, entries: this.diagnostics }, null, 2)}\n`,
          { mode: 0o600 },
        );
      } catch { /* never let diagnostic I/O break evidence publishing */ }
    }
  }

  printsToStdio() { return true; }
}
