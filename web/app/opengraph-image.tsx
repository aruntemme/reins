import { ImageResponse } from "next/og";

// Social card for the landing page (and the default for any route without its own).
export const alt = "Reins: two agents, one picture of the work.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const FLUTE =
  "repeating-linear-gradient(90deg, rgba(255,255,255,0.20) 0px, rgba(255,255,255,0.03) 6px, rgba(0,30,60,0.12) 14px, rgba(255,255,255,0.20) 17px)";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", position: "relative", background: "#0593C6", color: "#FCFFFF" }}>
        <div
          style={{
            position: "absolute", left: 300, top: -300, width: 1200, height: 1200, display: "flex",
            backgroundImage: "radial-gradient(circle, rgba(216,57,149,0.9) 0%, rgba(216,57,149,0.45) 22%, rgba(216,57,149,0) 48%)",
          }}
        />
        <div
          style={{
            position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex",
            background: "linear-gradient(180deg, rgba(10,44,82,0) 45%, rgba(10,44,82,0.45) 100%)",
          }}
        />
        <div style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex", backgroundImage: FLUTE }} />
        <div
          style={{
            position: "relative", width: "100%", height: "100%", display: "flex", flexDirection: "column",
            justifyContent: "space-between", padding: "72px 80px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 38, fontWeight: 500, letterSpacing: -0.5 }}>
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="#FCFFFF" strokeWidth="1.8" strokeLinecap="round">
              <path d="M5 15a4 4 0 0 1 0-8h3" />
              <path d="M19 9a4 4 0 0 1 0 8h-3" />
              <path d="M8 12h8" />
            </svg>
            reins
          </div>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 84, lineHeight: 1, letterSpacing: -3.5 }}>
            <span>Two agents.</span>
            <span>One picture of the work.</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 26 }}>
            <span>Live intent for teams of humans and agents</span>
            <span style={{ display: "flex", background: "#0B2540", color: "#FCFFFF", padding: "14px 24px", borderRadius: 16, fontSize: 24 }}>
              <span style={{ color: "#5CC8F0", marginRight: 12 }}>$</span>npx reins-hook install
            </span>
          </div>
        </div>
      </div>
    ),
    size
  );
}
