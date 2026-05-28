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
    `only the camera facing changes between rows. ${rowLines} ` +
    `Keep identical character, identical action phase alignment across rows; only the viewing angle differs. `
  );
}
