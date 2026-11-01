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

test("lanes are independent: a slow backend doesn't hold up another backend's jobs", async () => {
  await drain();
  const order: string[] = [];
  enqueueDistill(async () => { await sleep(200); order.push("slow"); }, { lane: "slow-provider" });
  enqueueDistill(async () => { order.push("fast"); }, { lane: "fast-provider" });
  await drain();
  assert.deepEqual(order, ["fast", "slow"], "the fast lane finished while the slow one was still busy");
});

test("jobs with the same key never overlap and keep their order, even across lanes", async () => {
  await drain();
  const log: string[] = [];
  let running = 0;
  let overlap = false;
  const job = (name: string, ms: number) => async () => {
    running++;
    if (running > 1) overlap = true;
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    running--;
  };
  // Same member, but the provider changed between events (different lanes).
  enqueueDistill(job("1", 60), { lane: "A", key: "proj\u0000asha" });
  enqueueDistill(job("2", 5), { lane: "B", key: "proj\u0000asha" });
  enqueueDistill(job("3", 5), { lane: "B", key: "proj\u0000asha" });
  await drain();
  assert.equal(overlap, false);
  assert.deepEqual(log, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});
