/**
 * correction loop 이식 테스트.
 *
 * 이 루프에서 틀리면 조용히 나빠지는 것 둘을 겨눈다:
 *   - **최선 후보 보존** — 재생성이 더 나빠질 수 있는데 마지막 것을 쓰면 퇴보한다.
 *   - **종료 조건** — minAttempts/maxPasses/passScore 의 조합이 한 칸만 어긋나도
 *     한 번 덜 돌거나 무한히 돈다.
 *
 * 후보 선택 규칙은 정본의 파이썬 튜플 비교와 대조한다(같은 rank/score 열을 주고
 * 어느 시도가 뽑히는지 비교).
 *
 * 사용법: pnpm tsx scripts/test-correction-loop.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { runCorrectionLoop, formatHints, type Candidate } from "../src/lib/sprite/correction-loop";
import type { Frame } from "../src/lib/sprite/inspect";

const PY = "/Users/wonpyoung/Developer/workspace/sprite-gen/.venv/bin/python";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed++;
    console.log(`  OK   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * **통과하는** 후보의 프레임 — 같은 도형이 조금씩 움직인다.
 *
 * 무작위 노이즈로는 통과 케이스를 못 만든다: 프레임끼리 실루엣이 전혀 안 닮아
 * dHash 유사도가 임계 아래로 떨어지고, 경고 + 감점으로 90점을 못 넘는다.
 * 실제 스프라이트 행이 만족해야 하는 성질(정체성은 유지, 동작만 진행)을 그대로
 * 흉내내야 통과 경로를 밟을 수 있다.
 */
function moving(seed: number): Frame {
  const w = 32;
  const h = 32;
  const d = new Uint8Array(w * h * 4);
  const dx = seed % 3; // 프레임마다 1~2px 이동 — 모션은 있고 실루엣은 유지
  for (let y = 8; y < 26; y++) {
    for (let x = 10 + dx; x < 22 + dx; x++) {
      const i = (y * w + x) * 4;
      d[i] = 200;
      d[i + 1] = 60;
      d[i + 2] = 40;
      d[i + 3] = 255;
    }
  }
  return { data: d, width: w, height: h };
}

/** frames 개수를 조절해 "프레임 수 불일치" 를 만든다. */
function candidate(state: string, expected: number, count: number, seedBase = 0): Candidate {
  return [
    {
      state,
      expected,
      frames: Array.from({ length: count }, (_, i) => moving(seedBase + i + 1)),
    },
  ];
}

