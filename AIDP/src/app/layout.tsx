import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import { MotionProvider } from "@/components/ui/MotionProvider";
import "./globals.css";

// Inter Tight carries headings: narrower apertures and tighter default
// spacing than Inter, so it stays sharp at display sizes and at the lighter
// weights this design leans on. Inter carries body copy — same skeleton, so
// the pairing reads as one family rather than two typefaces.
const interTight = Inter_Tight({
  variable: "--font-display-face",
  subsets: ["latin"],
  display: "swap",
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://dexter.example.com"),
  title: {
    default: "Dexter — AI-Native Enterprise Architecture Governance",
    template: "%s · Dexter",
  },
  description:
    "Dexter turns a six-to-eight week manual architecture review into a three-to-five day automated one. Every finding cites a principle. Every agent step is logged.",
  openGraph: {
    title: "Dexter — AI-Native Enterprise Architecture Governance",
    description:
      "Automated architecture assessment grounded in your own principles, standards, and past decisions.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#faf9f7",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${interTight.variable} ${inter.variable} h-full antialiased`}
    >
      <body className="grain min-h-full bg-canvas font-sans text-ink">
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
