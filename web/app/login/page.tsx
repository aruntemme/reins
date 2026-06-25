"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, AuthError } from "@/lib/api";
import { TopBar } from "@/components/ui";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Resume an invite flow after login, and surface the reset-done note.
  const next = params.get("next") || "/dashboard";
  const justReset = params.get("reset") === "1";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // If auth is off, or already signed in, skip straight to the destination.
  useEffect(() => {
    api.me().then((m) => { if (!m.auth || m.workspace) router.replace(next); }).catch(() => {});
  }, [router, next]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!email.trim() || !password) { setErr("Enter your email and password."); return; }
    setBusy(true);
    try {
      await api.login(email.trim(), password);
      router.replace(next);
    } catch (e) {
      // 401 from the API surfaces as AuthError; treat it as bad credentials here
      // rather than bouncing, since we are already on the login page.
      if (e instanceof AuthError) setErr("That email and password did not match. Check them and try again.");
      else setErr("Could not log in right now. Please try again.");
      setBusy(false);
    }
  };

  const signupHref = next === "/dashboard" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`;

  return (
    <main className="wrap">
      <div className="signin">
        <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> log in</div>
        <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Welcome back.</h1>
        <p className="sub" style={{ maxWidth: 480, marginBottom: 24 }}>
          Log in to your account to open your workspaces. New here?{" "}
          <Link href={signupHref} className="hl" style={{ color: "var(--ink)" }}>Create an account</Link>.
        </p>

        {justReset && (
          <div className="signin-note" style={{ marginBottom: 18 }}>
            <b>Password updated.</b> Log in with your new password below.
          </div>
        )}

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
          <label className="mono muted" style={{ fontSize: 11.5 }}>password</label>
          <input
            className="tokeninput"
            type="password"
            placeholder="your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
          {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
          <button className="btn solid" disabled={busy} style={{ justifyContent: "center" }}>
            {busy ? "Logging in…" : "Log in"}
          </button>
        </form>

        <div className="mono muted" style={{ marginTop: 14, fontSize: 11.5, maxWidth: 520 }}>
          Forgot your password? There is no email reset yet. Ask a workspace admin to send you a
          reset link, then open it to set a new password.
        </div>
        <div className="mono muted" style={{ marginTop: 10, fontSize: 11.5, maxWidth: 520 }}>
          Have an access or agent token instead?{" "}
          <Link href="/signin" className="hl" style={{ color: "var(--ink)" }}>Use token sign in</Link>.
        </div>
      </div>
    </main>
  );
}

export default function Login() {
  return (
    <>
      <TopBar />
      <Suspense fallback={<main className="wrap"><div className="signin" /></main>}>
        <LoginForm />
      </Suspense>
    </>
  );
}
