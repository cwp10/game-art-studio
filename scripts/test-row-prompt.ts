/**
 * ② Task 5 — row 프롬프트 Prompt Contract 검증.
 *
 * 문자열 완전 일치는 요구하지 않는다 (스펙 §7). 검사하는 것은 7항목의 존재와
 * request 값의 정확한 주입, 그리고 정본이 금지한 것이 들어가지 않았는지다.
 */
import {
  buildRowPrompt,
  STYLE_DEFAULT,
  TRANSPARENCY_ARTIFACT_RULES,
} from "../src/lib/sprite/row-prompt";
import {
  DEFAULT_CHROMA_TUNABLES,
  normalizeCell,
  normalizeStates,
  type SpriteRequest,
} from "../src/lib/sprite/request";

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

const request: SpriteRequest = {
  version: 1,
  character: {
    id: "aurora",
    description: "small fox mage in a crimson cloak",
    anchorGenerationId: "gen_x",
  },
  cell: normalizeCell({}),
  chromaKey: { name: "green", hex: "#00FF00", rgb: [0, 255, 0], selection: "auto" },
  chroma: DEFAULT_CHROMA_TUNABLES,
  states: normalizeStates(null),
};

const p = buildRowPrompt(request, "attack", request.states.attack);

console.log("=== Prompt Contract 7항목 ===");
check("1. 정확한 프레임 수", /Exactly 4 full-body frames/.test(p));
check("2. 슬롯마다 완전한 전신 포즈 하나", /exactly one complete full-body pose/.test(p));
check("3. safe margin 수치", p.includes("24 px horizontal") && p.includes("24 px vertical"));
check("4. 모든 프레임에 동일한 잠긴 앵커 정체성", /anchors own character identity/.test(p));
check("5. 모션 전용 행 책임", /This row owns motion only/.test(p));
check("6. 평면 크로마 배경", p.includes("#00FF00") && /perfectly flat pure green/.test(p));
check("7. 금지 목록 — 가이드 박스", /Do not reproduce the layout guide/.test(p));
check(
  "7. 금지 목록 — 그림자·글로우·스미어",
  /shadows/.test(p) && /glows/.test(p) && /smears/.test(p),
);
check("7. 금지 목록 — 텍스트·UI·프레임 번호", /frame numbers/.test(p) && /UI panels/.test(p));
check("7. 금지 목록 — 분리된 이펙트", /Do not draw detached effects/.test(p));

console.log("=== request 값 주입 ===");
check("캐릭터 id", p.includes("`aurora`"));
check("캐릭터 서술", p.includes("small fox mage in a crimson cloak"));
check("상태명", p.includes("`attack`"));
check("action 서술", p.includes("simple windup, strike, recovery"));
check("셀 치수", p.includes("256x256"));
{
  const rect = buildRowPrompt(
    { ...request, cell: normalizeCell({ width: 192, height: 208 }) },
    "idle",
    request.states.idle,
  );
  check("rect 셀도 치수가 반영된다", rect.includes("192x208"));
  check(
    "rect 셀의 축별 margin",
    rect.includes("18 px horizontal") && rect.includes("19 px vertical"),
  );
}
{
  const six = buildRowPrompt(request, "idle", { ...request.states.idle, frames: 6 });
  check("프레임 수는 entry 에서 온다", /Exactly 6 full-body frames/.test(six));
}
{
  const magenta = buildRowPrompt(
    {
      ...request,
      chromaKey: { name: "magenta", hex: "#FF00FF", rgb: [255, 0, 255], selection: "auto" },
    },
    "attack",
    request.states.attack,
  );
  check("크로마 키가 바뀌면 프롬프트도 바뀐다", magenta.includes("perfectly flat pure magenta #FF00FF"));
  check("바뀐 키에 이전 키가 남지 않는다", !magenta.includes("#00FF00"));
}

console.log("=== 상태별 요구사항 ===");
{
  const walk = buildRowPrompt(request, "walk", { frames: 8, fps: 8, loop: true, action: "walk cycle" });
  check("walk 는 상태별 요구사항이 붙는다", /State-specific requirements/.test(walk));
  check("walk 요구사항 — 제자리 흔들림 금지", /instead of repeated standing or static bobbing/.test(walk));
  check("attack 은 상태별 블록이 없다", !/State-specific requirements/.test(p));
  const jump = buildRowPrompt(request, "jump", request.states.jump);
  check("jump 요구사항 — 접지 그림자 금지", /Do not draw ground shadows/.test(jump));
}

