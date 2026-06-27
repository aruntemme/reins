// Serial (bounded-concurrency) work queue for distillation.
//
// The distill LLM lives behind a rate-limited gateway: firing one call per
// ingested event means a burst of N events launches N concurrent calls, most of
// which get throttled and dropped (the fire-and-forget catch swallows the error,
// so the board silently loses those events). This queue funnels every distill
// through a fixed number of workers — 1 by default, so calls run strictly one at
// a time — turning a thundering herd into an orderly drain.
//
// Concurrency is configurable (REINS_DISTILL_CONCURRENCY) for endpoints that
// tolerate parallelism; keep it at 1 for a hard-rate-limited backend.

export type Job = () => Promise<void>;

const CONCURRENCY = Math.max(1, Math.floor(Number(process.env.REINS_DISTILL_CONCURRENCY) || 1));

const pending: Job[] = [];
let active = 0;

function pump(): void {
  while (active < CONCURRENCY && pending.length > 0) {
    const job = pending.shift()!;
    active++;
    // A job is already wrapped to never reject (see enqueue), but guard anyway so
    // one bad job can never wedge the worker slot.
    Promise.resolve()
      .then(job)
      .catch(() => {})
      .finally(() => {
        active--;
        pump();
      });
  }
}

/** Enqueue a distill job. Returns immediately; the job runs when a slot frees. */
export function enqueueDistill(job: Job): void {
  pending.push(job);
  pump();
}

/** Total work outstanding (queued + running) — for observability/tests. */
export function distillQueueDepth(): { queued: number; active: number; concurrency: number } {
  return { queued: pending.length, active, concurrency: CONCURRENCY };
}
