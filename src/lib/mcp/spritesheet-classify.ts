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

// 오브젝트/아이템 전용 단어 — 캐릭터 단어가 없고 이펙트 단어도 없을 때 object 로 판정.
const OBJECT_WORDS = [
  // 한국어
  "무기", "아이템", "오브젝트", "도구", "물건", "장비", "아이콘",
  "창", "검", "칼", "도끼", "해머", "망치", "활", "지팡이", "봉", "단검",
  "방패", "투구", "보석", "크리스탈", "수정", "동전", "코인",
  "포션", "열쇠", "스크롤", "책", "상자", "보물", "총", "권총", "소총",
  "폭탄", "화살", "탄환", "반지", "목걸이", "부적",
  // English
  "weapon", "item", "object", "tool", "equipment", "icon",
  "sword", "dagger", "spear", "lance", "axe", "mace", "hammer",
  "bow", "staff", "wand", "shield", "helmet", "armor",
  "gem", "crystal", "coin", "potion", "key", "scroll", "chest", "treasure",
  "gun", "pistol", "rifle", "bomb", "arrow", "bullet",
  "ring", "amulet", "necklace", "orb",
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
  const p = prompt.toLowerCase();
  const hasCharWord = CHAR_WORDS.some(w => p.includes(w));
  const hasObjWord = OBJECT_WORDS.some(w => p.includes(w));
  const hasEffectWord = EFFECT_WORDS.some(w => p.includes(w));
  // 참조 이미지 없고, 캐릭터·이펙트 키워드 없고, 오브젝트 키워드만 있으면 object.
  // 이펙트 단어가 있으면 effect 우선 — "검기 트레일"의 검(object) ⊂ 검기(effect) substring 충돌 방지.
  if (!hasRef && hasObjWord && !hasCharWord && !hasEffectWord) return "object";
  return classifyAnchor(prompt, hasRef) === "effect" ? "effect" : "character";
}

// 보행(locomotion) 키워드 — 발이 교대로 움직여야 하는 동작.
const LOCOMOTION_WORDS = [
  "걷기", "걸음", "walk", "walking", "run", "running", "달리기", "뛰기", "뛰는",
  "march", "marching", "행진", "조깅", "jog", "스프린트", "sprint", "질주", "이동", "보행",
];

// 달리기 전용 키워드 — 걷기와 구분해 run.png 참조를 결정할 때 사용.
const RUN_WORDS = [
  "run", "running", "달리기", "뛰기", "뛰는", "스프린트", "sprint", "질주", "조깅", "jog",
];

/** userPrompt 에 보행(걷기·달리기·행진 등) 키워드가 있는지. 순수·결정적. */
export function isLocomotion(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return LOCOMOTION_WORDS.some(w => p.includes(w));
}

/** userPrompt 에 달리기 전용 키워드가 있는지. base.png(걷기) vs run.png(달리기) 분기에 사용. */
export function isRunning(prompt: string): boolean {
  const p = prompt.toLowerCase();
  return RUN_WORDS.some(w => p.includes(w));
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
        "DOWN — walking straight toward the viewer, full front view, both legs visible",
        "DOWN-LEFT — walking diagonally toward viewer-left (3/4 front-left view); body turned ~45° left, treat like a side-left view slightly angled toward the viewer; legs clearly stride forward-left",
        "LEFT — walking directly left, pure side view, legs scissor in profile",
        "UP-LEFT — walking diagonally away from viewer toward upper-left (3/4 back-left view); body turned ~45° left away from viewer; legs clearly stride",
        "UP — walking directly away from viewer, full back view; both feet must peek out below the hem in every frame; legs stride with clear left-right alternation",
        "UP-RIGHT — walking diagonally away from viewer toward upper-right (3/4 back-right view); body turned ~45° right away from viewer; legs clearly stride",
        "RIGHT — walking directly right, pure side view, legs scissor in profile",
        "DOWN-RIGHT — walking diagonally toward viewer-right (3/4 front-right view); body turned ~45° right, treat like a side-right view slightly angled toward the viewer; legs clearly stride forward-right",
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
    `DIAGONAL rows (DOWN-LEFT, DOWN-RIGHT, UP-LEFT, UP-RIGHT) are 3/4 perspective views — draw them like a side view rotated 45°: ` +
    `the character walks at a diagonal angle, legs still scissor with clear stride (one leg forward, one back), ` +
    `body is upright and walking normally (NOT crouching, NOT hunching). ` +
    `BACK-FACING rows (UP, UP-LEFT, UP-RIGHT): both feet must be visible below the costume hem in every frame — ` +
    `the feet peek out as they step, even if the cape is long. ` +
    `Keep identical character, identical action phase alignment across rows; only the viewing angle differs. `
  );
}
