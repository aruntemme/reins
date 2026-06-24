/** @type {import('next').NextConfig} */
const REINS_URL = process.env.REINS_URL || "http://localhost:4319";

const nextConfig = {
  // Proxy API + SSE to the Reins server so the browser talks same-origin.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${REINS_URL}/api/:path*` }];
  },
};

export default nextConfig;