(async () => {
  console.log("=== 종료 조건 ===");
  {
    // 통과하는 후보 → minAttempts 만큼만 돈다.
    let calls = 0;
    const r = await runCorrectionLoop({
      initial: candidate("down_idle", 4, 4),
      regenerate: async () => {
        calls++;
        return candidate("down_idle", 4, 4);
      },
    });
    check("통과하면 1회로 끝난다", r.attempts.length === 1, `${r.attempts.length}회`);
    check("재생성을 부르지 않는다", calls === 0, `${calls}회 호출`);
    check("ok", r.ok);
  }
  {
    // 계속 실패하는 후보 → maxPasses 까지 돈다.
    let calls = 0;
    const r = await runCorrectionLoop({
      initial: candidate("down_idle", 4, 3),
      regenerate: async () => {
        calls++;
        return candidate("down_idle", 4, 3);
      },
      maxPasses: 3,
    });
    check("실패하면 maxPasses 까지 돈다", r.attempts.length === 3, `${r.attempts.length}회`);
    check("재생성은 maxPasses-1 번", calls === 2, `${calls}회`);
    check("ok=false", !r.ok);
  }
  {
    // minAttempts=2 면 첫 판이 통과해도 한 번 더 돈다.
    const r = await runCorrectionLoop({
      initial: candidate("down_idle", 4, 4),
      regenerate: async () => candidate("down_idle", 4, 4),
      minAttempts: 2,
      maxPasses: 3,
    });
    check("minAttempts 전에는 멈추지 않는다", r.attempts.length === 2, `${r.attempts.length}회`);
  }
  {
    // regenerate 없음 = dry run → 1회.
    const r = await runCorrectionLoop({ initial: candidate("down_idle", 4, 3) });
    check("regenerate 없으면 dry run 1회", r.dry_run && r.attempts.length === 1);
  }
  {
    // regenerate 가 null 이면 그 자리에서 멈춘다.
    const r = await runCorrectionLoop({
      initial: candidate("down_idle", 4, 3),
      regenerate: async () => null,
      maxPasses: 3,
    });
    check("재생성 불가면 멈춘다", r.attempts.length === 1, `${r.attempts.length}회`);
  }
  {
    const r = await runCorrectionLoop({
      initial: candidate("down_idle", 4, 4),
      passScore: 101,
      maxPasses: 2,
      regenerate: async () => candidate("down_idle", 4, 4),
    });
    check("passScore 를 못 넘으면 계속 돈다", r.attempts.length === 2 && !r.ok);
  }
  {
    let threw = false;
    try {
      await runCorrectionLoop({ initial: candidate("s", 4, 4), maxPasses: 0 });
    } catch {
      threw = true;
    }
    check("maxPasses < 1 은 throw", threw);
    threw = false;
    try {
      await runCorrectionLoop({ initial: candidate("s", 4, 4), minAttempts: 4, maxPasses: 2 });
    } catch {
      threw = true;
    }
    check("minAttempts > maxPasses 는 throw", threw);
  }

  console.log("\n=== 최선 후보 보존 ===");
  {
    // 2번째 시도가 가장 좋고 3번째가 나빠지는 경우 — best 는 2번이어야 한다.
    const seq: Candidate[] = [
      candidate("down_idle", 4, 2), // rank 200 - 10
      candidate("down_idle", 4, 4), // rank 400  ← 최선
      candidate("down_idle", 4, 1), // rank 100 - 10
    ];
    let i = 0;
    const r = await runCorrectionLoop({
      initial: seq[0],
      regenerate: async () => seq[++i] ?? null,
      maxPasses: 3,
      minAttempts: 3, // 통과해도 3회 다 돌게 해서 퇴보를 만든다
    });
    check("3회 다 돌았다", r.attempts.length === 3, `${r.attempts.length}회`);
    check("best 는 2번째 시도", r.best_attempt === 2, `best=${r.best_attempt}`);
    check(
      "best 가 마지막보다 낫다",
      r.best.candidate_rank > r.attempts[2].candidate_rank,
      `${r.best.candidate_rank} vs ${r.attempts[2].candidate_rank}`,
    );
    check("마지막이 실패면 ok=false", !r.ok);
  }

  console.log("\n=== 힌트 형식 ===");
  {
    check(
      "힌트 없으면 통과 문구",
      formatHints([]) === "- No correction hint; candidate passed.\n",
      JSON.stringify(formatHints([])),
    );
    check("힌트는 '- ' 목록", formatHints(["a", "b"]) === "- a\n- b\n");
  }

  console.log("\n=== 정본 대조: 후보 선택 규칙 ===");
  if (!existsSync(PY)) {
    console.log("  FAIL 파이썬 venv 없음 — 후보 선택 규칙을 대조하지 못했습니다");
    failed++;
  } else {
    // 원본은 `(candidate_rank, overall_score) > (best_rank, best_score)` 파이썬 튜플
    // 비교로 best 를 고른다. 같은 열을 주고 어느 인덱스가 뽑히는지 비교한다.
    const seqs: Array<Array<[number, number]>> = [
      [[100, 90], [200, 50], [150, 99]],
      [[300, 80], [300, 95], [300, 90]],
      [[100, 50], [100, 50], [100, 50]],
      [[0, 0], [-10, 100], [5, 1]],
    ];
    const out = execFileSync(
      PY,
      [
        "-c",
        [
          "import json, sys",
          "seqs = json.loads(sys.stdin.read())",
          "res = []",
          "for seq in seqs:",
          "    best = None; best_i = 0",
          "    for i, (rank, score) in enumerate(seq):",
          "        if best is None or (rank, score) > best:",
          "            best = (rank, score); best_i = i + 1",
          "    res.append(best_i)",
          "print(json.dumps(res))",
        ].join("\n"),
      ],
      { encoding: "utf8", input: JSON.stringify(seqs) },
    );
    const ref = JSON.parse(out) as number[];
    const ours = seqs.map(seq => {
      let bestRank = -Infinity;
      let bestScore = -Infinity;
      let bestI = 0;
      seq.forEach(([rank, score], i) => {
        if (
          bestI === 0 ||
          rank > bestRank ||
          (rank === bestRank && score > bestScore)
        ) {
          bestRank = rank;
          bestScore = score;
          bestI = i + 1;
        }
      });
      return bestI;
    });
    check(
      "튜플 사전식 비교가 정본과 같은 후보를 고른다",
      JSON.stringify(ours) === JSON.stringify(ref),
      `ours=${JSON.stringify(ours)} ref=${JSON.stringify(ref)}`,
    );
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
