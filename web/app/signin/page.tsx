"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { TopBar } from "@/components/ui";
import { CopyCommand } from "@/components/copy-command";

const GITHUB = "https://github.com/aruntemme/reins";
// Read-only-ish access token for the public demo workspace, so anyone can look around.
const DEMO_TOKEN = "rk_access_417e294368663099cbae2471fedbf1bccdc96525a18c752d";

export default function SignIn() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const enter = async (t: string) => {
    setErr(""); setBusy(true);
    try {
      await api.signin(t.trim());
      router.replace("/dashboard");
    } catch {
      setErr("That token wasn’t accepted. Check it’s an access token for your workspace.");
      setBusy(false);
    }
  };

  // If auth is off, or already signed in, skip straight to the board.
  useEffect(() => {
    api.me().then((m) => { if (!m.auth || m.workspace) router.replace("/dashboard"); }).catch(() => {});
  }, [router]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); enter(token); };

  return (
    <>
      <TopBar />
      <main className="wrap">
        <div className="signin">
          <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> token sign in</div>
          <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Enter your workspace.</h1>
          <p className="sub" style={{ maxWidth: 480, marginBottom: 16 }}>
            Reins is multi-tenant: each team runs in its own isolated workspace. Already have an
            <b> access token</b> (an <code>rk_access_…</code>) for one? Paste it below. It’s exchanged
            for a secure session; nothing is stored in the browser.
          </p>

          <div className="signin-note" style={{ marginBottom: 24 }}>
            <b>Have an account?</b> This page is for pasting an access or agent token. To log in with
            your email and password, use{" "}
            <Link href="/login" className="hl" style={{ color: "var(--ink)" }}>Log in</Link>{" "}
            or{" "}
            <Link href="/signup" className="hl" style={{ color: "var(--ink)" }}>Sign up</Link>.
          </div>

          <div className="signin-note">
            <b>This is a public demo instance.</b> Take a look around with the demo workspace below.
            To use Reins with your own team, self-host it (steps below) — your workspace, tokens, and
            data stay yours.
          </div>

          <button
            type="button"
            className="btn solid lg"
            disabled={busy}
            onClick={() => enter(DEMO_TOKEN)}
            style={{ marginTop: 20, justifyContent: "center", width: "100%", maxWidth: 520 }}
          >
            {busy ? "Opening…" : "Try the demo workspace"}
          </button>
          <div className="mono muted" style={{ marginTop: 8, fontSize: 11.5 }}>
            Opens a sample board (Atlas &amp; Nimbus). No sign-up, nothing stored.
          </div>

          <form onSubmit={submit} className="card pad" style={{ display: "grid", gap: 14, maxWidth: 520, marginTop: 22 }}>
            <div className="mono muted" style={{ fontSize: 11.5 }}>or paste your own access token</div>
            <input
              className="tokeninput"
              placeholder="rk_access_…"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              spellCheck={false}
            />
            {err && <div className="mono" style={{ color: "var(--blocked)" }}>{err}</div>}
            <button className="btn solid" disabled={busy || !token.trim()} style={{ justifyContent: "center" }}>
              {busy ? "Checking…" : "Enter workspace"}
            </button>
          </form>
        </div>

        {/* Onboarding: how to actually run Reins and get a token. */}
        <section className="setup-wrap">
          <div className="label" style={{ marginBottom: 14 }}><span className="sq" /> run it for your team — 4 steps</div>
          <h2 className="display" style={{ fontSize: 28, marginBottom: 8 }}>Self-host Reins.</h2>
          <p className="sub" style={{ maxWidth: 560, marginBottom: 26 }}>
            Reins is open source and multi-tenant. Clone the repo, run the server, create your own
            workspace (which mints your tokens), point your agent at it, then sign in above with the
            access token.
          </p>

          <ol className="setup">
            <li className="setupstep">
              <span className="setup-n">1</span>
              <div className="setup-body">
                <div className="setup-t">Run the server + dashboard</div>
                <p className="muted">Clone, install, and start it locally (server on :4319, dashboard on :4320).</p>
                <CopyCommand block text="git clone https://github.com/aruntemme/reins && cd reins && npm run install:all && npm run dev" />
              </div>
            </li>
            <li className="setupstep">
              <span className="setup-n">2</span>
              <div className="setup-body">
                <div className="setup-t">Create a workspace</div>
                <p className="muted">This mints your <b>ingest</b>, <b>access</b>, and <b>admin</b> tokens — shown once, so copy them.</p>
                <CopyCommand block text={'npm run admin -- create-workspace "My Team"'} />
              </div>
            </li>
            <li className="setupstep">
              <span className="setup-n">3</span>
              <div className="setup-body">
                <div className="setup-t">Connect your agent</div>
                <p className="muted">Install the capture hook into Claude Code with your <b>ingest</b> token, then run <code>/hooks</code> to approve it.</p>
                <CopyCommand block text="npx reins-hook install --url http://localhost:4319 --me you --token rk_ingest_…" />
              </div>
            </li>
            <li className="setupstep">
              <span className="setup-n">4</span>
              <div className="setup-body">
                <div className="setup-t">Open the board</div>
                <p className="muted">Just work as usual. Paste your <b>access</b> token in the box above to watch the team’s status, pending work, and handoffs update live.</p>
              </div>
            </li>
          </ol>

          <p className="mono" style={{ marginTop: 22, color: "var(--ink-3)" }}>
            Deploying for a team? See the full guide in the{" "}
            <a href={`${GITHUB}#readme`} target="_blank" rel="noreferrer" className="hl" style={{ color: "var(--ink)" }}>README</a>.
          </p>
        </section>
      </main>
    </>
  );
}
