"use client";
import { use, useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, type MyAgent, type Post, type Trait } from "@/lib/api";
import { handleAuth } from "@/lib/guard";
import { PageState, PhoneTabs, StaleNote, WorkHeader, useAction, useNow, useWork } from "@/components/work/shell";
import { AgentTile, Avatar, SectionHead, StateDot } from "@/components/work/bits";
import { LaneCard, itemHref } from "@/components/work/lane";
import { AskCard } from "@/components/work/needs";
import { agentName, ago, andList, base, clock, countWord, dayLine, greeting, voice } from "@/components/work/format";

const HOUR = 3_600_000;

const POST_KIND: Record<Post["kind"], string> = {
  handover: "Handed to you",
  note: "Note",
  answer: "Answered",
  update: "Update",
  finding: "Finding",
  review: "Review",
  decision: "Decision",
  question: "Asked",
};

const isOpenAsk = (p: Post) => (p.kind === "question" || p.kind === "decision") && p.status === "open";

/** The window the mini timelines share: from the earliest mark (or 3h ago) to at least 6 hours on. */
function dayWindow(agents: MyAgent[], now: number) {
  const times = agents.flatMap((a) => [...a.clips.map((c) => c.from), ...a.steps.map((s) => s.at)]);
  const earliest = Math.min(now - 3 * HOUR, ...times);
  const from = new Date(earliest).setMinutes(0, 0, 0);
  const end = new Date(now + HOUR).setMinutes(0, 0, 0) + HOUR;
  return { from, to: Math.max(from + 6 * HOUR, end) };
}

function stateText(a: MyAgent, now: number): string {
  const since = a.stateSince ? ` · ${ago(a.stateSince, now)}` : "";
  return `${a.state}${since}`;
}

