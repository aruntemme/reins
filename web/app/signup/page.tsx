"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api, ApiError } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { useMounted } from "@/lib/useMounted";
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
      // No tokens to copy: each teammate's terminal is approved in the browser by
      // `npx reins-hook`. A fresh owner goes straight to creating their first project;
      // next is otherwise a same-origin path (e.g. /join?code=...) that resolves an invite.
      router.replace(next === "/dashboard" ? "/dashboard?welcome=1" : next);
    } catch (e) {
      // The signup endpoint returns 409 when the email is already registered.
      if (e instanceof ApiError && e.status === 409) setErr("That email is already registered. Try logging in instead.");
      else if (e instanceof ApiError) setErr(`Could not create your account: ${e.message}.`);
      else setErr("Could not create your account right now. Please try again.");
      setBusy(false);
    }
  };

  // Carries ?next= only once mounted: the server render has no query to read.
  const mounted = useMounted();
  const loginHref = !mounted || next === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
  const joining = mounted && next.startsWith("/join");

  return (
    <AuthShell
      eyebrow="Sign up"
      title="Create your account."
      lede={joining
        ? <>Create your account and you&rsquo;ll join the workspace you were invited to, then connect your agent with one command. Already have an account? <Link href={loginHref} className="au-link">Log in</Link>.</>
        : <>One account, one workspace to start. You become its owner; next you create a project and connect your agent with one command. Already have an account? <Link href={loginHref} className="au-link">Log in</Link>.</>}
    >
      <form onSubmit={submit} className="au-form" noValidate>
        <Field id="email" label="Email" type="email" placeholder="you@team.com" value={email} onChange={(e) => setEmail(e.target.value)} spellCheck={false} autoComplete="email" />
        <Field id="password" label="Password" hint={`At least ${MIN_PASSWORD} characters.`} type="password" placeholder="A strong password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <Field id="confirm" label="Confirm password" type="password" placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {/* Joining an invite: the account lands in the inviter's workspace, so don't ask to name one. */}
        {!joining && (
          <Field id="workspace" label="Workspace name (optional)" type="text" placeholder="My Team" value={workspaceName} onChange={(e) => setWorkspaceName(e.target.value)} spellCheck={false} autoComplete="organization" />
        )}
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
