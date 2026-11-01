/**
 * Tiny, dependency-free terminal prompts for the setup wizard.
 *
 *   select       ↑/↓ or j/k to move, enter to pick
 *   multiselect  space toggles, a toggles all, enter confirms
 *   confirm      y / n / enter for the default
 *   text         an editable line, pre-filled with the default
 *   spinner      for anything that waits on the network
 *
 * Layout helpers print numbered steps with ✓ / ! / ✗ marks and dim hints. Colour
 * is off when NO_COLOR is set, TERM=dumb, or output isn't a TTY. Every prompt
 * restores the terminal (raw mode off, cursor shown) when it finishes, on
 * Ctrl-C (which rejects with CancelError), and on process exit or SIGINT/SIGTERM.
 */
import readline from "node:readline";

export class CancelError extends Error {
  constructor() {
    super("cancelled");
    this.name = "CancelError";
  }
}

const SHOW_CURSOR = "\x1b[?25h";
const HIDE_CURSOR = "\x1b[?25l";

// ---------------------------------------------------------------- terminal restore

const cleanups = new Set();
let guarded = false;

/** Run every pending terminal cleanup (raw mode off, cursor on). Idempotent. */
export function restoreAll() {
  for (const fn of [...cleanups]) {
    try { fn(); } catch { /* keep restoring the rest */ }
  }
  cleanups.clear();
}

/** Restore the terminal on exit and turn SIGINT/SIGTERM into a clean exit. */
function guard() {
  if (guarded) return;
  guarded = true;
  process.on("exit", restoreAll);
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      restoreAll();
      process.exit(130);
    });
  }
}

function track(fn) {
  guard();
  cleanups.add(fn);
  return () => {
    cleanups.delete(fn);
    fn();
  };
}

// ---------------------------------------------------------------- colour + layout

export function useColor(stream = process.stdout, env = process.env) {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  return !!stream.isTTY;
}

