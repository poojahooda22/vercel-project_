import path from "path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Emits .next/standalone — a self-contained server with only the files actually
  // imported, instead of requiring the whole node_modules in the image. Without it
  // the frontend image goes from roughly 200MB to over a gigabyte.
  // In a monorepo Next also needs outputFileTracingRoot, or it traces from this
  // app folder and misses the hoisted dependencies at the workspace root.
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../../"),
  devIndicators: {
    // Defaults to bottom-left, where it covers the collapsed sidebar's avatar
    // button and swallows the click that opens the account menu.
    position: "bottom-right",
  },
};

export default nextConfig;
