import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "public/gif.worker.js", // gif.js vendor bundle (postinstall 로 복사)
    "electron/**", // Electron 데스크톱 셸 — CommonJS(Node main 프로세스), Next 앱 lint 대상 아님
  ]),
]);

export default eslintConfig;
