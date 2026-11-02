"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { safeNext } from "@/lib/guard";
import { AuthShell } from "../auth-shell";

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
  // Where to land after joining (e.g. a project's connect page): same-origin paths only.
  const next = safeNext(params.get("next"));
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
          const joined = await api.joinWorkspace(code);
          // Joining only adds the membership; point the session at the new
          // workspace so the dashboard opens there, not in the previous one. The
          // join already succeeded (and consumed the invite), so a failed switch
          // must not report the invite as broken: the account menu can switch.
          await api.switchWorkspace(joined.workspace.id).catch(() => {});
          if (!cancelled) router.replace(next);
        } else {
          setState({ phase: "needAuth", workspace: preview.workspace, role: preview.role, code });
        }
      } catch {
        if (!cancelled) setState({ phase: "error", message: "Could not load this invite right now. Please try again." });
      }
    })();
    return () => { cancelled = true; };
  }, [code, next, router]);

  // Both signup and login resume the join by sending the user back here after auth.
  // The destination rides along so it survives the detour through signup or login.
  const nextPath = `/join?code=${encodeURIComponent(code)}${next === "/dashboard" ? "" : `&next=${encodeURIComponent(next)}`}`;
  const signupHref = `/signup?next=${encodeURIComponent(nextPath)}`;
  const loginHref = `/login?next=${encodeURIComponent(nextPath)}`;

  if (state.phase === "needAuth") {
    return (
      <AuthShell
        eyebrow="Join workspace"
        title={<>You are invited to {state.workspace}.</>}
        lede={<>You will join as <b>{state.role}</b>. Create an account or log in to accept, and we will complete the join for you.</>}
        panel={{ title: "Your team is already here.", text: "Join the workspace and your agent starts sharing context with theirs." }}
      >
        <div className="au-actions">
          <Link href={signupHref} className="rz-btn primary">Create an account and join</Link>
          <Link href={loginHref} className="rz-btn ghost">I already have an account</Link>
        </div>
      </AuthShell>
    );
  }

  if (state.phase === "joining") {
    return (
      <AuthShell eyebrow="Join workspace" title={<>Joining {state.workspace}…</>} lede={`Adding you as ${state.role}. One moment.`} />
    );
  }

  if (state.phase === "invalid" || state.phase === "error") {
    return (
      <AuthShell eyebrow="Join workspace" title="Invite unavailable." lede={state.message}>
        <div className="au-actions">
          <Link href="/login" className="rz-btn ghost">Log in</Link>
        </div>
      </AuthShell>
    );
  }

  return <AuthShell eyebrow="Join workspace" title="Checking your invite…" />;
}

export default function Join() {
  return (
    <Suspense fallback={null}>
      <JoinFlow />
    </Suspense>
  );
}
