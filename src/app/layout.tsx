import type { Metadata } from "next";
import { Figtree, Fraunces } from "next/font/google";
import "./globals.css";

const body = Figtree({
  subsets: ["latin"],
  variable: "--font-figtree",
});

const display = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
});

export const metadata: Metadata = {
  title: "Gist Creative Intelligence",
  description:
    "Read-only Meta creative performance with Adjust D1/D3/D7 retention.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body
        className={`${body.variable} ${display.variable} antialiased`}
        style={
          {
            "--font-body": "var(--font-figtree), system-ui, sans-serif",
            "--font-display": "var(--font-fraunces), Georgia, serif",
          } as React.CSSProperties
        }
      >
        {children}
      </body>
    </html>
  );
}
