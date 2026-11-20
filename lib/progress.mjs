import { writeDashboard } from './dashboard.mjs';
import { recordRun } from './runs.mjs';

const HEARTBEAT_MS = 15_000;

// Live progress of a run in .proofs-out: a running entry in runs.json, rewritten on each phase and on a heartbeat, and
// a rebuilt dashboard after each write. Writes are queued so they never overlap, and a failed write only marks the
// warning that stop() returns: it never fails or changes the run. `announce` hears each phase name as it starts (the
// console line), from the same call that records it, so the two cannot drift.
export async function startProgress(out, ticket, id, describe, announce = () => {}) {
  let phase = 'setup';
  let queue = Promise.resolve();
  let failed = false;
  const write = () => {
    queue = queue.then(() => recordRun(out, ticket, id, describe(phase)).then(() => writeDashboard(out)))
      .catch(() => { failed = true; });
    return queue;
  };
  const enter = next => {
    phase = next;
    try { announce(next); } catch { /* console output never fails or changes the run */ }
    return write();
  };
  const heartbeat = setInterval(write, HEARTBEAT_MS);
  heartbeat.unref();
  await enter(phase);
  return {
    phase: enter,
    stop: async () => {
      clearInterval(heartbeat);
      await queue;
      return failed ? 'Live progress in .proofs-out/runs.json could not be updated.' : undefined;
    },
  };
}
