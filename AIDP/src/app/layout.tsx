import type { Metadata, Viewport } from "next";
import { Inter, Inter_Tight } from "next/font/google";
import { MotionProvider } from "@/components/ui/MotionProvider";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
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
  metadataBase: new URL("https://aidp.example.com"),
  title: {
    default: "AIDP — AI-Native Enterprise Architecture Governance",
    template: "%s · AIDP",
  },
  description:
    "AIDP turns a six-to-eight week manual architecture review into a three-to-five day automated one. Every finding cites a principle. Every agent step is logged.",
  openGraph: {
    title: "AIDP — AI-Native Enterprise Architecture Governance",
    description:
      "Automated architecture assessment grounded in your own principles, standards, and past decisions.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#e2f5ff",
  // The marketing surface is light and the product interior is the person's
  // choice, so the document as a whole can be either. Declaring `light` here
  // left the browser rendering scrollbars and native controls for a light
  // page over the dark app.
  colorScheme: "light dark",
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
        {/* Before anything paints: reads the stored theme and puts it on
            <html>. It is blocking and it runs ahead of the markup below on
            purpose — the alternative is doing it in React, which happens one
            paint too late and shows a white flash to everyone who chose dark.
            See src/lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
