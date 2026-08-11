import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: {
    // Defaults to bottom-left, where it covers the collapsed sidebar's avatar
    // button and swallows the click that opens the account menu.
    position: "bottom-right",
  },
};

export default nextConfig;
