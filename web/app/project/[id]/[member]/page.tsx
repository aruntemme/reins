"use client";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { api, timeAgo, type MemberDetail } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar, Avatar, STATUS } from "@/components/ui";

export default function MemberPage({ params }: { params: Promise<{ id: string; member: string }> }) {
  const { id, member } = use(params);
  const [m, setM] = useState<MemberDetail | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async () => {
    try {
      setM(await api.member(id, decodeURIComponent(member)));
    } catch (e) {
      if (handleAuth(e)) return;
      setMissing(true);
    }
  }, [id, member]);

  useEffect(() => { load(); }, [load]);
  const live = useStream(id, load);

  if (missing)
    return (<><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="card pad empty">Not found. <Link href={`/project/${id}`} className="hl">Back</Link></div></div></main></>);
  if (!m)
    return (<><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="empty">Loading…</div></div></main></>);

  const s = STATUS[m.displayStatus] ?? STATUS.idle;

  return (
    <>
      <TopBar brandHref="/dashboard" live={live} />
      <main className="wrap">
        <div className="dash member">
          <div className="crumbs">
            <Link href={`/project/${id}`} className="mono">← {id}</Link>
            <span className="mono">/</span>
            <span className="label"><span className={`sq ${s.cls}`} /> {m.live ? s.label : "idle"}</span>
          </div>

          <div className="mhero">
            <Avatar name={m.displayName} i={2} />
            <div>
              <h1 className="display mname">{m.displayName}</h1>
              <div className="mono">{m.live ? `active · last signal ${timeAgo(m.lastSeen)}` : `last seen ${timeAgo(m.lastSeen)}`}</div>
            </div>
          </div>

          <div className="doc">
            {m.handoffs.length > 0 && (
              <Section label="for you" sq="blocked">
                <div className="handoffs">
                  {m.handoffs.map((h) => (
                    <div className={`handoff ${h.kind}${h.status === "ack" ? " ackd" : ""}`} key={h.id}>
                      <div className="hmeta">
                        <span className="hkind">↳ {h.kind}{h.from ? ` · ${h.from}` : ""}</span>
                        {h.status === "ack" && <span className="mono">ack’d</span>}
                      </div>
                      <div className="htext">{h.text}</div>
                      <div className="hacts">
                        {h.status === "open" && (
                          <button className="tiny" onClick={() => api.handoff(h.id, id, "ack").then(load)}>ack</button>
                        )}
                        <button className="tiny" onClick={() => api.handoff(h.id, id, "resolve").then(load)}>resolve</button>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            <Section label="now">
              <div className="bighead">{m.headline || "…"}</div>
            </Section>

            {m.goal && (
              <Section label="goal" sq="blue">
                <div className="sub" style={{ fontSize: 16 }}>{m.goal}</div>
              </Section>
            )}

            {m.workingOn.length > 0 && (
              <Section label="working on">
                <div className="chiprow">{m.workingOn.map((w, k) => <span key={k} className="chip">{w}</span>)}</div>
              </Section>
            )}

            {m.pending.length > 0 && (
              <Section label="pending from them" sq="blocked">
                <div className="plist">
                  {m.pending.map((p) => (
                    <div className="prow" key={p.id}>
                      <span className="ptext">{p.text}</span>
                      <span className="mono">{p.status === "claimed" ? `claimed by ${p.claimedBy}` : "open"}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            <Section label="timeline" sq="active">
              {m.timeline.length === 0 ? <div className="empty">No activity yet.</div> : (
                <div className="timeline doc-tl">
                  {m.timeline.map((t, k) => (
                    <div className="tl" key={k}>
                      <span className="tk">{t.kind}</span>
                      <span style={{ flex: 1 }}>{t.summary}</span>
                      <span className="mono" style={{ whiteSpace: "nowrap" }}>{timeAgo(t.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            <Section label="raw signals">
              <div className="rawlist">
                {m.events.map((e, k) => (
                  <div className="rawrow" key={k}>
                    <span className={`tk2 ${e.significance === "noise" ? "noise" : ""}`}>{e.kind}{e.significance ? `·${e.significance}` : ""}</span>
                    <span className="rawtext">{e.text}</span>
                    <span className="mono">{timeAgo(e.at)}</span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </div>
      </main>
      <footer className="foot"><div className="wrap">{id} · {m.displayName}</div></footer>
    </>
  );
}

function Section({ label, sq = "", children }: { label: string; sq?: string; children: React.ReactNode }) {
  return (
    <section className="docsec">
      <div className="label"><span className={`sq ${sq}`} /> {label}</div>
      <div className="docbody">{children}</div>
    </section>
  );
}
