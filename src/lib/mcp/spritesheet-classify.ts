/**
 * 스프라이트시트 피사체 분류 — 순수 함수 모듈 (side-effect 없음, tsx import 안전).
 *
 * server.ts(MCP) 에서 추출. top-level 에서 DB·서버 기동·MCP 등록 일절 없음.
 * SubjectType 타입은 spritesheet-postprocess 에서 import 해 재사용(중복 정의 금지).
 */
import type { SubjectType } from "../image-backend/spritesheet-postprocess.js";

// 캐릭터를 명확히 가리키는 단어 — 있으면 항상 character.
// 명사(캐릭터·기사·로봇 등) + 캐릭터 모션 동사(걷기·공격·시전·방어·회피·사망 등).
// 발산 VFX 명사(슬래시·폭발·빔 등)는 여기 두지 않는다 — EFFECT_WORDS 신호.
const CHAR_WORDS = [
  "캐릭터", "캐릭", "character", "소녀", "소년", "girl", "boy", "기사", "knight",
  "전사", "warrior", "마법사", "wizard", "mage", "궁수", "archer", "사람", "인물",
  "person", "man", "woman", "hero", "영웅", "몬스터", "monster", "동물", "animal",
  "creature", "갑옷", "armor", "로봇", "robot", "정령",
  // 모션 동사 — 캐릭터 동작 묘사. 발산 이펙트 명사가 아니라 캐릭터 시트 신호.
  "걷기", "walk", "run", "달리기", "점프", "jump", "idle", "대기", "걸음", "뛰기",
  "공격", "attack", "스킬", "skill", "시전", "cast", "주문", "spell", "방어", "block",
  "막기", "회피", "dodge", "구르기", "roll", "사망", "death", "피격", "hit",
  "가드", "guard", "승리", "victory", "도발", "taunt", "인사", "wave", "웅크", "crouch",
];

// 명백한 VFX/이펙트(외부 발산) 단어 — 캐릭터 단어가 없을 때만 effect 로 판정.
const EFFECT_WORDS = [
  "이펙트", "이팩트", "effect", "vfx", "슬래시", "slash", "베기", "참격", "검기",
  "검광", "폭발", "폭팔", "explosion", "blast", "burst", "충격파", "shockwave",
  "투사체", "projectile", "빔", "beam", "광선", "오라", "aura", "잔상", "trail",
  "임팩트", "impact", "타격", "회오리", "소용돌이", "swirl", "스파크", "spark",
  "파티클", "particle", "폭염", "불기둥", "화염구", "fireball",
];

/**
 * 스프라이트시트 피사체 앵커 분류. "effect" 면 중앙 앵커(바닥 앵커 제거), 그 외 "character"(기존 동작).
 *
 * 결정적·보수적 (char-first):
 *   1. 참조 이미지가 있으면 항상 character (참조 캐릭터 시트).
 *   2. 캐릭터 명사·모션 동사가 있으면 character — 함께 발산 VFX 명사가 있어도 우선
 *      (예: "마법사 공격", "화염 마법사"). 회귀 방지.
 *   3. 그 다음 발산 VFX 단어만 있으면 effect ("슬래시 이펙트").
 *   4. 모호하면 character.
 */
export function classifyAnchor(prompt: string, hasRef: boolean): "effect" | "character" {
  if (hasRef) return "character"; // 참조 캐릭터가 있으면 캐릭터 시트
  // 오케스트레이터가 모든 시트 프롬프트에 강제 주입하는 보일러플레이트는 분류에서 제외.
  // (구버전 "character consistent across frames" 의 'character' 가 분류를 오염시킴.)
  const p = prompt
    .toLowerCase()
    .replace(/(uniform cells,?\s*)?(character|subject) consistent across frames/g, "");
  if (CHAR_WORDS.some(w => p.includes(w))) return "character";
  if (EFFECT_WORDS.some(w => p.includes(w))) return "effect";
  return "character"; // 모호 → 기존(캐릭터) 동작 유지
}

/** classifyAnchor 의 SubjectType 래퍼 — 단위 테스트·호출부 편의용. */
export function inferSubjectType(prompt: string, hasRef: boolean): SubjectType {
  return classifyAnchor(prompt, hasRef) === "effect" ? "effect" : "character";
}

// 보행(locomotion) 키워드 — 발이 교대로 움직여야 하는 동작. 있으면 gait 가이드 주입.
// seamlessLoop 여부와 무관(걷기인데 loop 아니어도 발은 교대해야 함).
const LOCOMOTION_WORDS = [
  "걷기", "걸음", "walk", "walking", "run", "running", "달리기", "뛰기", "뛰는",
  "march", "marching", "행진", "조깅", "jog", "스프린트", "sprint", "질주", "이동", "보행",
];

/**
 * userPrompt 에 보행(걷기·달리기·행진 등) 키워드가 있는지. 순수·결정적.
 * (대소문자 무시. 캐릭터 시트에서만 gait 가이드 주입에 사용 — 호출부가 게이팅.)
 */
export function isLocomotion(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return LOCOMOTION_WORDS.some(w => p.includes(w));
}

/**
 * 프레임 수 인지형 걷기 보행주기(gait) 지시. 캐릭터+보행 시 주입(이펙트엔 X).
 * N(=방향당 프레임 수) 프레임에 한 완전한 보행 주기를 담도록 지시하고, 좌우 발이
 * 확실히 교차(scissor)하도록 강제. 측면(LEFT/RIGHT)·정면/뒷면(DOWN/UP) 모두 다룸.
 * hasDirections=true 면 "모든 행이 같은 N프레임 사이클" 일관성 문구를 추가(방향 시트).
 *
 * loopInstruction 과 통합: seamlessLoop 일 때 server 는 이 gait 만 쓰고 별도 loop 예시는 생략.
 */
