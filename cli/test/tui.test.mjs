import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  select, multiselect, confirm, CancelError, restoreAll, createPrompter, colors, truncate, visibleLength,
} from "../lib/tui.mjs";
import { runSetup } from "../lib/setup.mjs";

/**
 * A terminal stand-in: real streams carrying real key bytes (readline decodes
 * them into keypresses exactly as it does for a TTY), plus a setRawMode that
 * records what the prompt asked of the terminal.
 */
function terminal({ outputTTY = false } = {}) {
  const input = new PassThrough();
  input.isTTY = true;
  input.isRaw = false;
  input.rawCalls = [];
  input.setRawMode = (v) => { input.rawCalls.push(v); input.isRaw = v; return input; };
  const output = new PassThrough();
  output.columns = 80;
  if (outputTTY) output.isTTY = true;
  let text = "";
  output.on("data", (d) => (text += d));
  return { input, output, text: () => text, type: (s) => setImmediate(() => input.write(s)) };
}
const env = { NO_COLOR: "1" };
const SHOW_CURSOR = "\x1b[?25h";
/** Let stream data queued by the prompt reach the collector. */
const settle = () => new Promise((r) => setImmediate(r));

test("select: arrows/j/k move, enter picks; raw mode on during, off after; cursor restored", async () => {
  const t = terminal();
  const p = select({ message: "Pick", choices: [{ label: "A", value: "a" }, { label: "B", value: "b" }, { label: "C", value: "c" }], input: t.input, output: t.output, env });
  t.type("\x1b[B"); // down → B
  t.type("j"); // down → C
  t.type("k"); // up → B
  t.type("\r");
  assert.equal(await p, "b");
  await settle();
  assert.deepEqual(t.input.rawCalls, [true, false]);
  assert.ok(t.text().endsWith(SHOW_CURSOR), "cursor shown again");
  assert.match(t.text(), /✓ Pick {2}B/);
  assert.equal(t.input.listenerCount("keypress"), 0, "no keypress listener left behind");
});

test("multiselect: space toggles, a toggles all, enter returns ticked values in order", async () => {
  const t = terminal();
  const choices = [{ label: "Claude", value: "c", checked: true }, { label: "Codex", value: "x" }, { label: "Aider", value: "a" }];
  const p = multiselect({ message: "Agents", choices, input: t.input, output: t.output, env });
  t.type("j");
  t.type(" "); // tick Codex
  t.type("\r");
  assert.deepEqual(await p, ["c", "x"]);

  const t2 = terminal();
  const p2 = multiselect({ message: "Agents", choices, input: t2.input, output: t2.output, env });
  t2.type("a"); // not all ticked → tick all
  t2.type("\r");
  assert.deepEqual(await p2, ["c", "x", "a"]);

  const t3 = terminal();
  const p3 = multiselect({ message: "Agents", choices: choices.map((c) => ({ ...c, checked: true })), input: t3.input, output: t3.output, env });
  t3.type("a"); // all ticked → none
  t3.type("\r");
  assert.deepEqual(await p3, []);
});

test("confirm: y / n / enter for the default", async () => {
  for (const [keys, initial, want] of [["y", false, true], ["n", true, false], ["\r", true, true], ["\r", false, false]]) {
    const t = terminal();
    const p = confirm({ message: "Go?", initial, input: t.input, output: t.output, env });
    t.type(keys);
    assert.equal(await p, want);
  }
});

test("Ctrl-C rejects with CancelError and restores the terminal", async () => {
  const t = terminal();
  const p = select({ message: "Pick", choices: [{ label: "A", value: "a" }], input: t.input, output: t.output, env });
  t.type("\x03");
  await assert.rejects(p, CancelError);
  await settle();
  assert.deepEqual(t.input.rawCalls, [true, false]);
  assert.ok(t.text().endsWith(SHOW_CURSOR));
  assert.equal(t.input.listenerCount("keypress"), 0);
});

test("restoreAll (run on exit / SIGINT) puts a prompt's terminal back", async () => {
  const t = terminal();
  void confirm({ message: "Go?", input: t.input, output: t.output, env }).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(t.input.isRaw, true);
  restoreAll();
  await settle();
  assert.equal(t.input.isRaw, false);
  assert.ok(t.text().endsWith(SHOW_CURSOR));
  restoreAll(); // idempotent
  assert.deepEqual(t.input.rawCalls, [true, false]);
});

test("Ctrl-C inside the wizard's text prompt cancels setup cleanly (exit 130, terminal restored)", async () => {
  const home = mkdtempSync(join(tmpdir(), "reins-tui-home-"));
  const repo = mkdtempSync(join(tmpdir(), "reins-tui-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  const t = terminal({ outputTTY: true });
  const run = runSetup({ _: [] }, { input: t.input, output: t.output, env, home, cwd: repo, interactive: true });
  setTimeout(() => t.input.write("\x03"), 100); // at the "Reins server" prompt
  assert.equal(await run, 130);
  await settle();
  assert.match(t.text(), /Setup cancelled/);
  assert.equal(t.input.isRaw, false, "raw mode is off again");
});

test("headless prompter answers every prompt with its default and never touches the terminal", async () => {
  const t = terminal();
  const p = createPrompter({ interactive: false, input: t.input, output: t.output, env });
  assert.equal(await p.select({ message: "x", choices: [{ value: 1 }, { value: 2 }], initial: 1 }), 2);
  assert.deepEqual(await p.multiselect({ message: "x", choices: [{ value: 1, checked: true }, { value: 2 }] }), [1]);
  assert.equal(await p.confirm({ message: "x", initial: false }), false);
  assert.equal(await p.text({ message: "x", initial: "https://r.dev" }), "https://r.dev");
  await settle();
  assert.deepEqual(t.input.rawCalls, []);
  assert.equal(t.text(), "");
});

test("colour respects NO_COLOR, TERM=dumb and non-TTY output; truncate keeps narrow lines narrow", () => {
  const tty = { isTTY: true };
  assert.equal(colors(tty, {}).green("x"), "\x1b[32mx\x1b[39m");
  assert.equal(colors(tty, { NO_COLOR: "1" }).green("x"), "x");
  assert.equal(colors(tty, { TERM: "dumb" }).green("x"), "x");
  assert.equal(colors({ isTTY: false }, {}).green("x"), "x");
  assert.equal(truncate("abcdefghij", 5), "abcd…");
  assert.equal(truncate("abc", 5), "abc");
  assert.equal(visibleLength("\x1b[32mabc\x1b[39m"), 3);
});

test("a narrow terminal truncates prompt lines instead of wrapping them", async () => {
  const t = terminal();
  t.output.columns = 24;
  const p = select({ message: "Pick", choices: [{ label: "A very long choice label that would wrap", value: 1 }], input: t.input, output: t.output, env });
  t.type("\r");
  await p;
  await settle();
  const frames = t.text().replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").split("\n");
  assert.ok(frames.every((l) => l.length <= 23), `every line fits: ${JSON.stringify(frames)}`);
});
