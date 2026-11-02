"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { PageState, PhoneTabs, StaleNote, WorkHeader, useViewer, useWork } from "@/components/work/shell";
import { Avatar, SectionHead, StateDot } from "@/components/work/bits";
import { LaneRow, itemHref } from "@/components/work/lane";
import { NewItemDialog, WriteDialog } from "@/components/work/dialogs";
import { PartsLegend, weekday } from "@/components/work/week";
import { KIND_LABEL, agentName, andList, hours, param, plural } from "@/components/work/format";

export default function PersonPage({ params }: { params: Promise<{ id: string; member: string }> }) {
  const { id, member: raw } = use(params);
  const member = param(raw);
  const fetcher = useCallback(() => api.person(id, member), [id, member]);
  const { data, missing, err, load } = useWork(id, `person:${id}:${member}`, fetcher);
  const me = useViewer();
  const [projectName, setProjectName] = useState(id);
  const [give, setGive] = useState(false);
  const [write, setWrite] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  useEffect(() => { api.project(id).then((p) => setProjectName(p.name || id)).catch(() => {}); }, [id]);
  const name = data?.who.displayName || member;
  useEffect(() => { document.title = `${name} · ${projectName} · Reins`; }, [name, projectName]);
  const peopleHref = `/project/${encodeURIComponent(id)}#people`;

  if (!data) {
    return (
      <div className="w-page">
        <div className="w-wash">
          <WorkHeader projectId={id} projectName={projectName} view={null} crumbs={[{ label: "People", href: peopleHref }, { label: name }]} />
        </div>
        <PageState projectId={id} missing={missing} err={err} retry={load} what="this person" />
        <PhoneTabs projectId={id} current="people" />
      </div>
    );
  }

  const p = data;
  const first = (p.who.displayName || p.who.member).split(/\s+/)[0];
  const self = !!me?.member && me.member === p.who.member;
  const titles = p.owned.map((o) => o.title);
  const ownsLine = titles.length
    ? `${first} owns ${andList(titles.length > 3 ? [...titles.slice(0, 3), `${titles.length - 3} more`] : titles)}.`
    : `${first} doesn’t own anything right now.`;
  const week = [
    `This week: ${plural(p.stats.done, "task")} done`,
    p.stats.helped ? `, and ${self ? "your" : "their"} agents answered ${plural(p.stats.helped, "question")} for teammates’ agents` : "",
    ".",
    p.agentsNow ? ` ${plural(p.agentsNow, "agent")} running now.` : " No agent running right now.",
  ].join("");
  const kinds = p.finished.reduce<Record<string, number>>((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {});
  const doneSub = Object.entries(kinds).map(([k, n]) => `${n} ${KIND_LABEL[k as keyof typeof KIND_LABEL].toLowerCase()}`).join(", ");
  const stats = [
    { v: String(p.stats.done), k: "Tasks done", sub: doneSub || "this week" },
    { v: String(p.stats.stepsTicked), k: "Steps ticked", sub: `by ${self ? "your" : "their"} agents` },
    { v: hours(p.stats.activeHours), k: "Agents active", sub: "summed across agents" },
    { v: hours(p.stats.blockedHours), k: "Blocked or waiting", sub: "agent time spent stuck" },
    { v: String(p.stats.helped), k: "Helped teammates", sub: "answered their agents’ questions" },
    { v: String(p.stats.asked), k: "Asked others", sub: p.stats.askMedianMin != null && p.stats.asked ? `median answer in ${Math.round(p.stats.askMedianMin)} min` : "questions to teammates" },
  ];
  const maxH = Math.max(8, ...p.week.map((d) => d.hours));

  return (
    <div className="w-page">
      <div className="w-wash">
        <WorkHeader projectId={id} projectName={projectName} view={null} crumbs={[{ label: "People", href: peopleHref }, { label: p.who.displayName }]} />
        <div className="w-personhead">
          <Avatar who={p.who} size={60} />
          <div className="w-hero w-hero-tight">
            <h1>{ownsLine}</h1>
            <p>{week}</p>
          </div>
          <div className="w-itemhead-acts">
            <button type="button" className="w-btn strong" onClick={() => setGive(true)}>{self ? "New item" : `Give ${first} something`}</button>
            {!self && <button type="button" className="w-btn" onClick={() => { setSentTo(null); setWrite(true); }}>Write to {first}</button>}
          </div>
          {sentTo && <p className="w-ok" role="status">Note sent to {sentTo}. Their agents read it at the next prompt.</p>}
        </div>
      </div>

      <main className="w-body">
        <StaleNote err={err} retry={load} />
        <section aria-labelledby="pn-h" className="w-stack">
          <SectionHead id="pn-h" title="Last 7 days" note={`counted from what ${self ? "your" : "their"} agents did, not scored`} />
          <div className="w-card w-stats">
            {stats.map((s) => (
              <div key={s.k} className="w-stat">
                <span className="w-stat-v">{s.v}</span>
                <span className="w-small w-ink2">{s.k}</span>
                <span className="w-meta">{s.sub}</span>
              </div>
            ))}
          </div>
        </section>

        <div className="w-row">
          <div className="w-col-main w-stack-lg">
            <section aria-labelledby="po-h" className="w-stack">
              <SectionHead id="po-h" title={self ? "What you own" : `What ${first} owns`} />
              <div className="w-card w-pad-x">
                {p.owned.length === 0 && <p className="w-quiet w-pad-y">Nothing owned right now.</p>}
                {p.owned.map((l) => <LaneRow key={l.id} projectId={id} lane={l} showOwner={false} />)}
                {p.finished.length > 0 && (
                  <div className="w-finished">
                    <span className="w-meta">Finished this week</span>
                    <div className="w-chips">
                      {p.finished.map((f) => (
                        <Link key={f.id} href={itemHref(id, f.id)} className="w-chip plain">
                          <span className={`w-chip-k k-${f.kind}`}>{KIND_LABEL[f.kind]}</span>{f.title}
                        </Link>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            <section aria-labelledby="pw-h" className="w-stack">
              <SectionHead id="pw-h" title={self ? "Your week" : `${first}’s week`} note="agent hours per day, by kind of work" />
              {p.week.length === 0 ? (
                <p className="w-card w-calm-empty">No agent time recorded this week.</p>
              ) : (
                <>
                  <div className="w-card w-vbars">
                    {p.week.map((d, i) => (
                      <div key={i} className={`w-vbar${i === p.week.length - 1 ? " today" : ""}`}>
                        <span className="w-mono w-meta w-vbar-day">{weekday(d.date)}</span>
                        <span className="w-vbar-col" role="img" aria-label={`${weekday(d.date)}: ${hours(d.hours)}${d.parts.length ? ` (${d.parts.map((x) => `${hours(x.hours)} ${x.kind}`).join(", ")})` : ""}`}>
                          {d.parts.map((x, j) => <span key={j} className={`p-${x.kind}`} style={{ height: `${(x.hours / maxH) * 100}%` }} />)}
                        </span>
                        <span className="w-mono w-meta">{d.hours ? hours(d.hours) : "–"}</span>
                      </div>
                    ))}
                  </div>
                  <PartsLegend />
                </>
              )}
            </section>
          </div>

          <div className="w-col-side w-stack-lg">
            <section aria-labelledby="pa-h" className="w-stack">
              <SectionHead id="pa-h" title={self ? "Your agents now" : `${first}’s agents now`} />
              {p.agents.length === 0 ? (
                <p className="w-card w-calm-empty">No agent running right now.</p>
              ) : p.agents.map((a) => (
                <article key={a.sessionId} className="w-term">
                  <div className="w-term-h">
                    <span className="w-strong">{[agentName(a.source) || "Agent", a.item?.title].filter(Boolean).join(" · ")}</span>
                    <span className="w-mono w-term-dim">{a.branch || ""}</span>
                  </div>
                  {a.lines.length > 0 && (
                    <div className="w-term-body w-mono">
                      {a.lines.map((l, i) => <span key={i} className={i === a.lines.length - 1 ? "" : "w-term-dim"}>{l}</span>)}
                    </div>
                  )}
                  <div className="w-term-foot"><StateDot state={a.state} />{a.state}</div>
                </article>
              ))}
            </section>

            <section aria-labelledby="ps-h" className="w-stack">
              <SectionHead id="ps-h" title="Working style">
                {self
                  ? <Link href={`/project/${encodeURIComponent(id)}/me`} className="w-link w-push">Edit</Link>
                  : <span className="w-meta w-push">shared by {first}</span>}
              </SectionHead>
              <div className="w-card w-pad-x">
                {p.traits.length === 0 ? (
                  <p className="w-quiet w-pad-y">Nothing shared yet.</p>
                ) : p.traits.map((t, i) => (
                  <div key={i} className="w-trait">
                    <span>{t.text}</span>
                    <span className="w-meta">{t.why}</span>
                  </div>
                ))}
                <p className="w-meta w-pad-y">Built from corrections {self ? "you" : first} made to {self ? "your" : "their"} agents more than once. {self ? "You" : first} can edit or hide it.</p>
              </div>
            </section>
          </div>
        </div>
      </main>

      <NewItemDialog projectId={id} open={give} onClose={() => setGive(false)} onDone={load} me={me?.member} owner={p.who.member} release={null} />
      <WriteDialog projectId={id} open={write} onClose={() => setWrite(false)} onDone={load} onSent={setSentTo} to={p.who.member} me={me?.member} />
      <PhoneTabs projectId={id} current="people" />
    </div>
  );
}

