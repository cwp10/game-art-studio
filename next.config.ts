import type { NextConfig } from "next";
import path from "node:path";

// Bake the data directory at build time so server routes don't call process.cwd()
// (which causes Turbopack's file tracer to pull in next.config.ts unintentionally).
// Override at build time by setting IMAGEGEN_DATA_DIR before running pnpm build.
const nextConfig: NextConfig = {
  env: {
    NEXT_IMAGEGEN_DATA_DIR:
      process.env.IMAGEGEN_DATA_DIR ?? path.join(process.cwd(), "data"),
  },
  // 네이티브 모듈을 webpack 외부화 → .next/node_modules/ 해시 폴더 생성 방지
  serverExternalPackages: ["better-sqlite3", "sharp"],
};

export default nextConfig;
