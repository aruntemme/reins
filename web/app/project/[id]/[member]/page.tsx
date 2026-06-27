"use client";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { api, timeAgo, type MemberDetail, type Trait, type TraitType } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar, Avatar, STATUS } from "@/components/ui";

const TRAIT_GROUPS: { type: TraitType; label: string }[] = [
  { type: "tooling", label: "Tools & tech" },
  { type: "quality", label: "Quality bar" },
  { type: "communication", label: "Communication" },
  { type: "concern", label: "Cares about" },
  { type: "workflow", label: "Workflow" },
];

export default function MemberPage({ params }: { params: Promise<{ id: string; member: string }> }) {
  const { id, member } = use(params);
  const memberId = decodeURIComponent(member);
  const [m, setM] = useState<MemberDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [meMember, setMeMember] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setM(await api.member(id, memberId));
    } catch (e) {
      if (handleAuth(e)) return;
      setMissing(true);
    }
  }, [id, memberId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.me().then((me) => setMeMember(me.member ?? null)).catch(() => {}); }, []);
  const live = useStream(id, load);
  const isMe = !!meMember && meMember === memberId;

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
            <Link href={`/project/${id}`} className="mono">‹ {id}</Link>
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
                        <span className="hkind">{h.kind}{h.from ? ` · ${h.from}` : ""}</span>
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

            <Section label={isMe ? "your grain" : "grain"} sq="blue">
              {m.profile.length === 0 ? (
                <div className="empty">No profile yet — {isMe ? "yours" : "theirs"} builds up from how {isMe ? "you" : "they"} work.</div>
              ) : (
                <ProfileCard traits={m.profile} editable={isMe} onRemove={(tid) => api.deleteTrait(tid).then(load)} />
              )}
            </Section>

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

            <Section label="signal pulse">
              {m.signals.length === 0 ? <div className="empty">No signals yet.</div> : (
                <>
                  <div className="rawlist">
                    {m.signals.map((e, k) => (
                      <div className="rawrow" key={k}>
                        <span className={`tk2 ${e.significance === "noise" ? "noise" : ""}`}>{e.kind}{e.significance ? `·${e.significance}` : ""}</span>
                        <span className="rawtext muted">·</span>
                        <span className="mono">{timeAgo(e.at)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mono priv-note">Raw prompts stay private — distilled into the timeline and profile above.</div>
                </>
              )}
            </Section>
          </div>
        </div>
      </main>
      <footer className="foot"><div className="wrap">{id} · {m.displayName}</div></footer>
    </>
  );
}

function ProfileCard({ traits, editable, onRemove }: { traits: Trait[]; editable: boolean; onRemove: (id: string) => void }) {
  return (
    <div className="grain">
      {TRAIT_GROUPS.map(({ type, label }) => {
        const ts = traits.filter((t) => t.type === type);
        if (ts.length === 0) return null;
        return (
          <div className="grain-grp" key={type}>
            <div className="grain-label">{label}</div>
            <div className="grain-list">
              {ts.map((t) => (
                <div className={`grain-trait lvl-${t.level}`} key={t.id} title={`${t.level} confidence · seen ${t.observations}×`}>
                  <span className="grain-dot" />
                  <span className="grain-text">{t.statement}</span>
                  {editable && (
                    <button className="grain-x" onClick={() => onRemove(t.id)} aria-label="remove trait">×</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
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
