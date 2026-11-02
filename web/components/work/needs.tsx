"use client";
import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { api, type Need, type TodayData } from "@/lib/api";
import { useAction } from "./shell";
import { ago, voice } from "./format";
import { itemHref } from "./lane";

/**
 * A question or decision someone's agent put to you, answered in place.
 * Questions: type an answer, or let your own agent answer from its context.
 * Decisions: approve, or say what should change.
 */
export function AskCard({
  head,
  text,
  meta,
  postId,
  type,
  to,
  delegated,
  delegateFirst,
  onDone,
  id,
}: {
  head: React.ReactNode;
  text: string;
  meta?: React.ReactNode;
  postId: string;
  type: "question" | "decision";
  /** Whose agent the answer goes to, for the placeholder ("Ravi"). */
  to: string;
  delegated?: boolean;
  /** My day leads with "Let my agent answer"; elsewhere typing an answer comes first. */
  delegateFirst?: boolean;
  onDone: () => void;
  id?: string;
}) {
  const uid = useId();
  const [text2, setText2] = useState("");
  const [writing, setWriting] = useState(!delegateFirst && type === "question");
  const [sent, setSent] = useState<"" | "answered" | "delegated" | "approved" | "changed">(delegated ? "delegated" : "");
  const { busy, err, run } = useAction(onDone);

  const answer = async () => {
    const t = text2.trim();
    if (!t) return;
    const ok = type === "question" ? await run(() => api.answerPost(postId, t)) : await run(() => api.resolvePost(postId, "changed", t));
    if (ok) { setText2(""); setSent(type === "question" ? "answered" : "changed"); }
  };
  const delegate = async () => { if (await run(() => api.delegatePost(postId))) setSent("delegated"); };
  const approve = async () => { if (await run(() => api.resolvePost(postId, "approved"))) setSent("approved"); };

  const done = sent && sent !== "delegated";
  return (
    <div className="w-ask" id={id}>
      <span className="w-ask-k">{head}</span>
      <span>{text}</span>
      {meta && <span className="w-mono w-meta">{meta}</span>}
      {done ? (
        <p className="w-ask-done" role="status">
          {sent === "answered" ? "Answer sent. Their agent reads it at its next prompt." : sent === "approved" ? "Approved." : "Sent back with your change."}
        </p>
      ) : (
        <>
          {sent === "delegated" && (
            <p className="w-ask-done" role="status">Your agent will answer at its next prompt, from its own context.</p>
          )}
          {writing && (
            <form className="w-ask-form" onSubmit={(e) => { e.preventDefault(); answer(); }}>
              <label htmlFor={uid} className="w-sr">{type === "question" ? "Your answer" : "What should change"}</label>
              <input
                id={uid}
                type="text"
                value={text2}
                onChange={(e) => setText2(e.target.value)}
                placeholder={type === "question" ? `Answer ${to}’s agent…` : "What should change…"}
                autoFocus={delegateFirst || type === "decision"}
                maxLength={2000}
              />
              <button type="submit" className="w-btn pink" disabled={busy || !text2.trim()}>
                {type === "question" ? "Send" : "Send change"}
              </button>
            </form>
          )}
          <div className="w-ask-acts">
            {type === "question" ? (
              <>
                {sent !== "delegated" && (
                  <button type="button" className={`w-btn ${delegateFirst ? "pink" : "pink-ghost"}`} onClick={delegate} disabled={busy}>
                    {delegateFirst ? "Let my agent answer" : "My agent answers"}
                  </button>
                )}
                {!writing && (
                  <button type="button" className="w-btn pink-ghost" onClick={() => setWriting(true)}>Answer myself</button>
                )}
              </>
            ) : (
              <>
                <button type="button" className="w-btn pink" onClick={approve} disabled={busy}>Approve</button>
                {!writing && <button type="button" className="w-btn pink-ghost" onClick={() => setWriting(true)}>Change</button>}
              </>
            )}
          </div>
        </>
      )}
      {err && <p className="w-err" role="alert">{err}</p>}
    </div>
  );
}

const TAG: Record<Need["type"], string> = { question: "Question", decision: "Decision", blocked: "Blocked", overlap: "Same file" };