console.log("=== 스타일 SSoT ===");
check("STYLE_DEFAULT 가 프롬프트에 들어간다", p.includes(STYLE_DEFAULT));
check(
  "STYLE_DEFAULT 는 레퍼런스 추종을 요구한다",
  /match the attached base\/anchor reference image EXACTLY/.test(STYLE_DEFAULT),
);
for (const banned of ["chibi", "chunky", "thick outline", "head-to-body"]) {
  check(
    `STYLE_DEFAULT 가 체형을 재기술하지 않는다 — '${banned}' 없음`,
    !STYLE_DEFAULT.toLowerCase().includes(banned.toLowerCase()),
  );
}
check(
  "투명·아티팩트 규칙 6종이 모두 들어간다",
  TRANSPARENCY_ARTIFACT_RULES.length === 6 && TRANSPARENCY_ARTIFACT_RULES.every(r => p.includes(r)),
  `${TRANSPARENCY_ARTIFACT_RULES.length} rules`,
);

console.log("=== 크로마 인접색 금지 ===");
check(
  "소재에 키 색을 쓰지 말라는 지시",
  /Do not use #00FF00, pure green, or chroma-adjacent colors/.test(p),
);

console.log("=== 방향 접두사 잠금 (directions 블록) ===");
{
  const directions = { set: ["down", "right"], mirror: { left: "right" }, anchorSuffix: "idle" };
  const dirReq = { ...request, directions };
  const anchorRow = buildRowPrompt(dirReq, "down_idle", {
    frames: 4,
    fps: 4,
    loop: true,
    action: "idle",
  });
  const actionRow = buildRowPrompt(dirReq, "down_walk", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "walk",
  });

  check("facing 잠금이 붙는다", /Lock the whole row to facing the viewer \(front view\)/.test(anchorRow));
  check("평균화 금지 문구", /Do not average it into a different facing/.test(anchorRow));
  check(
    "앵커 행은 CANONICAL DIRECTION ANCHOR 로 선언된다",
    /This row is the CANONICAL DIRECTION ANCHOR/.test(anchorRow),
  );
  check(
    "앵커 행은 base 에서 identity 를 가져오라고 한다",
    /derive identity from the attached base image/.test(anchorRow),
  );
  check("앵커 행은 포즈를 최소로 요구한다", /keep poses minimal/.test(anchorRow));
  check(
    "액션 행은 앵커에서 identity",
    /Derive identity from the attached accepted direction anchor/.test(actionRow),
  );
  check("액션 행은 base 사용을 금지한다", /not from any base character image/.test(actionRow));
  check("액션 행에 CANONICAL 선언이 없다", !/CANONICAL DIRECTION ANCHOR/.test(actionRow));
  check("directions 없으면 접두사 블록도 없다", !/Lock the whole row to/.test(p));
}

console.log("=== 45도 접미사 잠금 (directions 블록 없이도 동작) ===");
{
  const fr = buildRowPrompt(request, "running-front-right", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "run",
  });
  check(
    "3/4 정면 + camera-right 잠금",
    /Lock the whole row to a 45-degree three-quarter-front view facing camera-right and slightly toward the viewer/.test(
      fr,
    ),
  );
  check(
    "정면·후면·순수 측면으로 평균화 금지",
    /Do not average this into a straight front, straight back, or pure side-view sprite/.test(fr),
  );
  check(
    "타깃 방향 앵커가 최우선 facing 근거",
    /its facing direction is authoritative and overrides any paired-row reference/.test(fr),
  );
  check("방향 시트는 facing 전용", /use it as the direction SSoT for facing only/.test(fr));
  check("right 에는 basis 행 조항이 없다", !/basis row is attached/.test(fr));

  const fl = buildRowPrompt(request, "running-front-left", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "run",
  });
  check("left 는 3/4 정면 camera-left", /facing camera-left and slightly toward the viewer/.test(fl));
  check(
    "left 에는 basis 행을 timing 전용으로 쓰라는 조항이 붙는다",
    /use it only for timing, scale, and pose-family consistency; change the facing to camera-left/.test(
      fl,
    ),
  );

  const br = buildRowPrompt(request, "working-back-right", {
    frames: 6,
    fps: 6,
    loop: true,
    action: "work",
  });
  check(
    "back 은 3/4 후면 + away from the viewer",
    /three-quarter-back view facing camera-right and slightly away from the viewer/.test(br),
  );

  check("접미사가 없으면 블록도 없다", !/45-degree three-quarter/.test(p));
}

