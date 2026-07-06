import type { Metadata } from "next";
import "./globals.css";

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
    <html lang="en">
      <body className="min-h-screen bg-background font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
