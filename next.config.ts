import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Server Actions accept 1 MB by default. Deal documents go up to 15 MB
      // (document-actions.ts) and client POs up to 10 MB (order-proof-actions.ts);
      // the extra headroom is the multipart form around the file.
      bodySizeLimit: "16mb",
    },
  },
};

export default nextConfig;
