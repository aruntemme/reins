"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type WeekData } from "@/lib/api";
import { PageState, PhoneTabs, StaleNote, WorkHeader, useWork } from "@/components/work/shell";
import { Avatar, SectionHead } from "@/components/work/bits";
import { itemHref } from "@/components/work/lane";
import { PartsLegend, weekday } from "@/components/work/week";
import { andList, hours, plural, shortDate } from "@/components/work/format";

function headline(w: WeekData): string {
  const done = `${plural(w.tasksDone, "task")} done.`;
  const mix = ([["feature", "features"], ["bug", "bugs"], ["try", "trying things out"], ["chore", "chores"]] as const)
    .filter(([k]) => w.mix[k] > 0)
    .sort((a, b) => w.mix[b[0]] - w.mix[a[0]])
    .map(([k, label]) => `${Math.round(w.mix[k])}% to ${label}`);
  if (!mix.length) return w.tasksDone ? done : "A quiet week. No agent time recorded yet.";
  return `${done} Agent time went ${andList(mix)}.`;
}

function subline(w: WeekData): string {
  const moved = [...w.owned].map((o) => ({ o, gain: o.now - o.before })).filter((x) => x.gain > 0).sort((a, b) => b.gain - a.gain);
  const parts: string[] = [];
  if (moved[0]) parts.push(`${moved[0].o.title} moved ${plural(moved[0].gain, "step")}.`);
  const stuck = w.owned.filter((o) => o.tone === "block" || o.tone === "needs");
  if (stuck.length) parts.push(`${andList(stuck.slice(0, 2).map((o) => o.title))} ${stuck.length === 1 ? "is" : "are"} ${stuck[0].tone === "block" ? "stuck" : "waiting on someone"}.`);
  return parts.join(" ") || "Numbers below are counted from what agents did, not scored.";
}