export function colors(stream = process.stdout, env = process.env) {
  const on = useColor(stream, env);
  const wrap = (a, b) => (s) => (on ? `\x1b[${a}m${s}\x1b[${b}m` : String(s));
  return {
    on,
    b: wrap(1, 22),
    dim: wrap(2, 22),
    inverse: wrap(7, 27),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
    blue: wrap(34, 39),
    magenta: wrap(35, 39),
    cyan: wrap(36, 39),
  };
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const visibleLength = (s) => String(s).replace(ANSI, "").length;

export function termWidth(stream = process.stdout) {
  return Math.max(20, Number(stream.columns) || 80);
}

/** Cut plain text to `width` columns (with an ellipsis). */
export function truncate(s, width) {
  const str = String(s);
  if (width <= 1) return str.slice(0, Math.max(0, width));
  return str.length > width ? `${str.slice(0, width - 1)}…` : str;
}

/**
 * Step layout. `step(1, "Repository")` prints a numbered heading; ok/warn/err/
 * info/hint print indented lines under it.
 */
export function createUI({ output = process.stdout, env = process.env } = {}) {
  const c = colors(output, env);
  const write = (s = "") => output.write(`${s}\n`);
  const PAD = "     ";
  const indent = (s) => String(s).split("\n").map((l, i) => (i ? `${PAD}  ${l}` : l)).join("\n");
  return {
    c,
    write,
    width: () => termWidth(output),
    banner(title, sub) {
      write("");
      write(`  ${c.b(c.magenta("◆"))} ${c.b(title)}${sub ? c.dim(`  ·  ${sub}`) : ""}`);
    },
    step(n, title) {
      write("");
      write(`  ${c.cyan(c.b(String(n)))}  ${c.b(title)}`);
    },
    ok: (s) => write(`${PAD}${c.green("✓")} ${indent(s)}`),
    warn: (s) => write(`${PAD}${c.yellow("!")} ${indent(s)}`),
    err: (s) => write(`${PAD}${c.red("✗")} ${indent(s)}`),
    info: (s) => write(`${PAD}  ${indent(s)}`),
    hint: (s) => write(`${PAD}  ${c.dim(indent(s))}`),
    kv(label, value, w = 9) {
      write(`${PAD}  ${c.dim(String(label).padEnd(w))} ${value}`);
    },
  };
}

// ---------------------------------------------------------------- key loop

/**
 * The raw-mode loop under select/multiselect/confirm. `render(done)` returns the
 * prompt's lines; `onKey(str, key)` returns {done: value} to finish, anything
 * else to redraw. Ctrl-C restores the terminal and rejects with CancelError.
 */
export function keyLoop({ input = process.stdin, output = process.stdout, render, onKey }) {
  return new Promise((resolve, reject) => {
    readline.emitKeypressEvents(input);
    const raw = !!(input.isTTY && typeof input.setRawMode === "function");
    const wasRaw = !!input.isRaw;
    if (raw) input.setRawMode(true);
    input.resume();
    output.write(HIDE_CURSOR);
    let drawn = 0;
    const draw = (done) => {
      const width = termWidth(output);
      const lines = render(done).map((l) => (visibleLength(l) > width - 1 ? truncateAnsi(l, width - 1) : l));
      let out = "";
      if (drawn) out += `\x1b[${drawn}A\r\x1b[0J`;
      out += lines.join("\n") + "\n";
      output.write(out);
      drawn = lines.length;
    };
    let finished = false;
    const restore = () => {
      input.removeListener("keypress", onKeypress);
      if (raw) { try { input.setRawMode(wasRaw); } catch { /* closed */ } }
      input.pause();
      output.write(SHOW_CURSOR);
    };
    const release = track(restore);
    function onKeypress(str, key = {}) {
      if (finished) return;
      if (key && key.ctrl && key.name === "c") {
        finished = true;
        release();
        reject(new CancelError());
        return;
      }
      let r;
      try { r = onKey(str, key || {}); } catch (e) { finished = true; release(); reject(e); return; }
      if (r && Object.prototype.hasOwnProperty.call(r, "done")) {
        finished = true;
        draw(true);
        release();
        resolve(r.done);
      } else draw(false);
    }
    input.on("keypress", onKeypress);
    draw(false);
  });
}

/** Truncate a string that may hold colour codes to `width` visible columns. */
function truncateAnsi(s, width) {
  let out = "";
  let seen = 0;
  for (let i = 0; i < s.length; ) {
    const m =s[i] === "\x1b" ? /^\x1b\[[0-9;?]*[A-Za-z]/.exec(s.slice(i)) : null;
    if (m) { out += m[0]; i += m[0].length; continue; }
    if (seen >= width - 1) { out += "…"; break; }
    out += s[i];
    seen++;
    i++;
  }
  return out + "\x1b[0m";
}

const isUp = (str, key) => key.name === "up" || str === "k";
const isDown = (str, key) => key.name === "down" || str === "j";
const isEnter = (key) => key.name === "return" || key.name === "enter";

// ---------------------------------------------------------------- prompts

/**
 * Pick one. choices: [{label, value, hint?}]. Resolves to the chosen value.
 */
export function select({ message, choices, initial = 0, input, output, env }) {
  const c = colors(output || process.stdout, env);
  let i = Math.min(Math.max(0, initial), choices.length - 1);
  return keyLoop({
    input, output,
    render(done) {
      if (done) return [`  ${c.green("✓")} ${message}  ${c.cyan(choices[i].label)}`];
      return [
        `  ${c.cyan("?")} ${c.b(message)}`,
        ...choices.map((ch, k) =>
          k === i
            ? `    ${c.cyan("❯")} ${c.cyan(ch.label)}${ch.hint ? `  ${c.dim(ch.hint)}` : ""}`
            : `      ${ch.label}${ch.hint ? `  ${c.dim(ch.hint)}` : ""}`),
        `    ${c.dim("↑/↓ move · enter select")}`,
      ];
    },
    onKey(str, key) {
      if (isUp(str, key)) i = (i - 1 + choices.length) % choices.length;
      else if (isDown(str, key)) i = (i + 1) % choices.length;
      else if (isEnter(key)) return { done: choices[i].value };
    },
  });
}

/**
 * Pick any. choices: [{label, value, hint?, checked?}]. Resolves to the values
 * that are ticked, in choice order.
 */
export function multiselect({ message, choices, input, output, env }) {
  const c = colors(output || process.stdout, env);
  const on = choices.map((ch) => !!ch.checked);
  let i = 0;
  return keyLoop({
    input, output,
    render(done) {
      if (done) {
        const picked = choices.filter((_, k) => on[k]).map((ch) => ch.label);
        return [`  ${c.green("✓")} ${message}  ${c.cyan(picked.length ? picked.join(", ") : "none")}`];
      }
      return [
        `  ${c.cyan("?")} ${c.b(message)}`,
        ...choices.map((ch, k) => {
          const box = on[k] ? c.green("◉") : c.dim("◯");
          const cur = k === i ? c.cyan("❯") : " ";
          const label = k === i ? c.cyan(ch.label) : ch.label;
          return `    ${cur} ${box} ${label}${ch.hint ? `  ${c.dim(ch.hint)}` : ""}`;
        }),
        `    ${c.dim("↑/↓ move · space toggle · a all · enter confirm")}`,
      ];
    },
    onKey(str, key) {
      if (isUp(str, key)) i = (i - 1 + choices.length) % choices.length;
      else if (isDown(str, key)) i = (i + 1) % choices.length;
      else if (key.name === "space" || str === " ") on[i] = !on[i];
      else if (str === "a") { const all = on.every(Boolean); on.fill(!all); }
      else if (isEnter(key)) return { done: choices.filter((_, k) => on[k]).map((ch) => ch.value) };
    },
  });
}

/** Yes/no. Resolves to a boolean. */
export function confirm({ message, initial = true, input, output, env }) {
  const c = colors(output || process.stdout, env);
  let answer = initial;
  return keyLoop({
    input, output,
    render(done) {
      if (done) return [`  ${c.green("✓")} ${message}  ${c.cyan(answer ? "yes" : "no")}`];
      return [`  ${c.cyan("?")} ${c.b(message)} ${c.dim(initial ? "(Y/n)" : "(y/N)")}`];
    },
    onKey(str, key) {
      const s = (str || "").toLowerCase();
      if (s === "y") { answer = true; return { done: true }; }
      if (s === "n") { answer = false; return { done: false }; }
      if (isEnter(key)) return { done: initial };
    },
  });
}

/**
 * One line of text, pre-filled with `initial` so it can be edited in place.
 * `validate(value)` returns an error message to re-ask, or nothing.
 */
export async function text({ message, initial = "", validate, input = process.stdin, output = process.stdout, env }) {
  const c = colors(output, env);
  for (;;) {
    const value = await new Promise((resolve, reject) => {
      const rl = readline.createInterface({ input, output, terminal: !!(input.isTTY && output.isTTY) });
      const release = track(() => { try { rl.close(); } catch { /* closed */ } output.write(SHOW_CURSOR); });
      rl.on("SIGINT", () => { release(); output.write("\n"); reject(new CancelError()); });
      rl.question(`  ${c.cyan("?")} ${c.b(message)} `, (answer) => { release(); resolve(answer.trim()); });
      if (initial) rl.write(initial);
    });
    const problem = validate ? validate(value) : null;
    if (!problem) return value;
    output.write(`    ${c.red(problem)}\n`);
    initial = value;
  }
}

/**
 * A one-line spinner. Without a TTY it prints the text once (no animation).
 * stop(line) replaces it with a final line (or clears it when omitted).
 */
export function spinner(label, { output = process.stdout, env } = {}) {
  const c = colors(output, env);
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let text = label;
  if (!output.isTTY) {
    output.write(`       ${text}\n`);
    return { update(t) { text = t; }, stop(line) { if (line) output.write(`${line}\n`); } };
  }
  let k = 0;
  const paint = () => output.write(`\r\x1b[2K     ${c.cyan(frames[k++ % frames.length])} ${truncate(text, termWidth(output) - 8)}`);
  output.write(HIDE_CURSOR);
  paint();
  const timer = setInterval(paint, 80);
  const release = track(() => { clearInterval(timer); output.write(`\r\x1b[2K${SHOW_CURSOR}`); });
  return {
    update(t) { text = t; },
    stop(line) {
      release();
      if (line) output.write(`${line}\n`);
    },
  };
}

/**
 * The prompts the wizard calls. With `interactive: false` every prompt returns
 * its default without touching the terminal, so the same wizard code runs
 * headless (flags fill the answers, --yes accepts the rest).
 */
export function createPrompter({ interactive, input = process.stdin, output = process.stdout, env = process.env }) {
  const io = { input, output, env };
  return {
    interactive,
    select: (o) => (interactive ? select({ ...o, ...io }) : Promise.resolve(o.choices[o.initial ?? 0]?.value)),
    multiselect: (o) => (interactive ? multiselect({ ...o, ...io }) : Promise.resolve(o.choices.filter((ch) => ch.checked).map((ch) => ch.value))),
    confirm: (o) => (interactive ? confirm({ ...o, ...io }) : Promise.resolve(o.initial ?? true)),
    text: (o) => (interactive ? text({ ...o, ...io }) : Promise.resolve(o.initial ?? "")),
    spinner: (label) => spinner(label, io),
  };
}