export function buildGaitPrompt(framesPerDir: number, hasDirections: boolean): string {
  const n = Math.max(2, framesPerDir);
  const contactB = Math.floor(n / 2) + 1; // 반대 발이 닿는 프레임(대략 사이클 절반)

  // 좌우 발 교대(alternation)가 gait 의 1순위 목표. 사이클의 두 CONTACT 앵커
  // (F1, F(contactB))를 "반대 발이 앞으로" 로 못박고, 그 사이는 PASSING 으로 연결한다.
  // 장황한 per-frame 표 대신 두 앵커 + PASSING 만 명시 → 모델 혼란 최소화.
  return (
    `WALK GAIT — the #1 goal is ALTERNATING FEET. The character must clearly STEP, swapping which foot is forward each half of the cycle. ` +
    `THREE rules, in priority order: ` +
    // ① 좌우 발 교대 (최우선·최강조)
    `(1) ALTERNATION (most important): across these ${n} frames there are two CONTACT poses — at F1 ONE foot is planted FAR FORWARD, and at F${contactB} the OPPOSITE foot is FAR FORWARD (LEFT foot forward in F1, then RIGHT foot forward in F${contactB}, then back to LEFT). The forward foot MUST swap between these two frames; if the same foot leads in both, the walk FAILS. ` +
    // ② 큰 stride
    `(2) BIG STRIDE: in both CONTACT frames the legs are WIDE apart — one leg reaching clearly forward, the other clearly back. Never a narrow upright standing stance. ` +
    // ③ 인접 프레임 구분 (near-duplicate 금지)
    `(3) DISTINCT FRAMES: every frame must differ from its neighbors by LEG POSITION alone. Between the two CONTACT frames the swinging leg PASSES under the body (knees together, briefly a near-single-leg silhouette) and the legs open back out to the opposite contact. NO two frames may look the same; do not draw the same standing pose with small jitter, do not keep a foot static. ` +
    // 측면: scissor 교차 유지
    `SIDE VIEWS (facing LEFT or RIGHT): the legs SCISSOR in profile — in CONTACT frames one leg far forward and one far back, in the between frames they OVERLAP/CROSS under the body. Bend the knees and add a slight up/down body bob. ` +
    // 정면/후면: 다리·발이 망토에 가려지지 않게 + 발 교대 가시화
    `FRONT/BACK VIEWS (facing the viewer or away): the legs and feet must remain CLEARLY VISIBLE below the cape — do not let the cape cover the legs. Clearly alternate which foot steps forward each half-cycle (one foot forward in F1, the other foot forward in F${contactB}), keep the stride wide so both legs read distinctly, and swing the arms oppositely. ` +
    (hasDirections
      ? `Every row uses this SAME ${n}-frame cycle with the SAME alternating-foot phase; ONLY the camera viewing angle differs between rows. `
      : "")
  );
}

/** make_spritesheet 가 지원하는 방향 수. rows = directions 로 강제 매핑. */
export type Directions = 1 | 2 | 4 | 8;

/**
 * 방향 수 → 행별 facing 라벨(위→아래 행 순서). 게임 관례(확정):
 *   2 = 좌, 우 / 4 = 하, 좌, 우, 상 / 8 = 시계방향(down 시작).
 * directions=1 은 단일 방향이라 라벨 없음(빈 배열).
 */
export function directionLabels(n: Directions): string[] {
  switch (n) {
    case 2:
      return ["LEFT", "RIGHT"];
    case 4:
      return ["DOWN (toward viewer)", "LEFT", "RIGHT", "UP (away from viewer)"];
    case 8:
      return [
        "DOWN (toward viewer)",
        "DOWN-LEFT",
        "LEFT",
        "UP-LEFT",
        "UP (away from viewer)",
        "UP-RIGHT",
        "RIGHT",
        "DOWN-RIGHT",
      ];
    default:
      return [];
  }
}

/**
 * 방향 시트용 행별 facing 지시 프롬프트. 캐릭터 시트에서만 의미 있음(이펙트엔 주입 X).
 * 각 행 = 한 방향, 같은 캐릭터·같은 액션 사이클, 행 간엔 카메라 facing 만 다름.
 * directions=1 이면 빈 문자열(단일 방향, 기존 동작).
 */
export function buildDirectionPrompt(n: Directions, framesPerDir: number): string {
  const labels = directionLabels(n);
  if (labels.length === 0) return "";
  const rowLines = labels
    .map((label, i) => `Row ${i + 1}${i === 0 ? " (top)" : ""}: character facing ${label}.`)
    .join(" ");
  return (
    `This is a DIRECTIONAL sheet: each ROW is one facing direction, ` +
    `the SAME character and the SAME ${framesPerDir}-frame action cycle, ` +
    `only the camera facing changes between rows. ` +
    `The image has EXACTLY ${n} horizontal rows (bands), one per direction, stacked top to bottom. ` +
    `Draw ALL ${n} rows — do NOT merge, skip, drop, or compress any row, and do NOT spread the characters into fewer than ${n} rows. ` +
    `Space the ${n} rows at EQUAL vertical intervals so each row occupies one horizontal band of the sheet; there must be ${n} distinct horizontal bands of characters, no more and no fewer. ` +
    `${rowLines} ` +
    `Keep identical character, identical action phase alignment across rows; only the viewing angle differs. `
  );
}
