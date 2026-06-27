import Link from "next/link";
import type { Metadata } from "next";
import { TopBar } from "@/components/ui";

export const metadata: Metadata = {
  title: "Privacy · Reins",
  description: "What Reins records, how it's used, and the controls you have.",
};

export default function PrivacyPage() {
  return (
    <>
      <TopBar brandHref="/" hideLive />
      <main className="wrap">
        <article className="legal">
          <h1>Privacy</h1>
          <p className="legal-sub">Last updated 27 June 2026</p>

          <p>
            Reins keeps a team in sync on what their AI coding assistants are doing. This page explains
            what it records, how that information is used, and the controls you have.
          </p>

          <h2>What Reins records</h2>
          <p>
            When you connect Reins to your AI coding assistant, it receives the activity your assistant
            already produces as you work — the requests you make and the steps it takes — and uses it to
            keep your team&rsquo;s shared status current.
          </p>

          <h2>What your teammates see</h2>
          <p>
            Your teammates never see your raw conversations with your AI assistant. Reins turns that
            activity into short, high-level summaries — what you&rsquo;re working on, recent milestones,
            and a profile of how you like to work. The underlying raw text is used only to produce those
            summaries and is never shown in the interface.
          </p>

          <h2>Secrets are masked</h2>
          <p>
            Before anything is stored, Reins scans for credentials — API keys, tokens, private keys — and
            masks them, so a secret that appears in your activity never lands in the stored record or any
            summary.
          </p>

          <h2>Where your data lives</h2>
          <p>
            Your data is stored on the Reins instance your team runs, inside your team&rsquo;s workspace.
            Workspaces are isolated — one team cannot see another team&rsquo;s data. If your team has
            enabled decentralized backup, only the distilled summaries are included; raw text never is.
          </p>

          <h2>Your controls</h2>
          <ul>
            <li>Your working-style profile is yours — edit or remove any item in it at any time.</li>
            <li>You can clear handoffs and notifications directed at you, individually or in bulk.</li>
            <li>Removing your access removes your identity from the workspace.</li>
          </ul>

          <h2>What Reins does not do</h2>
          <p>
            Reins does not sell your data or use it for advertising. It exists for one purpose: keeping
            your team in sync.
          </p>

          <h2>Questions</h2>
          <p>
            For data requests or questions, reach the team that operates your Reins instance.
          </p>

          <p className="legal-back"><Link href="/" className="hl">‹ back home</Link></p>
        </article>
      </main>
      <footer className="foot">
        <div className="wrap">reins · <Link href="/">home</Link></div>
      </footer>
    </>
  );
}
