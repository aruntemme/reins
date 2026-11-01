import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// One family carries body and display: weight does the hierarchy (300 for big
// headlines, 400/500 for UI), Geist Mono for everything an agent reads or types.
const geist = Geist({ subsets: ["latin"], variable: "--font-body", display: "swap" });
const mono = Geist_Mono({
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
    <html lang="en" className={`${geist.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
