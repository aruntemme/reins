"use client";
import { useEffect, useState, useCallback, use } from "react";
import Link from "next/link";
import { api, ApiError, errorMessage, timeAgo, type MemberDetail, type Trait, type TraitType } from "@/lib/api";
import { useStream } from "@/lib/useStream";
import { handleAuth } from "@/lib/guard";
import { TopBar, Avatar, STATUS } from "@/components/ui";
import { gitLabel } from "@/components/lead";

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
  // A failed load that is not a 404: transient, cleared on the next good load.
  const [loadErr, setLoadErr] = useState("");
  const [meMember, setMeMember] = useState<string | null>(null);
  // The last failed action (ack/resolve, remove trait), with the server's message.
  const [actErr, setActErr] = useState("");

  const load = useCallback(async () => {
    try {
      setM(await api.member(id, memberId));
      setMissing(false);
      setLoadErr("");
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 404) setMissing(true);
      else setLoadErr(errorMessage(e));
    }
  }, [id, memberId]);

  const act = useCallback((p: Promise<unknown>) => {
    setActErr("");
    p.then(load, (e) => { if (!handleAuth(e)) setActErr(errorMessage(e)); });
  }, [load]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.me().then((me) => setMeMember(me.member ?? null)).catch(() => {}); }, []);
  const live = useStream(id, load);
  const isMe = !!meMember && meMember === memberId;

  if (missing)
    return (<><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash"><div className="card pad empty">Not found. <Link href={`/project/${id}`} className="hl">Back</Link></div></div></main></>);
  if (!m)
    return (<><TopBar brandHref="/dashboard" live={live} /><main className="wrap"><div className="dash">
      {loadErr ? (
        <div className="card pad empty">
          <span className="mono" style={{ color: "var(--blocked)" }}>Could not load this page: {loadErr}</span>{" "}
          <button className="tiny" onClick={load}>retry</button>
        </div>
      ) : <div className="empty">Loading…</div>}
    </div></main></>);

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

          {(loadErr || actErr) && (
            <div className="mono" style={{ color: "var(--blocked)" }}>{actErr || `Could not refresh: ${loadErr}`}</div>
          )}

          <div className="mhero">
            <Avatar name={m.displayName} i={2} />
            <div>
              <h1 className="display mname">{m.displayName}</h1>
              <div className="mono">{m.live ? `active · last signal ${timeAgo(m.lastSeen)}` : `last seen ${timeAgo(m.lastSeen)}`}</div>
              {gitLabel(m) && <div className="mono gitline">{gitLabel(m)}</div>}
            </div>
          </div>

          <div className="doc">
            {(m.directives.length > 0 || m.assignments.length > 0) && (
              <Section label="from the lead" sq="blue">
                <div className="leadlist">
                  {m.directives.map((d) => (
                    <div className="litem" key={d.id}>
                      <div className="ltext">{d.text}</div>
                      <div className="mono">
                        {d.targets.length ? (isMe ? "to you" : `to ${m.displayName}`) : "to the whole team"}
                        {d.by ? ` · from ${d.by}` : ""} · until {new Date(d.expiresAt).toLocaleString()}
                      </div>
                    </div>
                  ))}
                  {m.assignments.map((a) => (
                    <div className="litem" key={a.id}>
                      <div className="ltext"><span className="mono lkind">assigned</span> {a.area}{a.note ? ` — ${a.note}` : ""}</div>
                      <div className="mono">{a.by ? `by ${a.by} · ` : ""}{timeAgo(a.createdAt)}</div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
            {m.handoffs.length > 0 && (
              <Section label="for you" sq="blocked">
                <ForYou items={m.handoffs} projectId={id} member={memberId} act={act} />
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

            {(m.touches.length > 0 || m.workingOn.length > 0) && (
              <Section label="working on">
                <div className="chiprow">
                  {m.touches.map((t) => <span key={`t${t.path}`} className="chip edited" title={`edited ${timeAgo(t.at)}`}>✎ {t.path}</span>)}
                  {m.workingOn.map((w, k) => <span key={k} className="chip">{w}</span>)}
                </div>
              </Section>
            )}

            <Section label={isMe ? "your grain" : "grain"} sq="blue">
              {isMe && (
                <div className="mono" style={{ marginBottom: 10 }}>
                  {m.sharesTraits
                    ? "Shared with your agent at session start and in handoffs routed to you."
                    : "Private to the board — turn on sharing with your agent in Settings."}
                </div>
              )}
              {m.profile.length === 0 ? (
                <div className="empty">No profile yet — {isMe ? "yours" : "theirs"} builds up from how {isMe ? "you" : "they"} work.</div>
              ) : (
                <ProfileCard traits={m.profile} editable={isMe} onRemove={(tid) => act(api.deleteTrait(tid))} />
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
                <HandoffHistory items={m.resolvedHandoffs} projectId={id} act={act} />
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

const HKIND: Record<string, string> = { mention: "@mention", collision: "collision", blocker: "blocker", fyi: "fyi", assignment: "assignment" };

// Incoming handoffs ("for you"). Filter by kind, bulk-clear (with confirmation),
// and shows the top 3 by default — as each is resolved it drops out (the list
// reloads) and the next slides in, so the stack never eats the page. "show more"
// reveals the rest; "show less" folds back to 3.
type HKind = MemberDetail["handoffs"][number]["kind"];
function ForYou({ items, projectId, member, act }: { items: MemberDetail["handoffs"]; projectId: string; member: string; act: (p: Promise<unknown>) => void }) {
  const TOP = 3;
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState<"all" | HKind>("all");

  // Kinds actually present, in a stable order, for the filter chips.
  const order: HKind[] = ["assignment", "mention", "blocker", "collision", "fyi"];
  const present = order.filter((k) => items.some((h) => h.kind === k));
  const active = filter !== "all" && !present.includes(filter) ? "all" : filter; // filter may no longer apply after a clear
  const filtered = active === "all" ? items : items.filter((h) => h.kind === active);
  const shown = expanded ? filtered : filtered.slice(0, TOP);
  const overflow = filtered.length - TOP;

  const resolveAll = () => {
    const label = active === "all" ? "" : `${HKIND[active] || active} `;
    if (!window.confirm(`Resolve all ${filtered.length} ${label}handoff${filtered.length > 1 ? "s" : ""}? This can't be undone.`)) return;
    setExpanded(false);
    act(api.resolveHandoffs(projectId, member, active === "all" ? undefined : active));
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
            {!!h.conventions?.length && <div className="hconv">your conventions: {h.conventions.join("; ")}</div>}
            <div className="hacts">
              {h.status === "open" && (
                <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "ack"))}>ack</button>
              )}
              <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "resolve"))}>resolve</button>
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

// Resolved handoffs — history, collapsed by default behind a count. One that
// Reins closed on its own says why and can be reopened in one click.
function HandoffHistory({ items, projectId, act }: { items: MemberDetail["resolvedHandoffs"]; projectId: string; act: (p: Promise<unknown>) => void }) {
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
          <div className={`histrow${h.autoClosed ? " auto" : ""}`} key={h.id}>
            <span className="histkind">{HKIND[h.kind] || h.kind}{h.from ? ` · ${h.from}` : ""}</span>
            <span className="histbody">
              <span className="histtext">{h.text}</span>
              {h.autoClosed && <span className="histauto" title={h.autoClosed.event ? `event ${h.autoClosed.event}` : undefined}>auto-closed: {h.autoClosed.reason}</span>}
            </span>
            {h.autoClosed
              ? <button className="tiny" onClick={() => act(api.handoff(h.id, projectId, "reopen"))}>reopen</button>
              : <span className="mono" style={{ whiteSpace: "nowrap" }}>{timeAgo(h.createdAt)}</span>}
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
