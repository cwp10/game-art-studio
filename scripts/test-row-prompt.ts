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

console.log(`\n${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
