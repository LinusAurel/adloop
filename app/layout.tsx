import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { AdminKeyBridge } from "@/components/admin-key-bridge";

// Geist is a quiet product grotesque with true tabular figures: it recedes at
// small sizes and holds up when set large on a projector (DESIGN.md).
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
  display: "swap",
});

// Only for measured values in the log, where the column must not shift.
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "adloop — Mission Control",
  description: "Agentic paid-ads engine",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // The font variables must sit on <html>: base styles apply font-sans there,
    // and a custom property set lower down would never reach that declaration.
    <html
      lang="de"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
    >
      <body>
        <AdminKeyBridge />
        {children}
      </body>
    </html>
  );
}