export default function MyDayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const fetcher = useCallback(() => api.myDay(id), [id]);
  const { data, missing, err, load } = useWork(id, `me:${id}`, fetcher);
  const now = useNow();
  const [projectName, setProjectName] = useState(id);
  useEffect(() => { api.project(id).then((p) => setProjectName(p.name || id)).catch(() => {}); }, [id]);
  useEffect(() => { document.title = `My day · ${projectName} · Reins`; }, [projectName]);

  if (!data) {
    return (
      <div className="w-page">
        <div className="w-wash"><WorkHeader projectId={id} projectName={projectName} view="me" /></div>
        <PageState projectId={id} missing={missing} err={err} retry={load} />
        <PhoneTabs projectId={id} current="me" />
      </div>
    );
  }

  const d = data;
  const at = now || Date.now();
  const first = (d.me.displayName || d.me.member).split(/\s+/)[0];
  const asks = d.forYou.filter(isOpenAsk);
  const rest = d.forYou.filter((p) => !isOpenAsk(p));
  const waiting = d.agents.filter((a) => a.state === "waiting").length;
  const blocked = d.agents.filter((a) => a.state === "blocked").length;
  const working = d.agents.filter((a) => a.state === "working").length;
  const running = d.agents.filter((a) => a.state !== "ended");

  let status = "";
  if (running.length === 0) status = "None of your agents is running right now.";
  else if (waiting + blocked === 0) status = working ? `${countWord(working)} of your agents ${working === 1 ? "is" : "are"} working; nothing is waiting.` : "Your agents are idle.";
  else {
    if (waiting) status += `${countWord(waiting)} of your agents ${waiting === 1 ? "is" : "are"} waiting on someone.`;
    if (blocked) status += `${status ? " " : ""}${countWord(blocked)} ${blocked === 1 ? "is" : "are"} blocked.`;
  }
  const titles = d.owned.map((o) => o.title);
  const owns = titles.length === 0
    ? "You don’t own anything yet. Create an item from Today, or let your agent add one."
    : `You own ${andList(titles.length > 3 ? [...titles.slice(0, 3), `${titles.length - 3} more`] : titles)}.`;
  const win = dayWindow(d.agents, at);

  return (
    <div className="w-page">
      <div className="w-wash">
        <WorkHeader projectId={id} projectName={projectName} view="me">
          {asks.length > 0 && <a href="#for-you" className="w-pill pink w-desk-flex">{asks.length} for you</a>}
        </WorkHeader>
        <div className="w-hero">
          <span className="w-eyebrow w-desk">{dayLine(at)}</span>
          <h1>{greeting(at)}, {first}. {status}</h1>
          <p>{owns}</p>
        </div>
      </div>

      <main className="w-body">
        <StaleNote err={err} retry={load} />
        <div className="w-row">
          <div className="w-col-main w-stack-lg">
            <section aria-labelledby="ya-h" className="w-stack w-order-2">
              <SectionHead id="ya-h" title="Your agents" note={<span className="w-desk-inline">every mark is a step: an edit or a question</span>} />
              {d.agents.length === 0 ? (
                <div className="w-card w-calm-empty">
                  <p>No agent of yours has checked in today.</p>
                  <p className="w-quiet">Run the setup once on your machine and your agents show up here as they work.</p>
                  <Link href={`/project/${encodeURIComponent(id)}/connect`} className="w-btn small">Connect an agent</Link>
                </div>
              ) : (
                <>
                  <div className="w-card w-list w-desk">
                    {d.agents.map((a) => <AgentDay key={a.sessionId} projectId={id} a={a} win={win} now={at} />)}
                  </div>
                  <div className="w-phone w-stack">
                    {d.agents.map((a) => <AgentTerminal key={a.sessionId} a={a} win={win} now={at} />)}
                  </div>
                </>
              )}
            </section>

            <section id="for-you" aria-labelledby="fy-h" className="w-stack w-order-1">
              <SectionHead id="fy-h" title="For you" note={<span className="w-desk-inline">handovers, asks and notes aimed at you or your agents</span>}>
                {asks.length > 0 && <span className="w-count pink w-phone-inline">{asks.length}</span>}
              </SectionHead>
              {d.forYou.length === 0 ? (
                <p className="w-card w-calm-empty">Nothing for you right now.</p>
              ) : (
                <>
                  {asks.map((p) => (
                    <AskCard
                      key={p.id}
                      head={<>{voice(p.author, p.source)} {p.kind === "question" ? "asks you" : "wants a decision"} · {ago(p.createdAt, at)}</>}
                      text={p.text}
                      meta={p.itemTitle || undefined}
                      postId={p.id}
                      type={p.kind as "question" | "decision"}
                      to={p.author.displayName}
                      delegated={p.delegate}
                      delegateFirst={p.kind === "question"}
                      onDone={load}
                    />
                  ))}
                  {rest.length > 0 && (
                    <div className="w-card w-list">
                      {rest.map((p) => (
                        <div key={p.id} className="w-foryou">
                          <span className={`w-foryou-k k-${p.kind}`}>{POST_KIND[p.kind]}<span className="w-phone-inline w-meta"> · {ago(p.createdAt, at)}</span></span>
                          <span className="w-foryou-t">
                            <b className="w-strong">{voice(p.author, p.source)}</b>: {p.text}
                            {p.itemId && p.itemTitle && <> <Link href={itemHref(id, p.itemId)} className="w-small">{p.itemTitle}</Link></>}
                          </span>
                          <span className="w-meta w-desk-inline">{ago(p.createdAt, at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          <div className="w-col-side w-stack-lg">
            <section aria-labelledby="ar-h" className="w-stack">
              <SectionHead id="ar-h" title="Around you" />
              {d.around.length === 0 ? (
                <p className="w-card w-calm-empty">Nobody else is near your work right now.</p>
              ) : (
                <div className="w-card w-list">
                  {d.around.map((n, i) => (
                    <div key={i} className="w-around">
                      <Avatar who={n.who} size={28} />
                      <span className="w-around-t">
                        <span>{n.text}</span>
                        <span className={`w-small tone-${n.tone}`}>{n.meta}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section aria-labelledby="yo-h" className="w-stack">
              <SectionHead id="yo-h" title="What you own" />
              {d.owned.length === 0 ? (
                <p className="w-card w-calm-empty">Nothing owned yet.</p>
              ) : (
                <div className="w-card w-pad-x">
                  {d.owned.map((l) => <LaneCard key={l.id} projectId={id} lane={l} />)}
                </div>
              )}
            </section>

            <Traits projectId={id} member={d.me.member} traits={d.traits} onDone={load} />
          </div>
        </div>
      </main>
      <PhoneTabs projectId={id} current="me" />
    </div>
  );
}

const pctIn = (t: number, win: { from: number; to: number }) => Math.min(100, Math.max(0, ((t - win.from) / (win.to - win.from)) * 100));

/** One of your agents on the desktop: its blocks today, a tick per step, the line at now, its last line. */
function AgentDay({ projectId, a, win, now }: { projectId: string; a: MyAgent; win: { from: number; to: number }; now: number }) {
  const name = agentName(a.source) || "Agent";
  return (
    <div className="w-agentday">
      <div className="w-agentday-h">
        <AgentTile source={a.source} />
        <span className="w-strong">{name}</span>
        {a.item && <Link href={itemHref(projectId, a.item.id)} className="w-small">{a.item.title}</Link>}
        <span className="w-mono w-meta">{[a.branch, base(a.worktree)].filter(Boolean).join(" · ")}</span>
        <span className="w-agentday-state"><StateDot state={a.state} />{stateText(a, now)}</span>
      </div>
      <div className="w-mini" role="img" aria-label={`${name} today: ${a.clips.map((c) => c.label).join(", ") || "no tasks yet"}; ${a.steps.length} steps`}>
        <span className="w-mini-bg" />
        {a.clips.map((c, i) => {
          const l = pctIn(c.from, win);
          return (
            <span key={i} className={`w-mini-clip k-${c.kind}${c.to == null ? " live" : ""}`} style={{ left: `${l}%`, width: `${Math.max(0.8, pctIn(c.to ?? now, win) - l)}%` }}>{c.label}</span>
          );
        })}
        {a.steps.map((s, i) => <span key={i} className={`w-mini-step s-${s.kind}`} style={{ left: `calc(${pctIn(s.at, win)}% - 1px)` }} />)}
        <span className="w-mini-now" style={{ left: `${pctIn(now, win)}%` }} />
        <span className="w-mini-l w-mono">{clock(win.from)}</span>
        <span className="w-mini-l now w-mono" style={{ left: `calc(${pctIn(now, win)}% - 12px)` }}>now</span>
        <span className="w-mini-l end w-mono">{clock(win.to)}</span>
      </div>
      {a.lastLine && <span className="w-mono w-small w-ink2">{a.lastLine}</span>}
    </div>
  );
}

/** One of your agents on a phone: a small terminal tile with its step ticks and last line. */
function AgentTerminal({ a, win, now }: { a: MyAgent; win: { from: number; to: number }; now: number }) {
  const name = [agentName(a.source) || "Agent", a.item?.title].filter(Boolean).join(" · ");
  return (
    <article className="w-term">
      <div className="w-term-h">
        <span className="w-strong">{name}</span>
        <span className="w-mono w-term-dim">{a.branch || ""}</span>
      </div>
      <div className="w-term-steps" aria-hidden="true">
        <span className="w-term-rail" />
        {a.steps.map((s, i) => <span key={i} className={`w-term-step s-${s.kind}`} style={{ left: `calc(${Math.min(99, pctIn(s.at, win))}% - 1px)` }} />)}
      </div>
      {a.lastLine && <p className="w-term-line w-mono">{a.lastLine}</p>}
      <div className="w-term-foot"><StateDot state={a.state} />{stateText(a, now)}</div>
    </article>
  );
}

/** "How your agents know you": the learned working style, editable by you. */
function Traits({ projectId, member, traits, onDone }: { projectId: string; member: string; traits: { text: string; why: string }[]; onDone: () => void }) {
  const [editing, setEditing] = useState(false);
  const [full, setFull] = useState<Trait[] | null>(null);
  const [loadErr, setLoadErr] = useState("");

  const loadFull = useCallback(() => {
    api.member(projectId, member)
      .then((m) => { setFull(m.profile); setLoadErr(""); })
      .catch((e) => { if (!handleAuth(e)) setLoadErr("Couldn’t load your traits to edit."); });
  }, [projectId, member]);
  useEffect(() => { if (editing) loadFull(); }, [editing, loadFull]);
  const refresh = useCallback(() => { loadFull(); onDone(); }, [loadFull, onDone]);

  return (
    <section aria-labelledby="ys-h" className="w-stack">
      <SectionHead id="ys-h" title="How your agents know you">
        <button type="button" className="w-link w-push" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>{editing ? "Done" : "Edit"}</button>
      </SectionHead>
      <div className="w-card w-pad-x">
        {editing ? (
          loadErr ? <p className="w-err" role="alert">{loadErr}</p>
            : !full ? <p className="w-quiet w-pad-y">Loading…</p>
              : full.length === 0 ? <p className="w-quiet w-pad-y">Nothing learned yet.</p>
                : full.map((t) => <TraitEdit key={t.id} t={t} onDone={refresh} />)
        ) : traits.length === 0 ? (
          <p className="w-quiet w-pad-y">Nothing learned yet. Reins notices what you correct your agents on more than once.</p>
        ) : traits.map((t, i) => (
          <div key={i} className="w-trait">
            <span>{t.text}</span>
            <span className="w-meta">{t.why}</span>
          </div>
        ))}
        <p className="w-meta w-pad-y">Teammates’ agents read this as background when they work with yours.</p>
      </div>
    </section>
  );
}

function TraitEdit({ t, onDone }: { t: Trait; onDone: () => void }) {
  const uid = useId();
  const [draft, setDraft] = useState(t.statement);
  const { busy, err, run } = useAction(onDone);
  const changed = draft.trim() && draft.trim() !== t.statement;
  return (
    <form className="w-trait-edit" onSubmit={(e) => { e.preventDefault(); if (changed) run(() => api.patchTrait(t.id, { statement: draft.trim() })); }}>
      <label htmlFor={uid} className="w-sr">Trait</label>
      <input id={uid} value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={300} />
      <button type="submit" className="w-btn small" disabled={busy || !changed}>Save</button>
      <button type="button" className="w-btn small ghost" disabled={busy} onClick={() => run(() => api.deleteTrait(t.id))} aria-label={`Hide: ${t.statement}`}>Hide</button>
      {err && <p className="w-err" role="alert">{err}</p>}
    </form>
  );
}
