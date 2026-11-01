"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, installCommand } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { TopBar } from "@/components/ui";
import { CopyCommand } from "@/components/copy-command";

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
      <main className="wrap">
        <div className="signin">
          <div className="label" style={{ marginBottom: 18 }}><span className="sq active" /> account ready</div>
          <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Save your tokens.</h1>
          <p className="sub" style={{ maxWidth: 520, marginBottom: 24 }}>
            <b>These are shown once.</b> Store them somewhere safe now: they cannot be shown again. You can
            revoke them later from &ldquo;manage tokens&rdquo; on a project page.
          </p>
          <div className="card pad" style={{ display: "grid", gap: 10, maxWidth: 620 }}>
            <div className="mono muted" style={{ fontSize: 11.5 }}>install the capture hook in your agent&rsquo;s repo (uses the ingest token)</div>
            <CopyCommand block text={installCommand({ url: window.location.origin, me: created.email, token: t.ingest })} />
            <div className="mono muted" style={{ fontSize: 11.5, marginTop: 8 }}>ingest: lets agent hooks report activity</div>
            <CopyCommand block text={t.ingest} />
            <div className="mono muted" style={{ fontSize: 11.5, marginTop: 8 }}>access: signs a dashboard (token sign in) or the MCP server in to the board</div>
            <CopyCommand block text={t.access} />
            <div className="mono muted" style={{ fontSize: 11.5, marginTop: 8 }}>admin: manages the workspace; keep it like a password</div>
            <CopyCommand block text={t.admin} />
            <button className="btn solid" style={{ justifyContent: "center", marginTop: 8 }} onClick={() => router.replace("/dashboard")}>
              I&rsquo;ve stored them, continue
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="wrap">
      <div className="signin">
        <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> sign up</div>
        <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Create your account.</h1>
        <p className="sub" style={{ maxWidth: 480, marginBottom: 24 }}>
          One account, one workspace to start. You become the owner and your machine tokens are
          minted for you. Already have an account?{" "}
          <Link href={loginHref} className="hl" style={{ color: "var(--ink)" }}>Log in</Link>.
        </p>

        <form onSubmit={submit} className="card pad" style={{ display: "grid", gap: 14, maxWidth: 520 }}>
          <label className="mono muted" style={{ fontSize: 11.5 }}>email</label>
          <input
            className="tokeninput"
            type="email"
            placeholder="you@team.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            spellCheck={false}
            autoComplete="email"
          />
          <label className="mono muted" style={{ fontSize: 11.5 }}>password (at least {MIN_PASSWORD} characters)</label>
          <input
            className="tokeninput"
            type="password"
            placeholder="a strong password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <label className="mono muted" style={{ fontSize: 11.5 }}>confirm password</label>
          <input
            className="tokeninput"
            type="password"
            placeholder="repeat your password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          <label className="mono muted" style={{ fontSize: 11.5 }}>workspace name (optional)</label>
          <input
            className="tokeninput"
            type="text"
            placeholder="My Team"
            value={workspaceName}
            onChange={(e) => setWorkspaceName(e.target.value)}
            spellCheck={false}
          />
          {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
          <button className="btn solid" disabled={busy} style={{ justifyContent: "center" }}>
            {busy ? "Creating…" : "Create account"}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function Signup() {
  return (
    <>
      <TopBar />
      <Suspense fallback={<main className="wrap"><div className="signin" /></main>}>
        <SignupForm />
      </Suspense>
    </>
  );
}
