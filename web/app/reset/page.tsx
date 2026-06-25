"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { TopBar } from "@/components/ui";

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
    <main className="wrap">
      <div className="signin">
        <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> reset password</div>
        <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Set a new password.</h1>
        <p className="sub" style={{ maxWidth: 480, marginBottom: 24 }}>
          Choose a new password for your account. After this you can log in with it.
        </p>

        <form onSubmit={submit} className="card pad" style={{ display: "grid", gap: 14, maxWidth: 520 }}>
          <label className="mono muted" style={{ fontSize: 11.5 }}>new password (at least {MIN_PASSWORD} characters)</label>
          <input
            className="tokeninput"
            type="password"
            placeholder="a strong password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <label className="mono muted" style={{ fontSize: 11.5 }}>confirm new password</label>
          <input
            className="tokeninput"
            type="password"
            placeholder="repeat your password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
          />
          {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
          <button className="btn solid" disabled={busy} style={{ justifyContent: "center" }}>
            {busy ? "Saving…" : "Set new password"}
          </button>
        </form>

        <div className="mono muted" style={{ marginTop: 14, fontSize: 11.5 }}>
          Back to <Link href="/login" className="hl" style={{ color: "var(--ink)" }}>log in</Link>.
        </div>
      </div>
    </main>
  );
}

export default function Reset() {
  return (
    <>
      <TopBar />
      <Suspense fallback={<main className="wrap"><div className="signin" /></main>}>
        <ResetForm />
      </Suspense>
    </>
  );
}
