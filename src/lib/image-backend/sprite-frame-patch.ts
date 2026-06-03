/**
 * 스프라이트시트 개별 프레임(셀) 재생성 파이프라인 — 결정적 합성(sharp) + 단일 셀 codex 편집.
 *
 * WHY: 시트 한 셀만 마음에 안 들 때 전체 재생성은 다른 셀까지 바꾼다. 이 모듈은 대상 셀만
 *   뽑아 codex 로 편집하고, 그 셀만 원본 시트 픽셀 버퍼에 덮어써 동일 크기 새 시트를 만든다.
 *
 * 불변식:
 *  - 전체 시트 normalizeSpritesheetCells 재실행 금지(다른 셀 변형 방지).
 *  - 결과 W×H == 입력 시트 W×H (raw 버퍼 in-place 패치라 자동 보장).
 *  - codex 편집 job 은 호출자 jobId 와 다른 id 를 써서 우리 tmpDir 와 충돌하지 않게 한다
 *    (codex-exec.execute 가 jobDir(job.id) 를 자기 workDir 로 쓰고 성공 시 await 없이 rm 함).
 */
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { jobDir as jobDirFor } from "@/lib/util/paths";
import { newGenerationId, newJobId } from "@/lib/util/ids";
import { chromaKeyFile } from "./spritesheet-postprocess";
import type { ImageBackend, ImageJob } from "./index";

export async function patchSpritesheetFrame(opts: {
  sheetImagePath: string; // 원본 시트 절대 경로
  cellW: number; // 셀 너비 px
  cellH: number; // 셀 높이 px
  row: number; // 0-indexed
  col: number; // 0-indexed
  prompt: string; // 편집 프롬프트
  backend: ImageBackend; // codex-exec 어댑터 (인터페이스)
  outPath: string; // 결과 시트 저장 경로 (절대)
  jobId: string; // logging용
}): Promise<{ width: number; height: number; elapsedMs: number }> {
  const { sheetImagePath, cellW, cellH, row, col, prompt, backend, outPath, jobId } = opts;
  const startedAt = performance.now();

  const tmpDir = jobDirFor(jobId);
  await fs.mkdir(tmpDir, { recursive: true });
  const cellInPath = path.join(tmpDir, "cell-in.png");
  const cellOutPath = path.join(tmpDir, "cell-out.png");

  try {
    // 1. 셀 추출 → tmp PNG.
    await sharp(sheetImagePath)
      .extract({ left: col * cellW, top: row * cellH, width: cellW, height: cellH })
      .png()
      .toFile(cellInPath);

    // 2. codex img2img 편집. backend.execute 는 data/images/{generationId}.png 에 결과를 쓰고
    //    result.imagePath 로 반환한다. 호출자 jobId 와 다른 id 를 써서 tmpDir 충돌 회피.
    const editJob: ImageJob = {
      id: newJobId(),
      generationId: newGenerationId(),
      kind: "img2img",
      prompt,
      inputImagePaths: [cellInPath],
    };
    const editResult = await backend.execute(editJob, () => {});
    // backend 산출물을 우리 tmp 경로로 이동(data/images 에 잔류물 남기지 않음).
    await fs.rename(editResult.imagePath, cellOutPath);

    // 3. chroma-key — codex 가 #00ff00 등 단색 배경으로 그렸다면 키아웃.
    //    cell-out.png 은 codex 의 native 해상도(~1024²) 단일 이미지지 셀 해상도가 아니다.
    //    chromaKeyFile 계약상 단일 이미지는 cellArea 미지정(→ 전체 N) 이어야 enclosed
    //    배경 포켓(다리 사이 등) 흡수 임계가 올바르게 잡힌다.
    await chromaKeyFile(cellOutPath, "green", () => {});

    // 4. cell-fit — cellW×cellH 투명 캔버스에 비율 유지로 중앙 배치(contain = 단일 패스).
    const fittedBuf = await sharp(cellOutPath)
      .ensureAlpha()
      .resize(cellW, cellH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .raw()
      .toBuffer();

    // 5. 원본 시트 로드 → 패치 → 저장. raw RGBA 버퍼에서 셀 영역만 덮어쓴다.
    const { data: sheetBuf, info } = await sharp(sheetImagePath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const sheetW = info.width;
    const sheetH = info.height;
    const x0 = col * cellW;
    const y0 = row * cellH;
    for (let y = 0; y < cellH; y++) {
      const srcRow = y * cellW * 4;
      const dstRow = ((y0 + y) * sheetW + x0) * 4;
      fittedBuf.copy(sheetBuf, dstRow, srcRow, srcRow + cellW * 4);
    }
    await sharp(sheetBuf, { raw: { width: sheetW, height: sheetH, channels: 4 } })
      .png()
      .toFile(outPath);

    return {
      width: sheetW,
      height: sheetH,
      elapsedMs: Math.round(performance.now() - startedAt),
    };
  } finally {
    // 6. tmp 정리.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}
