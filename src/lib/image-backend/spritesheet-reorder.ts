import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { claudeRunSimple } from "@/lib/cli/claude-cli";

type Logger = (msg: string) => void;
const noop: Logger = () => {};

/**
 * 보행 사이클 스프라이트시트 프레임을 Claude Vision으로 분석해 자연스러운 순서로 재배열.
 * 오류 시 원본 순서 유지(graceful fallback).
 */
export async function reorderSpritesheetFrames(
  filePath: string,
  rows: number,
  cols: number,
  log: Logger = noop,
): Promise<void> {
  const N = rows * cols;
  if (N <= 2) return; // 프레임 2개 이하면 재배열 무의미

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sprite-reorder-"));
  try {
    // 1. 시트 전체를 raw 로 읽고, 각 셀을 개별 PNG로 추출
    const { data, info } = await sharp(filePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const W = info.width;
    const H = info.height;
    const cellW = Math.floor(W / cols);
    const cellH = Math.floor(H / rows);
    const ch = 4;
    const src = data as Buffer;

    const framePaths: string[] = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const cellBuf = Buffer.alloc(cellW * cellH * ch);
        for (let y = 0; y < cellH; y++) {
          const srcRow = ((r * cellH + y) * W + c * cellW) * ch;
          const dstRow = y * cellW * ch;
          src.copy(cellBuf, dstRow, srcRow, srcRow + cellW * ch);
        }
        const fp = path.join(tmpDir, `frame_${idx}.png`);
        await sharp(cellBuf, { raw: { width: cellW, height: cellH, channels: ch } })
          .png()
          .toFile(fp);
        framePaths.push(fp);
      }
    }

    // 2. Claude에게 순서 분석 요청
    const frameList = framePaths.map((fp, i) => `Frame ${i}: ${fp}`).join("\n");
    const prompt =
      `You are analyzing sprite animation frames for a walk/run cycle.\n` +
      `Below are ${N} frame file paths (frames 0 to ${N - 1}).\n` +
      `Use the Read tool to view each frame image.\n` +
      `Then determine the correct order for a smooth, natural walk/run cycle ` +
      `where each frame transitions seamlessly to the next, and the last frame loops back into the first.\n` +
      `Return ONLY a JSON array of the frame indices in the correct order, e.g. [0,2,1,3]. No explanation.\n\n` +
      frameList;

    // 타임아웃: 중첩 claude 호출이 hang 하면 try/catch(에러만 잡음)로는 못 막아 make_spritesheet
    // 가 멈춘다 — graceful-fallback 계약을 지키려면 시간 상한이 필요. abort 시 claudeRunSimple 이
    // reject → 호출부(server.ts) try/catch 가 원본 유지.
    const response = await claudeRunSimple({
      systemPrompt: "You are a sprite animation expert. Analyze frame images and return JSON only.",
      userMessage: prompt,
      model: "haiku",
      allowedTools: ["Read"],
      signal: AbortSignal.timeout(90_000),
    });

    // 3. JSON 파싱
    const match = response.match(/\[[\d,\s]+\]/);
    if (!match) {
      log(`reorderSpritesheetFrames: no valid JSON array in response, keeping original order`);
      return;
    }
    const order: number[] = JSON.parse(match[0]);
    if (
      order.length !== N ||
      !order.every((i) => Number.isInteger(i) && i >= 0 && i < N) ||
      new Set(order).size !== N
    ) {
      log(`reorderSpritesheetFrames: invalid order ${JSON.stringify(order)}, keeping original`);
      return;
    }
    // 원본과 동일 순서면 스킵
    if (order.every((v, i) => v === i)) {
      log(`reorderSpritesheetFrames: already in optimal order`);
      return;
    }

    // 4. 재합성
    // 출력 캔버스는 정확 배수(cols·cellW × rows·cellH)로 만든다. 원본 W/H 가 cols/rows 의
    // 정확한 배수가 아니면 floor 로 생긴 우/하단 잔여 스트립이 outBuf 에서 투명으로 남는
    // #29-style residue 가 생기므로, 셀이 채우는 영역만큼만 캔버스를 잡는다(잔여 스트립 제거).
    log(`reorderSpritesheetFrames: reordering ${N} frames: ${JSON.stringify(order)}`);
    const outW = cols * cellW;
    const outH = rows * cellH;
    const outBuf = Buffer.alloc(outW * outH * ch, 0);
    for (let newIdx = 0; newIdx < N; newIdx++) {
      const srcIdx = order[newIdx];
      const srcR = Math.floor(srcIdx / cols);
      const srcC = srcIdx % cols;
      const dstR = Math.floor(newIdx / cols);
      const dstC = newIdx % cols;
      for (let y = 0; y < cellH; y++) {
        const srcRow = ((srcR * cellH + y) * W + srcC * cellW) * ch;
        const dstRow = ((dstR * cellH + y) * outW + dstC * cellW) * ch;
        src.copy(outBuf, dstRow, srcRow, srcRow + cellW * ch);
      }
    }
    const tmpOut = `${filePath}.reorder.tmp`;
    await sharp(outBuf, { raw: { width: outW, height: outH, channels: ch } }).png().toFile(tmpOut);
    fs.renameSync(tmpOut, filePath);
  } finally {
    // 임시 파일 정리
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
