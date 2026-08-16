/**
 * ④a Task 1 — SpriteRequest 조립 테스트.
 * 패널 인자에서 ②③ 계약을 만족하는 request 가 나오는지 본다.
 */
import sharp from "sharp";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpriteRequest } from "../src/lib/sprite/build-request";

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

void (async () => {
  const base = {
    characterId: "aurora",
    description: "small fox mage in a crimson cloak",
    baseImagePath: null,
    uiDirection: "DOWN",
    frames: 4,
    loop: true,
    // 정본 어휘로 매핑되지 않는 동작 — 상태명이 기본값 `action` 으로 떨어진다.
    actionPrompt: "spin the staff overhead",
  };

  console.log("=== 방향 계약이 붙는다 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("directions.set 은 down 하나", request.directions?.set.join(",") === "down");
    check("anchorSuffix 는 idle", request.directions?.anchorSuffix === "idle");
    check(
      "상태 이름에 방향 접두사",
      "down_action" in request.states,
      Object.keys(request.states).join(","),
    );
    check("앵커 상태가 합성된다", "down_idle" in request.states);
    check("앵커 상태가 앞에 온다", Object.keys(request.states)[0] === "down_idle");
    check("요청 프레임 수가 반영된다", request.states.down_action.frames === 4);
    check("요청 loop 이 반영된다", request.states.down_action.loop === true);
    check("action 은 패널 문구", request.states.down_action.action === "spin the staff overhead");
    check("미지 상태의 fps 는 6", request.states.down_action.fps === 6);
    check("합성 앵커의 fps 는 4", request.states.down_idle.fps === 4);
  }

  console.log("=== 동작 텍스트에서 정본 상태명을 뽑는다 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, actionPrompt: "칼로 공격" });
    check("공격 → attack", "down_attack" in request.states, Object.keys(request.states).join(","));
    // fps 는 그래도 6 이다 — normalize_states 가 DEFAULT_STATES 를 **전체 상태명**으로
    // 조회하므로 `down_attack` 은 원본에서도 빗나간다. 방향 계약 런에서 상태별 fps 가
    // 붙지 않는 것은 원본 동작이고, 우리 쪽에서 고치지 않는다.
    check("방향 계약 런의 fps 는 원본대로 6", request.states.down_attack.fps === 6);
  }
  {
    const { request, warnings } = await buildSpriteRequest({ ...base, actionPrompt: "달리기 사이클" });
    check("달리기 → run", "down_run" in request.states, Object.keys(request.states).join(","));
    check(
      "experimental 등급이 경고로 보고된다",
      warnings.some(w => w.includes("experimental")),
      warnings.join(" | "),
    );
    check(
      "로코모션 모션 위상 참조 부재가 경고로 남는다",
      warnings.some(w => w.includes("주기적 이동")),
      warnings.join(" | "),
    );
  }
  {
    // idle 요청은 방향 앵커 행과 **같은 상태**가 된다. 정본 체인 그림에서 `<dir>_idle` 행은
    // 앵커의 원천이자 "게임의 idle 로도 그대로 쓴다" 이므로 행을 따로 만들지 않는다.
    const { request } = await buildSpriteRequest({ ...base, actionPrompt: "대기 호흡" });
    check("대기 → idle", "down_idle" in request.states);
    check("앵커 행과 합쳐져 상태가 하나", Object.keys(request.states).length === 1);
    check("사용자 값이 합성 앵커를 이긴다", request.states.down_idle.action === "대기 호흡");
  }

  console.log("=== 45도 방향 — 방향은 down45/up45, 좌우는 상태명 접미사 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "DOWN-RIGHT" });
    check("DOWN-RIGHT → down45", request.directions?.set.join(",") === "down45");
    check("상태 이름에 45도 접미사", "down45_action-front-right" in request.states);
    check("앵커는 down45_idle", "down45_idle" in request.states);
  }
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "UP-LEFT" });
    check("UP-LEFT → up45", request.directions?.set.join(",") === "up45");
    check("상태 이름", "up45_action-back-left" in request.states);
  }
  {
    // 정본은 방향성 로코모션을 진행형으로 쓴다 — 그래야 등급·로코모션 판정이 걸린다.
    const { request, warnings } = await buildSpriteRequest({
      ...base,
      uiDirection: "DOWN-RIGHT",
      actionPrompt: "달리기 사이클",
    });
    check(
      "run + 45도 → running-front-right",
      "down45_running-front-right" in request.states,
      Object.keys(request.states).join(","),
    );
    check("experimental 로 보고된다", warnings.some(w => w.includes("experimental")));
    check("로코모션 경고도 붙는다", warnings.some(w => w.includes("주기적 이동")));
  }
  {
    // 4방위는 접미사가 붙지 않고 진행형으로도 바뀌지 않는다.
    const { request } = await buildSpriteRequest({
      ...base,
      uiDirection: "DOWN",
      actionPrompt: "달리기 사이클",
    });
    check("4방위 run 은 그대로", "down_run" in request.states, Object.keys(request.states).join(","));
  }
  {
    // 좌우가 같은 방향(=같은 앵커)을 공유한다 — 정본 좌우 쌍 절차의 전제다.
    const r = await buildSpriteRequest({ ...base, uiDirection: "DOWN-RIGHT" });
    const l = await buildSpriteRequest({ ...base, uiDirection: "DOWN-LEFT" });
    check(
      "DOWN-RIGHT 와 DOWN-LEFT 는 앵커를 공유",
      r.request.directions?.set[0] === l.request.directions?.set[0],
    );
    check("행은 갈린다", !("down45_action-front-right" in l.request.states));
  }

  console.log("=== REF 는 방향 계약 없음 ===");
  {
    const { request } = await buildSpriteRequest({ ...base, uiDirection: "REF" });
    check("directions 없음", request.directions === undefined);
    check(
      "상태 이름에 접두사 없음",
      "action" in request.states,
      Object.keys(request.states).join(","),
    );
    check("앵커 상태 합성 안 함", Object.keys(request.states).length === 1);
  }

  console.log("=== 미러 계약 ===");
  {
    const { request } = await buildSpriteRequest({
      ...base,
      uiDirection: "RIGHT",
      mirrorFrom: "LEFT",
    });
    check(
      "미러 대상이 기록된다",
      request.directions?.mirror.left === "right",
      JSON.stringify(request.directions),
    );
    check("미러 방향은 set 에 없다", !request.directions?.set.includes("left"));
  }

  console.log("=== 셀 기하 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("기본 셀 256 정사각", request.cell.width === 256 && request.cell.height === 256);
    check("비례 margin 24", request.cell.safeMarginX === 24);
    const { request: r2 } = await buildSpriteRequest({ ...base, cellSize: 128 });
    check("cellSize 반영 + 비례 margin 12", r2.cell.width === 128 && r2.cell.safeMarginX === 12);
  }

  console.log("=== 크로마 키 ===");
  {
    const { request, warnings } = await buildSpriteRequest(base);
    check("base 없으면 마젠타 폴백", request.chromaKey.hex === "#FF00FF");
    check("폴백이 경고로 남는다", warnings.some(w => w.includes("chroma")), warnings.join(" | "));
  }
  {
    const dir = await mkdtemp(join(tmpdir(), "req-"));
    try {
      // 흰 배경 + 크림슨 소재 → 마젠타가 아닌 키가 뽑혀야 한다
      const w = 64;
      const h = 64;
      const raw = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        raw[i * 4] = 254;
        raw[i * 4 + 1] = 254;
        raw[i * 4 + 2] = 254;
        raw[i * 4 + 3] = 255;
      }
      for (let y = 16; y < 48; y++) {
        for (let x = 16; x < 48; x++) {
          const o = (y * w + x) * 4;
          raw[o] = 153;
          raw[o + 1] = 12;
          raw[o + 2] = 40;
        }
      }
      const p = join(dir, "base.png");
      await sharp(raw, { raw: { width: w, height: h, channels: 4 } })
        .png()
        .toFile(p);
      const { request } = await buildSpriteRequest({ ...base, baseImagePath: p });
      check(
        "크림슨 base 에는 마젠타를 안 고른다",
        request.chromaKey.hex !== "#FF00FF",
        request.chromaKey.hex,
      );
      check("선택 근거가 기록된다", typeof request.chromaKey.minSubjectDistance === "number");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  console.log("=== 튜너블 기본값 ===");
  {
    const { request } = await buildSpriteRequest(base);
    check("chroma.mode 는 rgb (ycbcr 은 옵트인)", request.chroma.mode === "rgb");
    check("keyThreshold 96", request.chroma.keyThreshold === 96);
  }

  console.log("=== 프레임 수 경고 ===");
  {
    const { warnings } = await buildSpriteRequest({ ...base, frames: 12 });
    check(
      "12프레임은 not-default 경고",
      warnings.some(w => w.includes("duplicate")),
      warnings.join(" | "),
    );
  }
  {
    const { warnings } = await buildSpriteRequest({ ...base, frames: 8 });
    check("8프레임은 advanced 경고", warnings.some(w => w.includes("advanced")));
  }
  {
    const { warnings } = await buildSpriteRequest({ ...base, frames: 4 });
    check("4프레임은 프레임 경고 없음", !warnings.some(w => w.startsWith("frames=")));
  }

  console.log(`\n${passed} passed / ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
