import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans, Cinzel } from "next/font/google";
import { DemoModalProvider } from "@/components/site/DemoModalProvider";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

const jakarta = Plus_Jakarta_Sans({
  variable: "--font-jakarta",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const cinzel = Cinzel({
  variable: "--font-cinzel",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "DOCVEX — Intelligent Legal Workflows",
  description:
    "AI-powered legal workflows for modern law firms. Organize documents, automate administrative work, and simplify legal operations.",
  metadataBase: new URL("https://docvex.ro"),
  // Private preview — don't index until launch.
  robots: { index: false, follow: false, nocache: true },
  openGraph: {
    title: "DOCVEX — Intelligent Legal Workflows",
    description: "AI-powered legal workflows for modern law firms.",
    url: "https://docvex.ro",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${jakarta.variable} ${cinzel.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[var(--color-cream)] text-[var(--color-navy-900)]">
        <DemoModalProvider>{children}</DemoModalProvider>
      </body>
    </html>
  );
}
