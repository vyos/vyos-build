import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "QuartzFire",
  description: "QuartzFire firewall management",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, sans-serif",
          background: "#0b1220",
          color: "#e5e9f0",
        }}
      >
        {children}
      </body>
    </html>
  );
}
