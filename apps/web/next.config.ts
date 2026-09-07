import type { NextConfig } from "next";

// When `dev.sh` serves other devices (ONEMOTION_PUBLIC_HOST=<LAN ip>), the browser
// loads the app from that address. Next.js blocks cross-origin requests to its
// dev-only /_next/* runtime by default, which stops the page from hydrating —
// allow-list the LAN host(s) so the dev client works off-box. Dev-only setting.
const devOrigins = (process.env.ONEMOTION_DEV_ORIGINS ?? process.env.ONEMOTION_PUBLIC_HOST ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  output: "standalone",
  ...(devOrigins.length > 0 ? { allowedDevOrigins: devOrigins } : {}),
};

export default nextConfig;
