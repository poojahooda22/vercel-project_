import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Deploy",
  description: "Deploy a GitHub repo",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // data-theme="dark" is what activates the dark half of tokens.css.
    //
    // suppressHydrationWarning covers ONLY this element's own attributes — React's
    // docs call it an escape hatch that "only works one level deep" — so it cannot
    // mask a mismatch inside the app. It is here because things outside our control
    // rewrite <html> before React hydrates: browser extensions such as Dark Reader
    // add data-darkreader-* attributes, and any future pre-paint theme script would
    // set data-theme from localStorage. Without it, that noise buries real warnings.
    <html
      lang="en"
      data-theme="dark"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
