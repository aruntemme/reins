import { ImageResponse } from "next/og";

// Social card for the landing page (and the default for any route without its own).
export const alt = "Reins: your agent knows what your teammate's agent is doing.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between",
          padding: "72px 80px", background: "#f4f0e6", color: "#19170f",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 36, fontWeight: 700, letterSpacing: -1 }}>
          <svg width="56" height="56" viewBox="0 0 32 32">
            <path d="M16 5C23 5 27 10 27 17C27 24 22 27 16 27C10 27 5 24 5 17C5 10 9 5 16 5Z" fill="#F0CD58" />
            <circle cx="13" cy="16" r="2" fill="#1b1a17" />
            <circle cx="21" cy="16" r="2" fill="#1b1a17" />
            <path d="M13 21C15 22.5 17 22.5 19 21" stroke="#1b1a17" strokeWidth="1.6" strokeLinecap="round" fill="none" />
          </svg>
          reins
        </div>
        <div style={{ display: "flex", fontSize: 76, lineHeight: 1.04, letterSpacing: -2.5, fontWeight: 600, maxWidth: 980 }}>
          Your agent knows what your teammate&rsquo;s agent is doing.
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 28, color: "#48433a" }}>
          <span>Live intent for teams of humans and agents</span>
          <span style={{ display: "flex", background: "#19170f", color: "#f4f0e6", padding: "12px 22px", borderRadius: 12, fontSize: 24 }}>
            npx reins-hook install
          </span>
        </div>
      </div>
    ),
    size
  );
}
