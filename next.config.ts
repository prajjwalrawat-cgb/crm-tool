import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf.js (inside unpdf, which reads client POs) loads its own modules at
  // runtime; let Node require it as-is rather than bundling it.
  // @react-pdf/renderer (quote PDFs) is ESM with Node-only font loading;
  // also on Next's built-in external list, listed here to make it explicit.
  serverExternalPackages: ["unpdf", "@react-pdf/renderer"],
  // The server quote render (mark as sent) reads its TTFs from
  // <cwd>/public/fonts/quote at runtime (src/lib/quotes/pdf/fonts.ts), which
  // file tracing can't see. Server actions run in the invoking page's
  // function, so include the fonts in every route's trace.
  outputFileTracingIncludes: {
    "/*": ["./public/fonts/quote/**/*.ttf"],
  },
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
