import type { NextConfig } from "next";
import path from "node:path";

const config: NextConfig = {
  // Self-contained server bundle for the Docker image.
  output: "standalone",
  // Workspace root, so the standalone trace includes hoisted node_modules.
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
};
export default config;
