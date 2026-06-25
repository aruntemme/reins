"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { TopBar } from "@/components/ui";

type State =
  | { phase: "loading" }
  | { phase: "invalid"; message: string }
  | { phase: "needAuth"; workspace: string; role: string; code: string }
  | { phase: "joining"; workspace: string; role: string }
  | { phase: "error"; message: string };

function JoinFlow() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params.get("code") || "";
  const [state, setState] = useState<State>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!code) {
        if (!cancelled) setState({ phase: "invalid", message: "This invite link is missing its code." });
        return;
      }
      try {
        const preview = await api.invitePreview(code);
        if (cancelled) return;
        if (!preview.valid) {
          setState({ phase: "invalid", message: "This invite is no longer valid. Ask for a fresh link." });
          return;
        }
        // Logged in? Join straight away. Otherwise route to auth carrying the code.
        const me = await api.me().catch(() => null);
        if (cancelled) return;
        if (me && me.user) {
          setState({ phase: "joining", workspace: preview.workspace, role: preview.role });
          await api.joinWorkspace(code);
          if (!cancelled) router.replace("/dashboard");
        } else {
          setState({ phase: "needAuth", workspace: preview.workspace, role: preview.role, code });
        }
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Could not load this invite right now. Please try again." });
      }
    })();
    return () => { cancelled = true; };
  }, [code, router]);

  // Both signup and login resume the join by sending the user back here after auth.
  const nextPath = `/join?code=${encodeURIComponent(code)}`;
  const signupHref = `/signup?next=${encodeURIComponent(nextPath)}`;
  const loginHref = `/login?next=${encodeURIComponent(nextPath)}`;

  return (
    <main className="wrap">
      <div className="signin">
        <div className="label" style={{ marginBottom: 18 }}><span className="sq blue" /> join workspace</div>

        {state.phase === "loading" && (
          <p className="sub" style={{ maxWidth: 480 }}>Checking your invite…</p>
        )}

        {state.phase === "joining" && (
          <>
            <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Joining {state.workspace}…</h1>
            <p className="sub" style={{ maxWidth: 480 }}>Adding you as {state.role}. One moment.</p>
          </>
        )}

        {state.phase === "needAuth" && (
          <>
            <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>You are invited to {state.workspace}.</h1>
            <p className="sub" style={{ maxWidth: 480, marginBottom: 24 }}>
              You will join as <b>{state.role}</b>. Create an account or log in to accept, and we will
              complete the join for you.
            </p>
            <div className="card pad" style={{ display: "grid", gap: 12, maxWidth: 520 }}>
              <Link href={signupHref} className="btn solid" style={{ justifyContent: "center" }}>
                Create an account and join
              </Link>
              <Link href={loginHref} className="btn" style={{ justifyContent: "center" }}>
                I already have an account
              </Link>
            </div>
          </>
        )}

        {(state.phase === "invalid" || state.phase === "error") && (
          <>
            <h1 className="display" style={{ fontSize: 40, marginBottom: 14 }}>Invite unavailable.</h1>
            <p className="sub" style={{ maxWidth: 480 }}>{state.message}</p>
          </>
        )}
      </div>
    </main>
  );
}

export default function Join() {
  return (
    <>
      <TopBar />
      <Suspense fallback={<main className="wrap"><div className="signin" /></main>}>
        <JoinFlow />
      </Suspense>
    </>
  );
}
