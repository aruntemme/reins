"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { AuthShell, Field, FormError } from "../auth-shell";

const MIN_PASSWORD = 10;

function ResetForm() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("code") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (!code) { setErr("This reset link is missing its code."); return; }
    if (password.length < MIN_PASSWORD) { setErr(`Password must be at least ${MIN_PASSWORD} characters.`); return; }
    if (password !== confirm) { setErr("Passwords do not match."); return; }
    setBusy(true);
    try {
      await api.resetPassword(code, password);
      // Carry a success note to /login so the user knows it worked.
      router.replace("/login?reset=1");
    } catch {
      setErr("That reset link is invalid or expired. Ask an admin for a fresh link.");
      setBusy(false);
    }
  };

  return (
    <AuthShell
      eyebrow="Reset password"
      title="Set a new password."
      lede="Choose a new password for your account. After this you can log in with it."
    >
      <form onSubmit={submit} className="au-form" noValidate>
        <Field id="password" label="New password" hint={`At least ${MIN_PASSWORD} characters.`} type="password" placeholder="A strong password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        <Field id="confirm" label="Confirm new password" type="password" placeholder="Repeat your password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        {err && <FormError>{err}</FormError>}
        <button className="rz-btn primary" disabled={busy}>{busy ? "Saving…" : "Set new password"}</button>
      </form>
      <p className="au-sub">Back to <Link href="/login" className="au-link">log in</Link>.</p>
    </AuthShell>
  );
}

export default function Reset() {
  return (
    <Suspense fallback={null}>
      <ResetForm />
    </Suspense>
  );
}
