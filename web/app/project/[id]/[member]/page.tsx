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
                <ForYou items={m.handoffs} projectId={id} member={memberId} onAct={load} />
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
              {m.timeline.length === 0 ? <div className="empty">No activity yet.</div> : <Timeline items={m.timeline} />}
            </Section>

            {m.resolvedHandoffs.length > 0 && (
              <Section label="handoff history">
                <HandoffHistory items={m.resolvedHandoffs} />
              </Section>
            )}

          </div>
        </div>
      </main>
      <footer className="foot"><div className="wrap">{id} · {m.displayName} · <Link href="/privacy">privacy</Link></div></footer>
    </>
  );
}

// Timeline shows the most recent 15 by default; the toggle (in the same spot for
// both states) reveals the rest or folds it back.
function Timeline({ items }: { items: MemberDetail["timeline"] }) {
  const PAGE = 15;
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? items : items.slice(0, PAGE);
  const overflow = items.length - PAGE;
  return (
    <>
      <div className="timeline doc-tl">
        {shown.map((t, k) => (
          <div className="tl" key={k}>
            <span className="tk">{t.kind}</span>
            <span style={{ flex: 1 }}>{t.summary}</span>
            <span className="mono" style={{ whiteSpace: "nowrap" }}>{timeAgo(t.at)}</span>
          </div>
        ))}
      </div>
      {overflow > 0 && (
        <button className="tl-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "show less ▴" : `show ${overflow} more ▾`}
        </button>
      )}
    </>
  );
}

const HKIND: Record<string, string> = { mention: "@mention", collision: "collision", blocker: "blocker", fyi: "fyi" };

// Incoming handoffs ("for you"). Filter by kind, bulk-clear (with confirmation),
// and shows the top 3 by default — as each is resolved it drops out (the list
// reloads) and the next slides in, so the stack never eats the page. "show more"
// reveals the rest; "show less" folds back to 3.
type HKind = MemberDetail["handoffs"][number]["kind"];
function ForYou({ items, projectId, member, onAct }: { items: MemberDetail["handoffs"]; projectId: string; member: string; onAct: () => void }) {
  const TOP = 3;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | HKind>("all");

  // Kinds actually present, in a stable order, for the filter chips.
  const order: HKind[] = ["mention", "blocker", "collision", "fyi"];
  const present = order.filter((k) => items.some((h) => h.kind === k));
  const active = filter !== "all" && !present.includes(filter) ? "all" : filter; // filter may no longer apply after a clear
  const filtered = active === "all" ? items : items.filter((h) => h.kind === active);
  const shown = expanded ? filtered : filtered.slice(0, TOP);
  const overflow = filtered.length - TOP;

  const resolveAll = async () => {
    const label = active === "all" ? "" : `${HKIND[active] || active} `;
    if (!window.confirm(`Resolve all ${filtered.length} ${label}handoff${filtered.length > 1 ? "s" : ""}? This can't be undone.`)) return;
    await api.resolveHandoffs(projectId, member, active === "all" ? undefined : active);
    setExpanded(false);
    onAct();
  };

  return (
    <>
      <div className="foryou-bar">
        <div className="foryou-filters">
          {(["all", ...present] as const).map((k) => (
            <button
              key={k}
              className={`fchip${active === k ? " on" : ""}`}
              onClick={() => setFilter(k)}
            >
              {k === "all" ? `all ${items.length}` : `${HKIND[k] || k} ${items.filter((h) => h.kind === k).length}`}
            </button>
          ))}
        </div>
        <div className="foryou-actions">
          {expanded && overflow > 0 && (
            <button className="tl-more mini" onClick={() => setExpanded(false)}>collapse ▴</button>
          )}
          {filtered.length > 1 && (
            <button className="tiny danger" onClick={resolveAll}>resolve all ({filtered.length})</button>
          )}
        </div>
      </div>
      <div className="handoffs">
        {shown.map((h) => (
          <div className={`handoff ${h.kind}${h.status === "ack" ? " ackd" : ""}`} key={h.id}>
            <div className="hmeta">
              <span className="hkind">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span>
              {h.status === "ack" && <span className="mono">ack’d</span>}
            </div>
            <div className="htext">{h.text}</div>
            <div className="hacts">
              {h.status === "open" && (
                <button className="tiny" onClick={() => api.handoff(h.id, projectId, "ack").then(onAct)}>ack</button>
              )}
              <button className="tiny" onClick={() => api.handoff(h.id, projectId, "resolve").then(onAct)}>resolve</button>
            </div>
          </div>
        ))}
      </div>
      {overflow > 0 && (
        <button className="tl-more" onClick={() => setExpanded((v) => !v)}>
          {expanded ? "show less ▴" : `show ${overflow} more ▾`}
        </button>
      )}
    </>
  );
}

// Resolved handoffs — read-only history, collapsed by default behind a count.
function HandoffHistory({ items }: { items: MemberDetail["resolvedHandoffs"] }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button className="tl-more" onClick={() => setOpen(true)}>
        show {items.length} resolved ▾
      </button>
    );
  }
  return (
    <>
      <div className="hist">
        {items.map((h) => (
          <div className="histrow" key={h.id}>
            <span className="histkind">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span>
            <span className="histtext">{h.text}</span>
            <span className="mono" style={{ whiteSpace: "nowrap" }}>{timeAgo(h.createdAt)}</span>
          </div>
        ))}
      </div>
      <button className="tl-more" onClick={() => setOpen(false)}>show less ▴</button>
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
