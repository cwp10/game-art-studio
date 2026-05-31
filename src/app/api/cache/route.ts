import fs from "node:fs";
import path from "node:path";
import { TMP_DIR, THUMBS_DIR } from "@/lib/util/paths";

export const dynamic = "force-dynamic";

export async function DELETE() {
  const results: Record<string, number> = {};

  for (const [label, dir] of [["tmp", TMP_DIR], ["thumbnails", THUMBS_DIR]] as const) {
    let count = 0;
    try {
      for (const entry of fs.readdirSync(dir)) {
        fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        count++;
      }
    } catch {
      // dir doesn't exist or already empty
    }
    results[label] = count;
  }

  return Response.json({ cleared: results });
}
