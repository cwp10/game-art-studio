import { build } from "esbuild";
import { resolve } from "path";
import { fileURLToPath } from "url";

const root = resolve(fileURLToPath(import.meta.url), "../..");

await build({
  entryPoints: [resolve(root, "src/lib/mcp/server.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: resolve(root, ".next/mcp-server.js"),
  external: ["better-sqlite3", "sharp"],
  format: "cjs",
});

console.log("MCP server compiled → .next/mcp-server.js");
