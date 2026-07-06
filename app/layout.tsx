import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { GlobalSearch } from "@/components/layout/global-search";
import { AgentStatus } from "@/components/layout/agent-status";

// Self-hosted fonts exposed as CSS variables consumed by globals.css
// (--font-sans / --font-mono), matching the Inter / JetBrains Mono stack
// declared in tailwind.config.ts.
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "AuthPilot",
  description:
    "Autonomous prior-authorization and denial-appeal coordinator with a full audit trail.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-background text-foreground antialiased">
        <div className="flex h-screen overflow-hidden">
          <Sidebar />
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-border bg-card px-6">
              <GlobalSearch />
              <AgentStatus />
            </header>
            <main className="flex-1 overflow-y-auto">{children}</main>
          </div>
        </div>
      </body>
    </html>
  );
}
