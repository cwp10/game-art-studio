import fs from "node:fs";
import path from "node:path";
import { getDb } from "@/lib/db/client";
import { IMAGES_DIR, THUMBS_DIR, TMP_DIR, imagePath, thumbnailPath } from "@/lib/util/paths";

export const dynamic = "force-dynamic";

/** images/{id}.png → id, 아니면 null. */
function idFromPng(filename: string): string | null {
  return filename.endsWith(".png") ? filename.slice(0, -4) : null;
}

/** thumbnails/{id}.webp → id, 아니면 null. */
function idFromWebp(filename: string): string | null {
  return filename.endsWith(".webp") ? filename.slice(0, -5) : null;
}

function rmFileQuiet(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // 이미 없음 — 무시
  }
}

export async function DELETE() {
  const db = getDb();

  // 1. 크로스-참조 Set: 다른 generation 의 입력으로 쓰인 id 는 보존한다.
  const referenced = new Set<string>();
  const refRows = db
    .prepare("SELECT input_image_ids FROM generations WHERE input_image_ids IS NOT NULL")
    .all() as Array<{ input_image_ids: string }>;
  for (const row of refRows) {
    try {
      const ids = JSON.parse(row.input_image_ids) as unknown;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === "string") referenced.add(id);
    } catch {
      // 깨진 JSON — 무시
    }
  }

  // 2. 세션 없는 generation 삭제 (session_id IS NULL && 참조되지 않음).
  //    행 + png + webp 를 함께 지운다. 여기서 지운 파일은 orphanFiles/unmatchedThumbs 로 다시 세지 않는다.
  let orphanGenerations = 0;
  const orphanRows = db
    .prepare("SELECT id FROM generations WHERE session_id IS NULL")
    .all() as Array<{ id: string }>;
  const delStmt = db.prepare("DELETE FROM generations WHERE id = ?");
  for (const { id } of orphanRows) {
    if (referenced.has(id)) continue;
    delStmt.run(id);
    rmFileQuiet(imagePath(id));
    rmFileQuiet(thumbnailPath(id));
    orphanGenerations++;
  }

  // 3. 고아 이미지 파일: data/images/{id}.png 가 있으나 (step 2 이후) generations.id 에 없는 것.
  const liveIds = new Set(
    (db.prepare("SELECT id FROM generations").all() as Array<{ id: string }>).map((r) => r.id),
  );
  let orphanFiles = 0;
  try {
    for (const entry of fs.readdirSync(IMAGES_DIR)) {
      const id = idFromPng(entry);
      if (id && !liveIds.has(id)) {
        rmFileQuiet(path.join(IMAGES_DIR, entry));
        orphanFiles++;
      }
    }
  } catch {
    // images 디렉토리 없음 — 무시
  }

  // 4. 미매칭 썸네일: thumbnails/{id}.webp 가 있으나 images/{id}.png 가 (디스크에) 없는 것.
  let unmatchedThumbs = 0;
  try {
    for (const entry of fs.readdirSync(THUMBS_DIR)) {
      const id = idFromWebp(entry);
      if (id && !fs.existsSync(imagePath(id))) {
        rmFileQuiet(path.join(THUMBS_DIR, entry));
        unmatchedThumbs++;
      }
    }
  } catch {
    // thumbnails 디렉토리 없음 — 무시
  }

  // 5. tmp 비우기.
  let tmp = 0;
  try {
    for (const entry of fs.readdirSync(TMP_DIR)) {
      fs.rmSync(path.join(TMP_DIR, entry), { recursive: true, force: true });
      tmp++;
    }
  } catch {
    // tmp 디렉토리 없음 — 무시
  }

  return Response.json({ deleted: { orphanGenerations, orphanFiles, unmatchedThumbs, tmp } });
}
