// Serial (bounded-concurrency) work queue for distillation.
//
// The distill LLM lives behind a rate-limited gateway: firing one call per
// ingested event means a burst of N events launches N concurrent calls, most of
// which get throttled and dropped (the fire-and-forget catch swallows the error,
// so the board silently loses those events). This queue funnels every distill
// through a fixed number of workers — 1 by default, so calls run strictly one at
// a time — turning a thundering herd into an orderly drain.
//
// Work is split into LANES, one per inference backend (provider), each with its
// own worker budget: a slow or throttled tenant's provider only backs up its own
// lane instead of stalling every workspace behind it. Jobs that share a KEY (one
// member's events) never overlap and run in enqueue order, so a teammate's board
// is always updated in the order they worked.
//
// Concurrency per lane is configurable (REINS_DISTILL_CONCURRENCY) for endpoints
// that tolerate parallelism; keep it at 1 for a hard-rate-limited backend.

export type Job = () => Promise<void>;
export interface JobOpts {
  /** Which backend this job calls (see backendKey in llm/client.ts). */
  lane?: string;
  /** Ordering key: jobs with the same key run one at a time, in order. */
  key?: string;
}

const CONCURRENCY = Math.max(1, Math.floor(Number(process.env.REINS_DISTILL_CONCURRENCY) || 1));

interface Entry { job: Job; lane: string; key?: string }

const pending: Entry[] = [];
const activeByLane = new Map<string, number>();
const activeKeys = new Set<string>();
let active = 0;
let paused = false;

function pump(): void {
  if (paused) return;
  // Keys seen waiting in this scan: a later job with the same key must not
  // overtake an earlier one, even if it sits in a freer lane.
  const held = new Set<string>();
  for (let i = 0; i < pending.length; ) {
    const e = pending[i]!;
    const laneFull = (activeByLane.get(e.lane) ?? 0) >= CONCURRENCY;
    if (laneFull || (e.key && (activeKeys.has(e.key) || held.has(e.key)))) {
      if (e.key) held.add(e.key);
      i++;
      continue;
    }
    pending.splice(i, 1);
    start(e);
  }
}

function start(e: Entry): void {
  active++;
  activeByLane.set(e.lane, (activeByLane.get(e.lane) ?? 0) + 1);
  if (e.key) activeKeys.add(e.key);
  // A job is already wrapped to never reject (see ingest), but guard anyway so
  // one bad job can never wedge the worker slot.
  Promise.resolve()
    .then(e.job)
    .catch(() => {})
    .finally(() => {
      active--;
      const n = (activeByLane.get(e.lane) ?? 1) - 1;
      if (n > 0) activeByLane.set(e.lane, n);
      else activeByLane.delete(e.lane);
      if (e.key) activeKeys.delete(e.key);
      pump();
    });
}

/** Enqueue a distill job. Returns immediately; the job runs when a slot frees. */
export function enqueueDistill(job: Job, opts: JobOpts = {}): void {
  pending.push({ job, lane: opts.lane ?? "default", key: opts.key });
  pump();
}

/** Stop starting queued jobs (graceful shutdown). Running jobs finish; queued
 *  ones stay undistilled in the DB and are re-enqueued on the next boot. */
export function pauseDistill(): void {
  paused = true;
}

/** Total work outstanding (queued + running) — for observability/tests. */
export function distillQueueDepth(): { queued: number; active: number; concurrency: number } {
  return { queued: pending.length, active, concurrency: CONCURRENCY };
}
