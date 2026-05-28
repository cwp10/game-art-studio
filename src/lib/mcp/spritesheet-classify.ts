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

  // 프레임별 다리 상태 표 — contact(WIDE) ↔ passing(crossing) 교대.
  // 두 contact(F1, F(contactB))를 앵커로 잡고, 그 사이를 passing→swing 보간으로 채운다.
  // 측면 기준 좌/우 발의 전후 위치를 프레임마다 명시해 모델이 near-duplicate 를 못 내게 강제.
  const frameLines: string[] = [];
  for (let f = 1; f <= n; f++) {
    if (f === 1) {
      frameLines.push(
        `F1 CONTACT — front leg fully extended FORWARD (heel strike), back leg fully extended BEHIND (toe off); legs WIDE apart, maximum stride.`,
      );
    } else if (f === contactB) {
      frameLines.push(
        `F${f} CONTACT (mirror of F1) — the OTHER leg now fully FORWARD, the previously-front leg now BEHIND; legs WIDE apart, maximum stride, opposite of F1.`,
      );
    } else if (f < contactB) {
      // F1 → contactB 사이: 앞다리가 닫히고 뒷다리가 몸 아래로 올라오는 first-half passing.
      const half = (f - 1) / (contactB - 1); // 0..1
      frameLines.push(
        half < 0.5
          ? `F${f} PUSH-OFF — back leg lifts off the ground and starts swinging forward; front leg bears weight; stance narrowing from F1.`
          : `F${f} PASSING — the swinging leg crosses UNDER the torso, both knees close together and overlapping in profile; nearly single-leg silhouette.`,
      );
    } else {
      // contactB → N 사이: mirror half 의 push-off/passing(F1 으로 다시 닫힘).
      const half = (f - contactB) / (n - contactB + 1); // 0..1
      frameLines.push(
        half < 0.5
          ? `F${f} PUSH-OFF (mirror) — the other back leg lifts and swings forward; opposite weight-bearing leg from the first half.`
          : `F${f} PASSING (mirror) — legs cross UNDER the torso again, knees overlapping; this pose flows straight back into F1.`,
      );
    }
  }

  return (
    `WALK/RUN GAIT (CRITICAL — every frame MUST be a DISTINCTLY different leg pose): ` +
    `Across these ${n} frames depict ONE full walk cycle as a strict per-frame leg choreography. ` +
    `Use this EXACT per-frame leg phase: ${frameLines.join(" ")} ` +
    // 차별화 강제 — near-duplicate 금지.
    `DIFFERENTIATION (non-negotiable): NO two frames may look the same or near-duplicate. ` +
    `If any two frames have a similar leg pose the animation FAILS — each frame must be visibly distinguishable by leg position alone. ` +
    `Do NOT keep a foot static, do NOT merely twitch one leg, do NOT draw the same standing pose with small jitter. ` +
    // stride 크기 강제.
    `STRIDE: in the CONTACT frames the legs must be WIDE apart with a LARGE stride — clearly one leg forward and one leg back, never a narrow upright stance. ` +
    // 측면 crossing 강조.
    `SIDE VIEWS (facing LEFT or RIGHT): the legs SCISSOR in profile — in CONTACT frames one leg reaches far forward and the other far back; ` +
    `in PASSING frames the two legs visually OVERLAP/CROSS under the body so it briefly looks like a single leg. Bend the knees; add a slight up/down body bob through the cycle. ` +
    // front/back view 좌우 다리 교대.
    `FRONT/BACK VIEWS (facing the viewer or away): alternate which leg steps forward each half-cycle (front leg in F1, opposite leg in F${contactB}), swing the arms oppositely, and add the same slight up/down body bob. ` +
    (hasDirections
      ? `Every row uses this SAME ${n}-frame per-frame leg choreography and the SAME phase alignment; ONLY the camera viewing angle differs between rows. `
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
    `only the camera facing changes between rows. ${rowLines} ` +
    `Keep identical character, identical action phase alignment across rows; only the viewing angle differs. `
  );
}
