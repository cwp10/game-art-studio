/**
 * Phase 2 실생성 QA 하네스 — 실제 MCP make_spritesheet 핸들러를 stdio 로 호출한다.
 *
 *   node scripts/qa-mcp-spritesheet.mjs "<prompt>" <rows> <cols> [subjectType] [directions]
 *
 * scripts/gen.ts 는 ImageBackend 를 직접 호출해 effectGuard/decorated 빌더를
 * 우회한다. 이 하네스는 진짜 MCP 서버를 spawn 해 핸들러의 decorated 프롬프트(가드 포함)와
 * 후처리 전체를 그대로 태운다 → Phase 2 의 유일한 충실한 실생성 검증.
 *
 * 출력: generationId 와 최종 PNG 경로. 그 PNG 를 Read 로 육안 확인한다.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";

const [, , prompt, rowsStr, colsStr, subjectType, directionsStr] = process.argv;
if (!prompt) {
  console.error('usage: node scripts/qa-mcp-spritesheet.mjs "<prompt>" <rows> <cols> [subjectType] [directions]');
  process.exit(2);
}
const rows = Number(rowsStr ?? 2);
const cols = Number(colsStr ?? 2);
const directions = directionsStr ? Number(directionsStr) : undefined;

const transport = new StdioClientTransport({
  command: "node",
  args: ["--import", "tsx", "src/lib/mcp/server.ts"],
  cwd: process.cwd(),
  env: process.env,
});
const client = new Client({ name: "phase2-qa", version: "1.0.0" }, { capabilities: {} });

const args = { prompt, rows, cols, seamlessLoop: true };
if (subjectType) args.subjectType = subjectType;
if (directions) args.directions = directions;

console.log(`[qa] calling make_spritesheet prompt="${prompt}" ${cols}x${rows} subjectType=${subjectType ?? "(infer)"} directions=${directions ?? "(none)"}`);
const t0 = Date.now();
try {
  await client.connect(transport);
  // 스프라이트시트 생성은 codex exec 으로 5-10분 소요 → 기본 60s RPC 타임아웃 상향.
  const res = await client.callTool(
    { name: "make_spritesheet", arguments: args },
    undefined,
    { timeout: 900000, resetTimeoutOnProgress: true },
  );
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  const genId = res?.structuredContent?.generationId;
  console.log(`[qa] DONE in ${dt}s  generationId=${genId}`);
  console.log(`[qa] structuredContent=${JSON.stringify(res?.structuredContent)}`);
  if (genId) {
    console.log(`[qa] PNG=${path.resolve("data/images", genId + ".png")}`);
  } else {
    console.log(`[qa] no generationId — content=${JSON.stringify(res?.content)}`);
  }
} catch (e) {
  console.error(`[qa] FAILED: ${e?.message ?? e}`);
  process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
}
