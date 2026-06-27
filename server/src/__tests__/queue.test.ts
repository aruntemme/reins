import { test } from "node:test";
import assert from "node:assert/strict";

// Default concurrency is 1 (no env override) — the serial guarantee we rely on.
const { enqueueDistill, distillQueueDepth } = await import("../pipeline/queue.js");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drain(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = distillQueueDepth();
    if (d.queued === 0 && d.active === 0) return;
    await sleep(10);
  }
  throw new Error("queue did not drain in time");
}

test("default queue runs jobs strictly one at a time, in FIFO order", async () => {
  assert.equal(distillQueueDepth().concurrency, 1, "default concurrency is serial");

  let active = 0;
  let maxActive = 0;
  const finishedOrder: number[] = [];

  for (let i = 0; i < 6; i++) {
    enqueueDistill(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      // Hold the slot briefly — if anything ran concurrently, maxActive would climb.
      await sleep(15);
      finishedOrder.push(i);
      active--;
    });
  }

  // Right after enqueue: at most one running, the rest queued.
  const depth = distillQueueDepth();
  assert.ok(depth.active <= 1, "no more than one job active");
  assert.equal(depth.active + depth.queued, 6, "all six are accounted for");

  await drain();

  assert.equal(maxActive, 1, "jobs never overlapped");
  assert.deepEqual(finishedOrder, [0, 1, 2, 3, 4, 5], "completed in FIFO order");
});

test("a throwing job never wedges the worker — later jobs still run", async () => {
  await drain();
  const done: number[] = [];

  enqueueDistill(async () => { throw new Error("boom"); });
  enqueueDistill(async () => { done.push(1); });
  enqueueDistill(async () => { await sleep(5); done.push(2); });

  await drain();
  assert.deepEqual(done, [1, 2], "the failed job didn't block the queue");
});
