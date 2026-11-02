"use client";
import { use, useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, type ItemData, type ItemKind, type ItemStep, type Post, type Who } from "@/lib/api";
import { PageState, PhoneTabs, StaleNote, WorkHeader, useAction, useNow, useWork } from "@/components/work/shell";
import { AgentTile, Avatar, SectionHead, agentLabel } from "@/components/work/bits";
import { AskCard } from "@/components/work/needs";
import { EditItemDialog, HandoverDialog } from "@/components/work/dialogs";
import { KIND_LABEL, agentName, ago, base, clock, plural, shortDate, voice } from "@/components/work/format";

const GROUP: Record<ItemKind, string> = { feature: "Features", bug: "Bugs", try: "Trying out", chore: "Chores" };
const POST_KIND: Record<Post["kind"], string> = {
  handover: "Handed over",
  update: "Update",
  question: "Asked",
  answer: "Answered",
  review: "Review",
  decision: "Decision",
  note: "Note",
  finding: "Finding",
};
const STATUS_TEXT: Record<ItemData["item"]["status"], string> = {
  open: "Open",
  doing: "In progress",
  waiting: "Waiting",
  blocked: "Blocked",
  paused: "Paused",
  done: "Done",
};

function stepMeta(s: ItemStep, i: number, firstOpen: number, waitingOnYou: boolean, now: number): { text: string; tone: string } {
  if (s.done) {
    const by = s.doneBy && s.doneSource && agentName(s.doneSource)
      ? `${s.doneBy.displayName}’s ${agentName(s.doneSource)}`
      : s.doneBy?.displayName || (s.doneSource ? agentName(s.doneSource) : "");
    return { text: [by ? `done by ${by}` : "done", s.doneAt ? ago(s.doneAt, now) : ""].filter(Boolean).join(" · "), tone: "" };
  }
  if (i === firstOpen) return waitingOnYou ? { text: "waiting on your answer", tone: "tone-needs" } : { text: "next", tone: "" };
  return { text: "", tone: "" };
}

