"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError, AuthError } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { useMounted } from "@/lib/useMounted";
import { AuthShell, Field, FormError } from "../auth-shell";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  // Resume an invite flow or deep link after login (same-origin paths only), and
  // surface the reset-done note.
  const next = safeNext(params.get("next"));
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
      else if (e instanceof ApiError) setErr(`Could not log in: ${e.message}.`); // e.g. 429 lockout
      else setErr("Could not log in right now. Please try again.");
      setBusy(false);
    }
  };

  // Carries ?next= only once mounted: the server render has no query to read.
  const mounted = useMounted();
  const signupHref = !mounted || next === "/dashboard" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`;

  return (
    <AuthShell
      eyebrow="Log in"
      title="Welcome back."
      lede={<>Log in to open your workspaces. New here? <Link href={signupHref} className="au-link">Create an account</Link>.</>}
    >
      {justReset && <p className="au-note" role="status"><b>Password updated.</b> Log in with your new password below.</p>}

      <form onSubmit={submit} className="au-form" noValidate>
        <Field id="email" label="Email" type="email" placeholder="you@team.com" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} autoComplete="email" />
        <Field id="password" label="Password" type="password" placeholder="Your password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
        {err && <FormError>{err}</FormError>}
        <button className="rz-btn primary" disabled={busy}>{busy ? "Logging in…" : "Log in"}</button>
      </form>

      <p className="au-sub">
        Forgot your password? There is no email reset yet. Ask a workspace admin to send you a reset link, then open it to set a new password.
      </p>
      <p className="au-sub">
        Have an access or agent token instead? <Link href="/signin" className="au-link">Use token sign in</Link>.
      </p>
    </AuthShell>
  );
}

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