console.log("=== 합성 순서 — 접두사 → 접미사 → STATE_REQUIREMENTS ===");
{
  // 접미사 → STATE_REQUIREMENTS
  const fl = buildRowPrompt(request, "running-front-left", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "run",
  });
  const iSuffix = fl.indexOf("Lock the whole row to a 45-degree");
  const iState = fl.indexOf("Show 45-degree diagonal locomotion toward camera-left");
  check(
    "접미사 항목이 STATE_REQUIREMENTS 보다 앞",
    iSuffix > -1 && iState > iSuffix,
    `suffix=${iSuffix} state=${iState}`,
  );
}
{
  // 접두사 → 접미사
  const directions = { set: ["down"], mirror: {}, anchorSuffix: "idle" };
  const both = buildRowPrompt({ ...request, directions }, "down_running-front-left", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "run",
  });
  const iPrefix = both.indexOf("Lock the whole row to facing the viewer");
  const iSuffix = both.indexOf("Lock the whole row to a 45-degree");
  check(
    "접두사 항목이 접미사보다 앞",
    iPrefix > -1 && iSuffix > iPrefix,
    `prefix=${iPrefix} suffix=${iSuffix}`,
  );
}
{
  // 원본과 동일한 성질: STATE_REQUIREMENTS 의 키는 맨 상태명(walk/run)이므로
  // 방향 계약 런의 <dir>_<state> 에는 **절대 걸리지 않는다**. 실측으로 확인한 원본 동작이며
  // (down_walk → STATE_REQ=0, suffix=0), 우리 구현도 같아야 한다.
  const directions = { set: ["down"], mirror: {}, anchorSuffix: "idle" };
  const dw = buildRowPrompt({ ...request, directions }, "down_walk", {
    frames: 8,
    fps: 8,
    loop: true,
    action: "walk",
  });
  check(
    "방향 계약 런의 down_walk 에는 STATE_REQUIREMENTS 가 붙지 않는다 (원본과 동일)",
    !dw.includes("Show locomotion through body, arm, leg"),
  );
  check("그래도 facing 잠금은 붙는다", dw.includes("Lock the whole row to facing the viewer"));
}

// 교정 힌트 주입 — 정본은 힌트를 파일로 뱉고 프롬프트 조립을 provider 에 맡기지만,
// 우리는 직접 얹으므로 **어디에** 얹히는지가 계약이다. 레이아웃 규칙보다 앞이어야
// 한다: 교정은 이번 시도에서 반드시 달라져야 하는 것이라 뒤에 묻히면 안 된다.
{
  const hint =
    "attack: Adjacent frames are too similar (motion presence 0.0064). Make the action visibly progress.";
  const withHint = buildRowPrompt(request, "attack", request.states.attack, [hint]);
  check("힌트가 프롬프트에 들어간다", withHint.includes(hint));
  check(
    "교정 머리말이 붙는다",
    withHint.includes("The previous attempt at this row was rejected"),
  );
  check(
    "힌트가 레이아웃 규칙보다 앞에 온다",
    withHint.indexOf(hint) < withHint.indexOf("Layout requirements:"),
  );
  check(
    "힌트가 Anchor lock 보다 앞에 온다",
    withHint.indexOf(hint) < withHint.indexOf("Anchor lock:"),
  );
  const noHint = buildRowPrompt(request, "attack", request.states.attack, []);
  check(
    "힌트가 없으면 머리말도 없다",
    !noHint.includes("The previous attempt at this row was rejected"),
  );
  check("힌트 없는 프롬프트는 기존과 같다", noHint === p);
}

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
