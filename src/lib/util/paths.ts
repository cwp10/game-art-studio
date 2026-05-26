import path from "node:path";
import fs from "node:fs";

/**
 * 런타임 데이터 루트. 기본 `./data`. 테스트나 다른 위치로 옮기고 싶을 때만 IMAGEGEN_DATA_DIR 로 오버라이드.
 * cwd 는 Next 가 프로젝트 루트에서 실행하므로 일반적으로 그대로 두면 됨.
 */
export const DATA_DIR = path.resolve(
  process.env.IMAGEGEN_DATA_DIR ?? path.join(process.cwd(), "data"),
);

export const DB_PATH = path.join(DATA_DIR, "app.db");
export const IMAGES_DIR = path.join(DATA_DIR, "images");
export const THUMBS_DIR = path.join(DATA_DIR, "thumbnails");
export const TMP_DIR = path.join(DATA_DIR, "tmp");
export const LOGS_DIR = path.join(DATA_DIR, "logs");

/** 호출 시점에 필요한 하위 폴더가 모두 있도록 보장. 멱등. */
export function ensureDataDirs(): void {
  for (const dir of [DATA_DIR, IMAGES_DIR, THUMBS_DIR, TMP_DIR, LOGS_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** generation id 로 PNG 절대 경로. */
export function imagePath(id: string): string {
  return path.join(IMAGES_DIR, `${id}.png`);
}

/** generation id 로 thumbnail webp 절대 경로. */
export function thumbnailPath(id: string): string {
  return path.join(THUMBS_DIR, `${id}.webp`);
}

/** Codex job 작업 디렉토리 (data/tmp/job-{id}). 호출자가 mkdir 한다. */
export function jobDir(jobId: string): string {
  return path.join(TMP_DIR, `job-${jobId}`);
}

/** DATA_DIR 기준 상대 경로로 변환 (DB 에는 상대 경로 저장). */
export function toRelative(absolutePath: string): string {
  return path.relative(DATA_DIR, absolutePath);
}
