import type { Metadata } from "next";
import { Inter, Inter_Tight, JetBrains_Mono, EB_Garamond } from "next/font/google";
import "./globals.css";

const body = Inter({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const display = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-display",
  weight: ["500", "600", "700"],
  display: "swap",
});
const serif = EB_Garamond({
  subsets: ["latin"],
  variable: "--font-serif",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500"],
  display: "swap",
});

export const metadata: Metadata = {
  // Resolves the relative OG image and canonical URLs to absolute ones.
  metadataBase: new URL("https://reinshq.vercel.app"),
  title: "Reins: live intent for teams of humans and agents",
  description:
    "Reins turns what every teammate's coding agent is doing into live team intent, and feeds it back into every agent before work collides.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${body.variable} ${display.variable} ${serif.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
