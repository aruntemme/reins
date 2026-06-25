"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { TopBar } from "@/components/ui";

const MIN_PASSWORD = 10;

function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  // After signup we honour ?next= so an invite flow (/join?code=...) can resume.
  const next = params.get("next") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

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
      await api.signup(email.trim(), password, workspaceName.trim() || undefined);
      // next is a same-origin path (e.g. /join?code=...) so it resolves the invite.
      router.replace(next);
    } catch (e) {
      // The signup endpoint returns 409 when the email is already registered;
      // j() turns non-2xx into an Error whose message starts with the status code.
      const msg = e instanceof Error ? e.message : "";
      if (msg.startsWith("409")) setErr("That email is already registered. Try logging in instead.");
      else setErr("Could not create your account right now. Please try again.");
      setBusy(false);
    }
  };

  const loginHref = next === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(next)}`;

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