export default function WeekPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const fetcher = useCallback(() => api.week(id, 7), [id]);
  const { data, missing, err, load } = useWork(id, `week:${id}`, fetcher);
  const [projectName, setProjectName] = useState(id);
  useEffect(() => { api.project(id).then((p) => setProjectName(p.name || id)).catch(() => {}); }, [id]);
  useEffect(() => { document.title = `This week · ${projectName} · Reins`; }, [projectName]);

  if (!data) {
    return (
      <div className="w-page">
        <div className="w-wash"><WorkHeader projectId={id} projectName={projectName} view="week" /></div>
        <PageState projectId={id} missing={missing} err={err} retry={load} />
        <PhoneTabs projectId={id} current="week" />
      </div>
    );
  }

  const w = data;
  const days = w.people[0]?.days.map((d) => d.date) ?? [];
  const perDayLen = Math.max(days.length, ...w.owned.map((o) => o.perDay.length), 0);
  const dayLabels = days.length ? days.map(weekday) : Array.from({ length: perDayLen }, (_, i) => weekday(w.from + i * 86_400_000));
  const maxH = Math.max(8, ...w.people.flatMap((p) => p.days.map((d) => d.hours)));

  return (
    <div className="w-page">
      <div className="w-wash">
        <WorkHeader projectId={id} projectName={projectName} view="week">
          <span className="w-meta w-desk-flex">{shortDate(w.from)} – {shortDate(w.to)}</span>
        </WorkHeader>
        <div className="w-hero">
          <span className="w-eyebrow w-phone">{shortDate(w.from).toUpperCase()} – {shortDate(w.to).toUpperCase()}</span>
          <h1>{headline(w)}</h1>
          <p>{subline(w)}</p>
        </div>
      </div>

      <main className="w-body">
        <StaleNote err={err} retry={load} />
        <section aria-labelledby="gw-h" className="w-stack">
          <SectionHead id="gw-h" title="Owned work over the week" />
          {w.owned.length === 0 ? (
            <p className="w-card w-calm-empty">No owned items this week.</p>
          ) : (
            <div className="w-card w-pad-x">
              {w.owned.map((o) => {
                const total = Math.max(1, o.total);
                const gain = o.now - o.before;
                return (
                  <div key={o.id} className="w-wrow">
                    <div className="w-wrow-name">
                      <Link href={itemHref(id, o.id)} className="w-ink-link w-strong">{o.title} <span className="w-meta">· {o.owner.displayName}</span></Link>
                      <span className={`w-small tone-${o.tone}`}>{o.stateText} · {o.now}/{o.total}</span>
                    </div>
                    <div className="w-wbar" role="img" aria-label={`${o.before} of ${o.total} steps at the start of the week, ${o.now} now`}>
                      <span className="w-wbar-before" style={{ width: `${(o.before / total) * 100}%` }} />
                      <span className="w-wbar-gain" style={{ left: `${(o.before / total) * 100}%`, width: `${(Math.max(0, gain) / total) * 100}%` }} />
                    </div>
                    <ol className="w-perday" aria-label="Steps finished per day">
                      {o.perDay.map((n, i) => (
                        <li key={i} className={n ? "on" : ""} aria-label={`${dayLabels[i] ?? ""}: ${n}`}>{n || ""}</li>
                      ))}
                    </ol>
                    <span className="w-wrow-delta">{gain > 0 ? `+${plural(gain, "step")}` : "no steps"}</span>
                  </div>
                );
              })}
              <div className="w-perday-labels w-desk-flex" aria-hidden="true">
                {dayLabels.map((d, i) => <span key={i}>{d}</span>)}
                <span className="w-perday-pad" />
              </div>
            </div>
          )}
        </section>

        <div className="w-row">
          <section aria-labelledby="wp-h" className="w-col-main w-stack">
            <SectionHead id="wp-h" title="The week, by person" note="agent hours per day, tinted by kind of work" />
            {w.people.length === 0 ? (
              <p className="w-card w-calm-empty">No agent time recorded this week.</p>
            ) : (
              <>
                <div className="w-weekgrid-box">
                  <table className="w-weekgrid">
                    <thead>
                      <tr>
                        <th scope="col"><span className="w-sr">Person</span></th>
                        {days.map((d, i) => (
                          <th key={i} scope="col" className={i === days.length - 1 ? "today" : ""}>{weekday(d)}{i === days.length - 1 ? " · today" : ""}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {w.people.map((p) => (
                        <tr key={p.who.member}>
                          <th scope="row">
                            <Link href={`/project/${encodeURIComponent(id)}/people/${encodeURIComponent(p.who.member)}`} className="w-weekgrid-who">
                              <Avatar who={p.who} size={28} />
                              <span><span className="w-strong">{p.who.displayName}</span><span className="w-meta">{plural(p.agents, "agent")}</span></span>
                            </Link>
                          </th>
                          {p.days.map((d, i) => (
                            <td key={i} className={i === p.days.length - 1 ? "today" : ""}>
                              <span className="w-hbar" role="img" aria-label={`${hours(d.hours)}${d.parts.length ? `: ${d.parts.map((x) => `${hours(x.hours)} ${x.kind}`).join(", ")}` : ""}`}>
                                {d.parts.map((x, j) => <span key={j} className={`p-${x.kind}`} style={{ width: `${(x.hours / maxH) * 100}%` }} />)}
                              </span>
                              <span className="w-mono w-meta">{d.hours ? hours(d.hours) : ""}</span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <PartsLegend />
              </>
            )}
          </section>

          <aside aria-labelledby="nm-h" className="w-col-side w-stack">
            <SectionHead id="nm-h" title="Per person" note="counted, not scored" />
            <div className="w-card w-table-box">
              {w.table.length === 0 ? (
                <p className="w-quiet w-pad">Nothing counted yet.</p>
              ) : (
                <table className="w-table">
                  <thead>
                    <tr>
                      <th scope="col">Person</th>
                      <th scope="col">Done</th>
                      <th scope="col">Owns</th>
                      <th scope="col">Blocked</th>
                      <th scope="col">Helped</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.table.map((r) => (
                      <tr key={r.who.member}>
                        <th scope="row">{r.who.displayName}</th>
                        <td>{r.done}</td>
                        <td className="w-table-owns">{r.owns || "–"}</td>
                        <td>{hours(r.blockedHours)}</td>
                        <td>{r.helped}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="w-meta w-pad">Helped = questions from teammates’ agents that this person’s agents answered.</p>
            </div>

            {w.look.length > 0 && (
              <>
                <h2 className="w-h2">Worth a look</h2>
                <div className="w-card w-pad-x">
                  {w.look.map((l, i) => (
                    <div key={i} className="w-trait">
                      <span>{l.text}</span>
                      <span className="w-meta">{l.why}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      </main>
      <PhoneTabs projectId={id} current="week" />
    </div>
  );
}
