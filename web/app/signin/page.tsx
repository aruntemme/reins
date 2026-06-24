"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { TopBar } from "@/components/ui";

export default function SignIn() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  // If auth is off, or already signed in, skip straight to the board.
  useEffect(() => {
    api.me().then((m) => { if (!m.auth || m.workspace) router.replace("/dashboard"); }).catch(() => {});
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      await api.signin(token.trim());
      router.replace("/dashboard");
    } catch {
      setErr("That token wasn’t accepted. Check it’s an access token for your workspace.");
      setBusy(false);
    }
  };

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="signin">
          <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> sign in</div>
          <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Enter your workspace.</h1>
          <p className="sub" style={{ maxWidth: 460, marginBottom: 28 }}>
            Paste your <b>access token</b> (the <code>rk_access_…</code> your admin gave you).
            It’s exchanged for a secure session. Nothing is stored in the browser.
          </p>
          <form onSubmit={submit} className="card pad" style={{ display: "grid", gap: 14, maxWidth: 520 }}>
            <input
              className="tokeninput"
              placeholder="rk_access_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoFocus
              spellCheck={false}
            />
            {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
            <button className="btn solid" disabled={busy || !token.trim()} style={{ justifyContent: "center" }}>
              {busy ? "Checking…" : "Enter workspace"}
            </button>
          </form>
          <p className="mono" style={{ marginTop: 18, color: "var(--ink-3)" }}>
            No token? Your admin mints one with <code>npm run admin -- mint &lt;workspace&gt; access</code>
          </p>
        </div>
      </main>
    </>
  );
}
