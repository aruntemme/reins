/** @type {import('next').NextConfig} */
const REINS_URL = process.env.REINS_URL || "http://localhost:4319";

const nextConfig = {
  // Proxy API + SSE (and the hook's /health probe) to the Reins server so the
  // browser and the installed hook can talk to this origin.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${REINS_URL}/api/:path*` },
      { source: "/health", destination: `${REINS_URL}/health` },
    ];
  },
};

export default nextConfig;
