"use client";
import { useState } from "react";

function CopyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2.5" />
      <path d="M5 15V6a2.5 2.5 0 0 1 2.5-2.5H15" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12.5l4.5 4.5L19 7" />
    </svg>
  );
}

/** A terminal-style command that copies to the clipboard on click, with feedback. */
export function CopyCommand({ text, block }: { text: string; block?: boolean }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <button
      type="button"
      className={`installcmd copycmd${block ? " block" : ""}${copied ? " copied" : ""}`}
      onClick={copy}
      aria-label={copied ? "Copied to clipboard" : `Copy command: ${text}`}
    >
      <span className="cc-text">{text}</span>
      <span className="cc-ic" aria-hidden="true">{copied ? <CheckIcon /> : <CopyIcon />}</span>
    </button>
  );
}
