"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, installCommand } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { CopyCommand } from "@/components/copy-command";
import { AuthShell, Field, FormError } from "../auth-shell";

const MIN_PASSWORD = 10;

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  // After signup we honour ?next= (same-origin paths only) so an invite flow
  // (/join?code=...) can resume.
  const next = safeNext(params.get("next"));

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  // The machine tokens signup mints, kept only to show them once.
  const [created, setCreated] = useState<{ email: string; tokens: { ingest: string; access: string; admin: string } } | null>(null);

  useEffect(() => {
    api.me().then((m) => { if (!m.auth || m.workspace) router.replace(next); }).catch(() => {});
  }, [router, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!email.trim()) { setErr("Enter your email."); return; }
    if (password.length < MIN_PASSWORD) { setErr(`Password must be at least ${MIN_PASSWORD} characters.`); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      const r = await api.signup(email.trim(), password, workspaceName.trim() || undefined);
      // A fresh signup (no invite to resume) gets its tokens shown once before the dashboard.
      if (r.tokens && next === "/dashboard") { setCreated({ email: r.user.email, tokens: r.tokens }); return; }
      // next is a same-origin path (e.g. /join?code=...) so it resolves the invite.
      router.replace(next);
    } catch (e) {
      // The signup endpoint returns 409 when the email is already registered.
      if (e instanceof ApiError && e.status === 409) setErr("That email is already registered. Try logging in instead.");
      else if (e instanceof ApiError) setErr(`Could not create your account: ${e.message}.`);
      else setErr("Could not create your account right now. Please try again.");
      setBusy(false);
    }
  };

  const loginHref = next === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

  if (created) {
    const t = created.tokens;
    return (
      <AuthShell
        eyebrow="Account ready"
        title="Save your tokens."
        lede={<><b>These are shown once.</b> Store them somewhere safe now: they cannot be shown again. You can revoke them later from &ldquo;manage tokens&rdquo; on a project page.</>}
        panel={{ title: "You are in.", text: "Next, create a project and connect your first agent. Reins walks you through it." }}
      >
        <div className="au-tokens">
          <div className="au-tk">Install the capture hook<span>Run in your agent&rsquo;s repo. Uses the ingest token.</span></div>
          <CopyCommand block text={installCommand({ url: window.location.origin, me: created.email, token: t.ingest })} />
          <div className="au-tk">Ingest<span>Lets agent hooks report activity.</span></div>
          <CopyCommand block text={t.ingest} />
          <div className="au-tk">Access<span>Signs a dashboard (token sign in) or the MCP server in to the board.</span></div>
          <CopyCommand block text={t.access} />
          <div className="au-tk">Admin<span>Manages the workspace. Keep it like a password.</span></div>
          <CopyCommand block text={t.admin} />
        </div>
        <button type="button" className="rz-btn primary" style={{ marginTop: 14 }} onClick={() => router.replace("/dashboard")}>
          I&rsquo;ve stored them, continue
        </button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      eyebrow="Sign up"
      title="Create your account."
      lede={<>One account, one workspace to start. You become the owner and your machine tokens are minted for you. Already have an account? <Link href={loginHref} className="au-link">Log in</Link>.</>}
    >
      <form onSubmit={submit} className="au-form" noValidate>
        <Field id="email" label="Email" type="email" placeholder="you@team.com" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} autoComplete="email" />
        <Field id="password" label="Password" hint={`At least ${MIN_PASSWORD} characters.`} type="password" placeholder="A strong password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <Field id="confirm" label="Confirm password" type="password" placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        <Field id="workspace" label="Workspace name (optional)" type="text" placeholder="My Team" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} spellCheck={false} autoComplete="organization" />
        {err && <FormError>{err}</FormError>}
        <button className="rz-btn primary" disabled={busy}>{busy ? "Creating…" : "Create account"}</button>
      </form>
    </AuthShell>
  );
}

export default function Signup() {
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