/** Blocked work and same-file overlaps: a quiet card with two actions. */
function NeedCard({
  projectId,
  need,
  overlaps,
  compact,
  onDone,
  onDismiss,
  onHandover,
}: {
  projectId: string;
  need: Need;
  overlaps: TodayData["tracks"]["overlaps"];
  compact?: boolean;
  onDone: () => void;
  onDismiss: (id: string) => void;
  onHandover?: (item: { id: string; title: string }) => void;
}) {
  const uid = useId();
  const [open, setOpen] = useState(!compact);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState("");
  const [sent, setSent] = useState("");
  const { busy, err, run } = useAction(onDone);

  const unblock = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await run(async () => {
      if (need.postId) await api.answerPost(need.postId, t);
      else await api.createPost(projectId, { kind: "note", text: t, toMember: need.from.member, ...(need.item ? { itemId: need.item.id } : {}) });
      // What unblocks it is on its way: the item is back in progress and leaves "Needs you".
      if (need.item) await api.patchItem(need.item.id, { status: "doing" });
    });
    if (ok) { setText(""); setWriting(false); setSent(`Sent to ${need.from.displayName}’s agent.`); }
  };

  const tellBoth = async () => {
    const o = overlaps.find((x) => need.text.includes(x.path) || need.meta?.includes(x.path) || need.text.includes(x.path.split("/").pop() || "\u0000"));
    const members = o ? o.members.map((m) => m.member) : [need.from.member];
    const note = `Heads-up from the team view: ${need.text}${o ? "" : need.meta ? ` (${need.meta})` : ""} Please check with each other before going further.`;
    const ok = await run(() => Promise.all(members.map((m) => api.createPost(projectId, { kind: "note", text: note, toMember: m }))));
    if (ok) setSent(o ? `Told ${o.members.map((m) => m.displayName).join(" and ")}.` : `Told ${need.from.displayName}.`);
  };

  const dismiss = async () => {
    if (need.postId) { if (await run(() => api.resolvePost(need.postId!, "dismissed"))) onDismiss(need.id); }
    else onDismiss(need.id);
  };

  const body = (
    <>
      {need.item && (
        <Link href={itemHref(projectId, need.item.id)} className="w-small">{need.item.title}</Link>
      )}
      {sent ? (
        <p className="w-ok" role="status">{sent}</p>
      ) : need.type === "blocked" ? (
        <>
          {writing && (
            <form className="w-ask-form" onSubmit={(e) => { e.preventDefault(); unblock(); }}>
              <label htmlFor={uid} className="w-sr">What unblocks it</label>
              <input id={uid} type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Tell ${need.from.displayName}’s agent what unblocks it…`} autoFocus maxLength={2000} />
              <button type="submit" className="w-btn strong" disabled={busy || !text.trim()}>Send</button>
            </form>
          )}
          <div className="w-ask-acts">
            {!writing && <button type="button" className="w-btn strong" onClick={() => setWriting(true)}>Unblock</button>}
            {need.item && onHandover && (
              <button type="button" className="w-btn" onClick={() => onHandover(need.item!)}>Reassign</button>
            )}
          </div>
        </>
      ) : (
        <div className="w-ask-acts">
          <button type="button" className="w-btn strong" onClick={tellBoth} disabled={busy}>Tell both</button>
          <button type="button" className="w-btn" onClick={dismiss} disabled={busy}>Dismiss</button>
        </div>
      )}
      {err && <p className="w-err" role="alert">{err}</p>}
    </>
  );

  const tagCls = need.type === "blocked" ? "amber" : "pink";
  if (compact) {
    return (
      <div className="w-needrow">
        <button type="button" className="w-needrow-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <span className={`w-tag ${tagCls}`}>{TAG[need.type]}</span>
          <span className="w-needrow-t">{need.text}</span>
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="w-chev"><path d="M9 6l6 6-6 6" /></svg>
        </button>
        {open && <div className="w-needrow-body">{body}</div>}
      </div>
    );
  }
  return (
    <div className="w-card w-need">
      <span className={`w-tag ${tagCls}`}>{TAG[need.type]}</span>
      <span className="w-need-t">{need.text}</span>
      {need.meta && <span className="w-mono w-meta">{need.meta}</span>}
      {body}
    </div>
  );
}

const DISMISSED = "reins-dismissed-needs";
function readDismissed(): string[] {
  try { return JSON.parse(localStorage.getItem(DISMISSED) || "[]"); } catch { return []; }
}

/** "Needs you": questions and decisions answered in place, then blocked work and overlaps. Oldest first. */
export function NeedsPanel({
  projectId,
  needs,
  overlaps,
  now,
  onDone,
  onHandover,
  compact,
}: {
  projectId: string;
  needs: Need[];
  overlaps: TodayData["tracks"]["overlaps"];
  now: number;
  onDone: () => void;
  onHandover: (item: { id: string; title: string }) => void;
  compact?: boolean;
}) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => setDismissed(readDismissed()), []);
  const dismiss = (id: string) => {
    const next = [...dismissed, id].slice(-200);
    setDismissed(next);
    try { localStorage.setItem(DISMISSED, JSON.stringify(next)); } catch { /* per-viewer convenience only */ }
  };

  const shown = needs.filter((n) => !dismissed.includes(n.id)).sort((a, b) => a.at - b.at);
  const asks = shown.filter((n) => (n.type === "question" || n.type === "decision") && n.postId);
  const rest = shown.filter((n) => !asks.includes(n));

  if (shown.length === 0) {
    return <p className="w-card w-calm-empty">Nothing needs you. Agents are getting on with it.</p>;
  }
  return (
    <>
      {asks.map((n) => (
        <AskCard
          key={n.id}
          head={<>{n.type === "question" ? "Question" : "Decision"} · {voice(n.from, n.from.source)} · {ago(n.at, now)}</>}
          text={n.text}
          meta={[n.item?.title, n.meta].filter(Boolean).join(" · ") || undefined}
          postId={n.postId!}
          type={n.type as "question" | "decision"}
          to={n.from.displayName}
          onDone={onDone}
        />
      ))}
      {rest.length > 0 && (
        compact ? (
          <div className="w-card w-list">
            {rest.map((n) => (
              <NeedCard key={n.id} projectId={projectId} need={n} overlaps={overlaps} compact onDone={onDone} onDismiss={dismiss} onHandover={onHandover} />
            ))}
          </div>
        ) : rest.map((n) => (
          <NeedCard key={n.id} projectId={projectId} need={n} overlaps={overlaps} onDone={onDone} onDismiss={dismiss} onHandover={onHandover} />
        ))
      )}
    </>
  );
}