export default function ItemPage({ params }: { params: Promise<{ id: string; itemId: string }> }) {
  const { id, itemId } = use(params);
  const fetcher = useCallback(() => api.item(id, itemId), [id, itemId]);
  const { data, missing, err, load } = useWork(id, `item:${id}:${itemId}`, fetcher);
  const now = useNow();
  const [projectName, setProjectName] = useState(id);
  const [handover, setHandover] = useState(false);
  const [edit, setEdit] = useState(false);
  const status = useAction(load);
  useEffect(() => { api.project(id).then((p) => setProjectName(p.name || id)).catch(() => {}); }, [id]);
  const title = data?.item.title;
  useEffect(() => { document.title = `${title || "Item"} · ${projectName} · Reins`; }, [title, projectName]);

  if (!data) {
    return (
      <div className="w-page">
        <div className="w-wash"><WorkHeader projectId={id} projectName={projectName} view={null} crumbs={[{ label: "Item" }]} /></div>
        <PageState projectId={id} missing={missing} err={err} retry={load} what="this item" />
        <PhoneTabs projectId={id} current={null} />
      </div>
    );
  }

  const { item, agents, thread, open, files, nearby, proposals } = data;
  const at = now || Date.now();
  const done = item.steps.filter((s) => s.done).length;
  const firstOpen = item.steps.findIndex((s) => !s.done);
  const river = item.steps.length > 0 && item.steps.length <= 6;
  const waitingOnYou = open.length > 0;
  const ownerHref = `/project/${encodeURIComponent(id)}/people/${encodeURIComponent(item.owner.member)}`;
  const people: Who[] = [item.owner, ...agents.map((a) => a.who), ...thread.map((p) => p.author)]
    .filter((w, i, a) => a.findIndex((x) => x.member === w.member) === i);
  const intro = [
    `Owned by ${item.owner.displayName}.`,
    item.steps.length ? `${done} of ${plural(item.steps.length, "step")} done.` : "No steps yet.",
    item.status === "done" ? "Finished." : item.status === "blocked" ? "Blocked." : item.status === "paused" ? "Paused." : "",
    item.summary || "",
  ].filter(Boolean).join(" ");

  return (
    <div className="w-page">
      <div className="w-wash">
        <WorkHeader projectId={id} projectName={projectName} view={null} crumbs={[{ label: GROUP[item.kind] }, { label: item.title }]}>
          {waitingOnYou && <a href="#ask" className="w-pill pink w-desk-flex">waiting on you</a>}
        </WorkHeader>
        <div className="w-itemhead">
          <div className="w-itemhead-t">
            <div className="w-chips">
              <span className={`w-chip k-${item.kind}`}>{KIND_LABEL[item.kind]}</span>
              {item.release && (
                <span className="w-chip plain">in release {item.release.title}{item.release.dueAt ? ` · ${shortDate(item.release.dueAt)}` : ""}</span>
              )}
              {item.status === "done" && <span className="w-chip good">Done</span>}
            </div>
            <h1>{item.title}</h1>
            <p>{intro}</p>
          </div>
          <div className="w-itemhead-acts">
            <button type="button" className="w-btn" onClick={() => setHandover(true)}>Hand over</button>
            {item.status === "done" ? (
              <button type="button" className="w-btn" disabled={status.busy} onClick={() => status.run(() => api.patchItem(item.id, { status: "open" }))}>Reopen</button>
            ) : (
              <button type="button" className="w-btn" disabled={status.busy} onClick={() => status.run(() => api.patchItem(item.id, { status: "done" }))}>Mark done</button>
            )}
            <button type="button" className="w-btn ghost" onClick={() => setEdit(true)}>Edit</button>
          </div>
          {status.err && <p className="w-err" role="alert">{status.err}</p>}
        </div>

        {river && (
          <section aria-label="Steps" className="w-river-box w-desk">
            <River item={item} agents={agents} firstOpen={firstOpen} waitingOnYou={waitingOnYou} now={at} onDone={load} />
            <StepTools itemId={item.id} proposals={proposals} onDone={load} />
          </section>
        )}
      </div>

      <main className="w-body">
        <StaleNote err={err} retry={load} />
        <div className="w-row">
          <div className="w-col-main w-stack-lg">
            {open.map((p, i) => (
              <div key={p.id} className="w-order-ask">
                <AskCard
                  id={i === 0 ? "ask" : undefined}
                  head={<>{voice(p.author, p.source)} {p.kind === "question" ? "asks you" : "wants a decision"} · {ago(p.createdAt, at)}</>}
                  text={p.text}
                  postId={p.id}
                  type={p.kind === "decision" ? "decision" : "question"}
                  to={p.author.displayName}
                  delegated={p.delegate}
                  onDone={load}
                />
              </div>
            ))}

            <section aria-labelledby="st-h" className={`w-stack w-order-steps${river ? " w-phone" : ""}`}>
              <SectionHead id="st-h" title="Steps" note={item.steps.length ? `${done} of ${item.steps.length}` : undefined} />
              <StepsList item={item} firstOpen={firstOpen} waitingOnYou={waitingOnYou} now={at} onDone={load} />
              <StepTools itemId={item.id} proposals={proposals} onDone={load} />
            </section>

            <section aria-labelledby="th-h" className="w-stack">
              <SectionHead id="th-h" title="Thread" note={<span className="w-desk-inline">agents and people on {item.title} talk here</span>} />
              {thread.length === 0 ? (
                <p className="w-card w-calm-empty">Nothing written here yet. Handovers, questions and findings on this item collect here.</p>
              ) : (
                <ol className="w-card w-thread">
                  {thread.map((p) => <ThreadPost key={p.id} p={p} now={at} />)}
                </ol>
              )}
            </section>

            <WriteBox projectId={id} itemId={item.id} title={item.title} people={people} onDone={load} />
          </div>

          <aside aria-label="Details" className="w-col-side w-stack-lg">
            <section aria-labelledby="ag-h" className="w-stack">
              <SectionHead id="ag-h" title="Agents on it" />
              {agents.length === 0 ? (
                <p className="w-card w-calm-empty">
                  No agent is on it right now.{item.branch ? <> Sessions on <span className="w-mono">{item.branch}</span> attach on their own.</> : ""}
                </p>
              ) : (
                <div className="w-card w-list">
                  {agents.map((a) => (
                    <div key={a.sessionId} className="w-onit">
                      <div className="w-onit-h">
                        <AgentTile source={a.source} size={22} />
                        <span className="w-strong">{voice(a.who, a.source)}</span>
                        <span className={`w-small w-push ${a.state === "waiting" ? "tone-needs" : a.state === "blocked" ? "tone-block" : "w-ink3"}`}>
                          {a.state}{a.stateSince ? ` · ${ago(a.stateSince, at)}` : ""}
                        </span>
                      </div>
                      <span className="w-mono w-meta w-wrap">{[a.branch, a.worktree].filter(Boolean).join(" · ")}</span>
                      {a.lastLine && <span className="w-small w-ink2">{a.lastLine}</span>}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="dt-h" className="w-stack">
              <SectionHead id="dt-h" title="Details" />
              <dl className="w-card w-dl">
                <div><dt>Kind</dt><dd>{KIND_LABEL[item.kind]}</dd></div>
                <div><dt>Owner</dt><dd><Link href={ownerHref} className="w-link">{item.owner.displayName}</Link></dd></div>
                <div><dt>Status</dt><dd>{STATUS_TEXT[item.status]}</dd></div>
                {item.release && <div><dt>Release</dt><dd>{item.release.title}{item.release.dueAt ? ` · ${shortDate(item.release.dueAt)}` : ""}</dd></div>}
                <div><dt>Branch</dt><dd className={item.branch ? "w-mono" : "w-ink3"}>{item.branch || "none set"}</dd></div>
                <div><dt>Started</dt><dd>{shortDate(item.createdAt)} {clock(item.createdAt)}</dd></div>
                {files.length > 0 && <Files files={files} />}
              </dl>
            </section>

            {nearby.length > 0 && (
              <section aria-labelledby="nb-h" className="w-stack">
                <SectionHead id="nb-h" title="Nearby" />
                <div className="w-card w-list">
                  {nearby.map((n, i) => (
                    <div key={i} className="w-trait w-pad-x">
                      <span>{n.text}</span>
                      <span className="w-meta">{n.meta}</span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </aside>
        </div>
      </main>

      <HandoverDialog projectId={id} open={handover} onClose={() => setHandover(false)} onDone={load} item={{ id: item.id, title: item.title }} owner={item.owner.member} />
      <EditItemDialog projectId={id} open={edit} onClose={() => setEdit(false)} onDone={load} item={item} />
      <PhoneTabs projectId={id} current={null} />
    </div>
  );
}

/** The steps as a river: a dot per step (tick it to mark done), agents riding at the next open step. */
function River({ item, agents, firstOpen, waitingOnYou, now, onDone }: {
  item: ItemData["item"]; agents: ItemData["agents"]; firstOpen: number; waitingOnYou: boolean; now: number; onDone: () => void;
}) {
  const n = item.steps.length;
  const done = item.steps.filter((s) => s.done).length;
  const { busy, err, run } = useAction(onDone);
  const half = 50 / n;
  const riderAt = firstOpen < 0 ? 100 - half : (firstOpen + 0.5) * (100 / n);
  return (
    <div className="w-river">
      <div className="w-river-rail" aria-hidden="true">
        <span className="w-river-line" style={{ left: `${half}%`, right: `${half}%` }} />
        <span className="w-river-flow" style={{ left: `${half}%`, width: `${Math.max(0, (done / n) * 100 - half)}%` }} />
        {agents.map((a, i) => (
          <span key={a.sessionId} className="w-river-rider" style={{ left: `calc(${riderAt}% - 14px + ${i * 18}px)` }} title={`${a.who.displayName}’s ${agentLabel(a.source, a.state)}`}>
            <AgentTile source={a.source} size={28} state={a.state} />
          </span>
        ))}
      </div>
      <ol className="w-river-steps" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
        {item.steps.map((s, i) => {
          const m = stepMeta(s, i, firstOpen, waitingOnYou, now);
          const wait = !s.done && i === firstOpen && waitingOnYou;
          return (
            <li key={s.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={s.done}
                aria-label={`${s.text}: ${s.done ? "done, mark not done" : "mark done"}`}
                className={`w-stepdot${s.done ? " done" : wait ? " wait" : ""}`}
                disabled={busy}
                onClick={() => run(() => api.setStep(s.id, !s.done))}
              />
              <span className="w-strong w-river-name">{s.text}</span>
              {m.text && <span className={`w-meta ${m.tone}`}>{m.text}</span>}
            </li>
          );
        })}
      </ol>
      {err && <p className="w-err" role="alert">{err}</p>}
    </div>
  );
}

/** The steps as a list (phones, or items with many steps). */
function StepsList({ item, firstOpen, waitingOnYou, now, onDone }: { item: ItemData["item"]; firstOpen: number; waitingOnYou: boolean; now: number; onDone: () => void }) {
  const { busy, err, run } = useAction(onDone);
  if (item.steps.length === 0) return <p className="w-card w-calm-empty">No steps yet. Add one, or let the owner’s agent break it down.</p>;
  return (
    <>
      <ol className="w-card w-steps">
        {item.steps.map((s, i) => {
          const m = stepMeta(s, i, firstOpen, waitingOnYou, now);
          const wait = !s.done && i === firstOpen && waitingOnYou;
          return (
            <li key={s.id}>
              <button
                type="button"
                role="checkbox"
                aria-checked={s.done}
                aria-label={`${s.text}: ${s.done ? "done, mark not done" : "mark done"}`}
                className={`w-stepdot${s.done ? " done" : wait ? " wait" : ""}`}
                disabled={busy}
                onClick={() => run(() => api.setStep(s.id, !s.done))}
              />
              <span className="w-steps-t">
                <span className={s.done ? "w-done-text" : ""}>{s.text}</span>
                {m.text && <span className={`w-meta ${m.tone}`}>{m.text}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      {err && <p className="w-err" role="alert">{err}</p>}
    </>
  );
}

/** Add a step, and Reins' suggested ticks/steps to accept or dismiss. */
function StepTools({ itemId, proposals, onDone }: { itemId: string; proposals: ItemData["proposals"]; onDone: () => void }) {
  const uid = useId();
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const { busy, err, run } = useAction(onDone);
  const add = async () => {
    const t = text.trim();
    if (!t) return;
    if (await run(() => api.addStep(itemId, t))) setText("");
  };
  return (
    <div className="w-steptools">
      {proposals.length > 0 && (
        <div className="w-suggest">
          <span className="w-small w-strong w-ink2">Suggested from what the agents did</span>
          {proposals.map((p) => (
            <div key={p.id} className="w-suggest-row">
              <span className="w-suggest-t">
                <span>{p.text}</span>
                {p.reason && <span className="w-meta">{p.reason}</span>}
              </span>
              <button type="button" className="w-btn small sky" disabled={busy} onClick={() => run(() => api.acceptProposal(p.id))}>Accept</button>
              <button type="button" className="w-btn small ghost" disabled={busy} onClick={() => run(() => api.dismissProposal(p.id))}>Dismiss</button>
            </div>
          ))}
        </div>
      )}
      {adding ? (
        <form className="w-inline-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <label htmlFor={uid} className="w-sr">New step</label>
          <input id={uid} value={text} onChange={(e) => setText(e.target.value)} placeholder="A new step…" maxLength={300} autoFocus />
          <button type="submit" className="w-btn strong small" disabled={busy || !text.trim()}>Add</button>
          <button type="button" className="w-btn small ghost" onClick={() => setAdding(false)}>Done</button>
        </form>
      ) : (
        <button type="button" className="w-link" onClick={() => setAdding(true)}>+ Add a step</button>
      )}
      {err && <p className="w-err" role="alert">{err}</p>}
    </div>
  );
}

function ThreadPost({ p, now }: { p: Post; now: number }) {
  const agent = agentName(p.source);
  return (
    <li className="w-post">
      <span className="w-post-av" aria-hidden="true">
        <Avatar who={p.author} size={32} />
        {agent && <span className="w-post-badge"><AgentTile source={p.source} size={18} /></span>}
      </span>
      <div className="w-post-b">
        <div className="w-post-h">
          <span className="w-strong">{p.author.displayName}{agent ? ` · ${agent}` : ""}</span>
          <span className={`w-post-k k-${p.kind}`}>{POST_KIND[p.kind]}{p.to ? ` · to ${p.to.displayName}` : ""}</span>
          <time className="w-meta" dateTime={new Date(p.createdAt).toISOString()}>{ago(p.createdAt, now)}{ago(p.createdAt, now) === "now" ? "" : " ago"}</time>
          {p.status && p.status !== "open" && <span className="w-meta">· {p.status}</span>}
        </div>
        <p>{p.text}</p>
        {p.kind === "answer" && agent && (
          <span className="w-meta">Answered by {p.author.displayName}’s agent from its own session.</span>
        )}
      </div>
    </li>
  );
}

/** "Write to <item>": a note the agents on it read at their next prompt; "@name" aims it at one person. */
function WriteBox({ projectId, itemId, title, people, onDone }: { projectId: string; itemId: string; title: string; people: Who[]; onDone: () => void }) {
  const uid = useId();
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  const { busy, err, run } = useAction(onDone);
  const post = async () => {
    const t = text.trim();
    if (!t) return;
    const m = /^@(\S+)/.exec(t);
    const to = m ? people.find((w) => w.member.toLowerCase() === m[1].toLowerCase() || w.displayName.toLowerCase() === m[1].toLowerCase()) : undefined;
    if (await run(() => api.createPost(projectId, { itemId, kind: "note", text: t, ...(to ? { toMember: to.member } : {}) }))) {
      setText("");
      setSent(true);
    }
  };
  return (
    <form className="w-write" onSubmit={(e) => { e.preventDefault(); post(); }}>
      <label htmlFor={uid}>Write to {title}. <span className="w-desk-inline">Agents on it read this at their next prompt.</span></label>
      <div className="w-inline-form">
        <input id={uid} value={text} onChange={(e) => { setText(e.target.value); setSent(false); }} placeholder="A note, a decision, or @someone…" maxLength={2000} />
        <button type="submit" className="w-btn strong" disabled={busy || !text.trim()}>Post</button>
      </div>
      {sent && <p className="w-ok" role="status">Posted. Agents on it get it at their next prompt.</p>}
      {err && <p className="w-err" role="alert">{err}</p>}
    </form>
  );
}

function Files({ files }: { files: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? files : files.slice(0, 3);
  return (
    <div>
      <dt>Files · {files.length}</dt>
      <dd className="w-files">
        {shown.map((f) => <span key={f} className="w-mono" title={f}>{base(f) === f ? f : f.split("/").slice(-3).join("/")}</span>)}
        {files.length > 3 && (
          <button type="button" className="w-link" onClick={() => setAll((v) => !v)} aria-expanded={all}>
            {all ? "Show fewer" : `${files.length - 3} more`}
          </button>
        )}
      </dd>
    </div>
  );
}

