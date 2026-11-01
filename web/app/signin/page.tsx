"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { CopyCommand } from "@/components/copy-command";
import { AuthShell, Field, FormError } from "../auth-shell";

const GITHUB = "https://github.com/aruntemme/reins";
// Access token for the public *demo* workspace (id 880523e5) — its own isolated
// tenant with only the sample atlas/nimbus boards, so "Try the demo" never exposes
// a real workspace. Public by design (it ships in client JS).
const DEMO_TOKEN = "rk_access_4a3dd7fa7a48a1fb3c3dfdc1719bc864dfbdb171512aaea5";

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

  // If auth is off or already signed in, skip straight to the board. With
  // ?demo=1 (the landing "Try the demo" CTA), enter the demo workspace in one click.
  useEffect(() => {
    const demo = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("demo") === "1";
    api.me()
      .then((m) => {
        if (!m.auth || m.workspace) { router.replace("/dashboard"); return; }
        if (demo) enter(DEMO_TOKEN);
      })
      .catch(() => { if (demo) enter(DEMO_TOKEN); });
    // enter is stable enough for this one-shot mount effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]);

  const submit = (e: React.FormEvent) => { e.preventDefault(); enter(token); };

  return (
    <AuthShell
      eyebrow="Token sign in"
      title="Enter your workspace."
      lede={<>Reins is multi-tenant: each team runs in its own isolated workspace. Already have an <b>access token</b> (an <code>rk_access_…</code>)? Paste it below. It&rsquo;s exchanged for a secure session; nothing is stored in the browser.</>}
      panel={{ title: "One workspace per team.", text: "Tokens keep each team's board isolated. Accounts with a password are the easier way in." }}
    >
      <p className="au-note">
        <b>Have an account?</b> This page is for pasting an access or agent token. To log in with your email and password, use{" "}
        <Link href="/login" className="au-link">Log in</Link> or <Link href="/signup" className="au-link">Sign up</Link>.
      </p>

      <form onSubmit={submit} className="au-form" noValidate>
        <Field id="token" mono label="Access token" placeholder="rk_access_…" value={token} onChange={(e) => setToken(e.target.value)} spellCheck={false} autoComplete="off" />
        {err && <FormError>{err}</FormError>}
        <button className="rz-btn primary" disabled={busy || !token.trim()}>{busy ? "Checking…" : "Enter workspace"}</button>
      </form>

      <div className="au-sep">or</div>
      <button type="button" className="rz-btn ghost" disabled={busy} onClick={() => enter(DEMO_TOKEN)}>
        {busy ? "Opening…" : "Try the demo workspace"}
      </button>
      <p className="au-sub" style={{ marginTop: 0 }}>
        This is a public demo instance. The demo opens a sample board (Atlas &amp; Nimbus): no sign-up, nothing stored.
        To use Reins with your own team, self-host it.
      </p>

      <section className="au-selfhost" aria-labelledby="selfhost-h">
        <p className="rz-eyebrow">Run it for your team · 4 steps</p>
        <h2 id="selfhost-h">Self-host Reins.</h2>
        <p className="au-lede">
          Reins is open source and multi-tenant. Clone the repo, run the server, create your own workspace (which mints your tokens),
          point your agent at it, then sign in above with the access token.
        </p>
        <ol className="au-steps">
          <li className="au-step">
            <span className="au-step-n">1</span>
            <div className="au-step-b">
              <h3 className="au-step-t">Run the server + dashboard</h3>
              <p>Clone, install, and start it locally (server on :4319, dashboard on :4320).</p>
              <CopyCommand block text="git clone https://github.com/aruntemme/reins && cd reins && npm run install:all && npm run dev" />
            </div>
          </li>
          <li className="au-step">
            <span className="au-step-n">2</span>
            <div className="au-step-b">
              <h3 className="au-step-t">Create a workspace</h3>
              <p>This mints your <b>ingest</b>, <b>access</b>, and <b>admin</b> tokens, shown once, so copy them.</p>
              <CopyCommand block text={'npm run admin -- create-workspace "My Team"'} />
            </div>
          </li>
          <li className="au-step">
            <span className="au-step-n">3</span>
            <div className="au-step-b">
              <h3 className="au-step-t">Connect your agent</h3>
              <p>Install the capture hook with your <b>ingest</b> token, then run <code>/hooks</code> in Claude Code to approve it.</p>
              <CopyCommand block text="npx reins-hook install --url http://localhost:4319 --me you --token rk_ingest_…" />
            </div>
          </li>
          <li className="au-step">
            <span className="au-step-n">4</span>
            <div className="au-step-b">
              <h3 className="au-step-t">Open the board</h3>
              <p>Just work as usual. Paste your <b>access</b> token above to watch the team&rsquo;s status, pending work, and handoffs update live.</p>
            </div>
          </li>
        </ol>
        <p className="au-sub">
          Deploying for a team? See the full guide in the{" "}
          <a href={`${GITHUB}#readme`} target="_blank" rel="noreferrer" className="au-link">README</a>.
        </p>
      </section>
    </AuthShell>
  );
}
