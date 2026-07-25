import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-tools indicator overlays the brand avatar bottom-left — and a
  // screen recording of the dev server must look like the product, not a
  // debug session.
  devIndicators: false,
};

export default nextConfig;
