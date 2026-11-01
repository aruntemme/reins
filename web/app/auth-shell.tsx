import Link from "next/link";
import { Mark } from "@/components/ui";
import "./auth.css";

/** Split layout shared by the account pages: form column on white, fluted sky panel on the right. */
export function AuthShell({
  eyebrow,
  title,
  lede,
  panel,
  children,
}: {
  eyebrow: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  panel?: { title: string; text: string };
  children?: React.ReactNode;
}) {
  const p = panel ?? { title: "Every agent, on the same page.", text: "Reins turns what each teammate's coding agent is doing into live team context, before two of them collide." };
  return (
    <div className="au">
      <div className="au-main">
        <header className="au-head">
          <Link href="/" className="au-brand"><Mark />reins</Link>
        </header>
        <main className="au-body">
          <div className="au-col">
            <p className="rz-eyebrow au-eyebrow">{eyebrow}</p>
            <h1 className="au-title">{title}</h1>
            {lede && <p className="au-lede">{lede}</p>}
            {children}
          </div>
        </main>
        <footer className="au-foot">
          <Link href="/privacy">Privacy</Link>
          <Link href="/">Home</Link>
        </footer>
      </div>
      <aside className="au-panel rz-field" aria-hidden="true">
        <div className="au-panel-rings"><span /><span /><span /><span /></div>
        <div className="au-panel-mark rz-glass"><Mark tone="plain" size={40} /></div>
        <div className="au-panel-copy">
          <p className="rz-eyebrow">Live context for agent teams</p>
          <h2>{p.title}</h2>
          <p>{p.text}</p>
        </div>
      </aside>
    </div>
  );
}

/** A labelled input row. Extra props pass through to the <input>. */
export function Field({
  id,
  label,
  hint,
  mono,
  ...input
}: { id: string; label: string; hint?: string; mono?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="au-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className={`au-input${mono ? " mono" : ""}`} aria-describedby={hint ? `${id}-hint` : undefined} {...input} />
      {hint && <span id={`${id}-hint`} className="au-hint">{hint}</span>}
    </div>
  );
}

export function FormError({ children }: { children: React.ReactNode }) {
  return <p className="au-err" role="alert">{children}</p>;
}
