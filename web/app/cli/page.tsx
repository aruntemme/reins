"use client";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, errorMessage, type CliLogin } from "@/lib/api";
import { handleAuth } from "@/lib/guard";
import { AuthShell, FormError } from "../auth-shell";
import "./cli.css";

type Phase =
  | { at: "loading" }
  | { at: "missing" } // no ?code=
  | { at: "gone" } // unknown or expired
  | { at: "error"; message: string }
  | { at: "ready"; login: CliLogin }
  | { at: "closed"; status: "approved" | "consumed" | "denied" }
  | { at: "done"; project: { id: string; name: string } }
  | { at: "denied" };

const NEW = "\u0000new";
const PANEL = { title: "Your terminal, on the board.", text: "Approve this machine once and Reins configures your coding agents for you. No tokens to copy." };

function CliApprove() {
  const params = useSearchParams();
  const code = (params.get("code") || "").trim().toUpperCase();
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  // The chosen project: an existing project id, or NEW with the editable name below.
  const [choice, setChoice] = useState<string>(NEW);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const [err, setErr] = useState("");
  const title = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    if (!code) { setPhase({ at: "missing" }); return; }
    setPhase({ at: "loading" });
    try {
      const login = await api.cliLogin(code);
      if (login.status === "expired") { setPhase({ at: "gone" }); return; }
      if (login.status !== "pending") { setPhase({ at: "closed", status: login.status }); return; }
      const existing = login.projects.some((p) => p.id === login.suggestedProject);
      setChoice(existing ? login.suggestedProject : NEW);
      setNewName(login.suggestedProject);
      setPhase({ at: "ready", login });
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) setPhase({ at: "gone" });
      else setPhase({ at: "error", message: errorMessage(e) });
    }
  }, [code]);

  useEffect(() => { load(); }, [load]);

  // Move focus to the new heading when the state changes, so screen readers announce it.
  useEffect(() => { if (phase.at !== "loading") title.current?.focus(); }, [phase.at]);

  const approve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.at !== "ready") return;
    const name = newName.trim();
    if (choice === NEW && !name) { setErr("Give the new project a name."); return; }
    setErr(""); setBusy("approve");
    try {
      const r = await api.cliApprove(code, choice === NEW ? { newProject: { name } } : { project: choice });
      setPhase({ at: "done", project: r.project });
    } catch (e) {
      if (handleAuth(e)) return;
      if (e instanceof ApiError && e.status === 410) setPhase({ at: "gone" });
      else if (e instanceof ApiError && e.status === 409) await load(); // someone (or another tab) already answered it
      else setErr(errorMessage(e));
    }
    setBusy(null);
  };

  const deny = async () => {
    setErr(""); setBusy("deny");
    try {
      await api.cliDeny(code);
      setPhase({ at: "denied" });
    } catch (e) {
      if (!handleAuth(e)) setErr(errorMessage(e));
    }
    setBusy(null);
  };

  const heading = (text: React.ReactNode) => <span ref={title} tabIndex={-1} className="cl-h">{text}</span>;

  if (phase.at === "loading") {
    return <AuthShell eyebrow="Connect terminal" title="Checking your terminal…" panel={PANEL}><p className="au-sub" role="status">One moment.</p></AuthShell>;
  }

  if (phase.at === "missing") {
    return (
      <AuthShell eyebrow="Connect terminal" title={heading("No code in this link.")} lede={<>Run <code>npx reins-hook</code> in your repo and open the link it prints.</>} panel={PANEL}>
        <div className="au-actions"><Link href="/dashboard" className="rz-btn ghost">Go to dashboard</Link></div>
      </AuthShell>
    );
  }

  if (phase.at === "gone") {
    return (
      <AuthShell
        eyebrow="Connect terminal"
        title={heading("This code has expired.")}
        lede={<>Codes last about ten minutes and work once. Run <code>npx reins-hook</code> in your repo again to get a fresh one.</>}
        panel={PANEL}
      >
        <div className="au-actions"><Link href="/dashboard" className="rz-btn ghost">Go to dashboard</Link></div>
      </AuthShell>
    );
  }

  if (phase.at === "error") {
    return (
      <AuthShell eyebrow="Connect terminal" title={heading("Could not load this request.")} panel={PANEL}>
        <FormError>{phase.message}</FormError>
        <div className="au-actions"><button type="button" className="rz-btn primary" onClick={load}>Try again</button></div>
      </AuthShell>
    );
  }

  if (phase.at === "closed") {
    const denied = phase.status === "denied";
    return (
      <AuthShell
        eyebrow="Connect terminal"
        title={heading(denied ? "This request was denied." : "Already approved.")}
        lede={denied
          ? <>That terminal was not connected. To try again, run <code>npx reins-hook</code> in your repo.</>
          : <>This terminal has already been approved, so there is nothing left to do here. Go back to your terminal.</>}
        panel={PANEL}
      >
        <div className="au-actions"><Link href="/dashboard" className="rz-btn ghost">Go to dashboard</Link></div>
      </AuthShell>
    );
  }

  if (phase.at === "denied") {
    return (
      <AuthShell
        eyebrow="Connect terminal"
        title={heading("Request denied.")}
        lede="Nothing was connected and the terminal has been told. You can close this tab."
        panel={PANEL}
      >
        <div className="au-actions"><Link href="/dashboard" className="rz-btn ghost">Go to dashboard</Link></div>
      </AuthShell>
    );
  }

  if (phase.at === "done") {
    return (
      <AuthShell
        eyebrow="Connected"
        title={heading("Terminal connected.")}
        lede={<>Your terminal is finishing the setup for <b>{phase.project.name}</b> now. You will show up on the board in a few seconds.</>}
        panel={PANEL}
      >
        <div className="au-actions">
          <Link href={`/project/${encodeURIComponent(phase.project.id)}`} className="rz-btn primary">Open the {phase.project.name} board</Link>
        </div>
      </AuthShell>
    );
  }

  const { login } = phase;
  return (
    <AuthShell
      eyebrow="Connect terminal"
      title={heading("Connect this terminal?")}
      lede="Check that this code matches the one in your terminal before you approve."
      panel={PANEL}
    >
      <p className="cl-code" aria-label={`Code ${login.userCode.split("").join(" ")}`}>{login.userCode}</p>

      <dl className="cl-facts">
        <div><dt>Machine</dt><dd>{login.host || "unknown"}</dd></div>
        <div><dt>Repo</dt><dd>{login.repo || "unknown"}</dd></div>
        <div><dt>Workspace</dt><dd>{login.workspace.name}</dd></div>
      </dl>

      <form onSubmit={approve} className="au-form cl-form" noValidate>
        <fieldset className="cl-choices">
          <legend>Which project is this repo?</legend>
          {login.projects.map((p) => (
            <label key={p.id} className={`cl-opt${choice === p.id ? " on" : ""}`}>
              <input type="radio" name="project" value={p.id} checked={choice === p.id} onChange={() => setChoice(p.id)} />
              <span className="cl-opt-t">{p.name}</span>
              {p.name !== p.id && <span className="cl-opt-s">{p.id}</span>}
            </label>
          ))}
          <label className={`cl-opt${choice === NEW ? " on" : ""}`}>
            <input type="radio" name="project" value={NEW} checked={choice === NEW} onChange={() => setChoice(NEW)} />
            <span className="cl-opt-t">New project</span>
          </label>
          {choice === NEW && (
            <div className="au-field cl-new">
              <label htmlFor="cl-name">New project name</label>
              <input id="cl-name" className="au-input" value={newName} onChange={(e) => setNewName(e.target.value)} spellCheck={false} autoComplete="off" />
            </div>
          )}
        </fieldset>

        {err && <FormError>{err}</FormError>}
        <button className="rz-btn primary" disabled={busy !== null}>{busy === "approve" ? "Approving…" : "Approve"}</button>
        <button type="button" className="rz-btn ghost" onClick={deny} disabled={busy !== null}>{busy === "deny" ? "Denying…" : "Deny"}</button>
      </form>
      <p className="au-sub">Only approve a code you just saw in your own terminal.</p>
    </AuthShell>
  );
}

export default function CliPage() {
  return (
    <Suspense fallback={null}>
      <CliApprove />
    </Suspense>
  );
}
