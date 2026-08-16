/**
 * 동작 텍스트 → 정본 상태명 + 프레임·루프 기본값.
 *
 * **이식이 아니라 우리 UI 를 위한 다리다.** 정본은 request 에 상태 맵을 직접 받지만
 * 우리 패널은 자유 텍스트 동작 하나를 받는다. 그 텍스트에서 정본 어휘를 뽑아내지 않으면
 * 상태명이 `action` 으로 고정되고, 그러면 정본이 상태별로 굳혀 둔 것들이 **하나도
 * 발화하지 않는다**:
 *
 *   - `STATE_REQUIREMENTS`(row-prompt) — walk/run/wave/jump 의 프롬프트 규칙
 *   - `DEFAULT_STATES` 의 상태별 fps (idle 4 · attack/jump 8 · wave 6)
 *   - `classifyState` 의 simple/experimental 등급
 *   - `isLocomotionState` 의 로코모션 게이트
 *
 * 프레임·루프는 정본이 값을 준 상태(`DEFAULT_STATES`)에서 그대로 읽는다 — 진실을 둘로
 * 두지 않는다. 정본이 값을 주지 않은 상태(walk/run/hurt/magic_cast)만 여기서 숫자를
 * 들고 있고, 그 근거를 `states-and-frames.md` 의 프레임 대역에서 가져온다.
 */
import { DEFAULT_STATES } from "@/lib/sprite/request";

export type ActionHint = {
  pattern: RegExp;
  /** 정본 상태명. null 이면 정본이 다루지 않는 동작이다(상태명을 지어내지 않는다). */
  state: string | null;
  frames: number;
  loop: boolean;
};

function canonical(state: keyof typeof DEFAULT_STATES): { state: string; frames: number; loop: boolean } {
  const spec = DEFAULT_STATES[state];
  return { state, frames: spec.frames, loop: spec.loop };
}

/**
 * 첫 매치가 이긴다 — 패널과 서버가 같은 순서로 읽는다.
 *
 * 프레임 대역(`states-and-frames.md`): 4 = 단순 동작 기본, 5 = 대기 복귀 포즈,
 * 6 = 인간형 one-shot 보수적 상한, 8 = 로코모션 행·명시적 실험 전용.
 */
export const ACTION_STATE_HINTS: readonly ActionHint[] = [
  // walk/run 은 정본 experimental 이고 프레임 값도 정본에 없다. 8 은 "로코모션 행"
  // 대역이라 허용된다 — 대신 모션 QA 를 통과하기 전에는 pass 로 보고하지 않는다.
  { pattern: /걷기|보행|walk(ing)?/, state: "walk", frames: 8, loop: true },
  { pattern: /달리기|뛰기|run(ning)?|sprint/, state: "run", frames: 8, loop: true },
  { pattern: /대기|idle|호흡|breath(ing)?|서있/, ...canonical("idle") },
  { pattern: /공격|attack|slash|swing|때리|strike/, ...canonical("attack") },
  { pattern: /점프|jump|도약|leap/, ...canonical("jump") },
  { pattern: /손\s*흔들|인사|wave|greet/, ...canonical("wave") },
  // 정본에 `death` 상태가 없다. 상태명을 지어내지 않고 프레임만 보수적 상한 6 으로 둔다.
  { pattern: /사망|죽음|die|death|fall(ing)? down/, state: null, frames: 6, loop: false },
  // magic_cast·hurt 는 정본 "simple 후보" 다 — 허용하지만 모션 QA 전에는 pass 가 아니고,
  // 프레임 값은 정본에 없다. 로코모션도 실험도 아니므로 8 이 아니라 상한 6 이하로 둔다.
  { pattern: /시전|cast(ing)?|마법|magic|spell|스킬|skill/, state: "magic_cast", frames: 6, loop: false },
  { pattern: /피격|움찔|경직|hurt|flinch|knockback/, state: "hurt", frames: 4, loop: false },
];

/** 동작 텍스트에 맞는 첫 힌트. 없으면 null. */
export function inferActionHint(actionPrompt: string): ActionHint | null {
  const lower = actionPrompt.toLowerCase();
  for (const hint of ACTION_STATE_HINTS) {
    if (hint.pattern.test(lower)) return hint;
  }
  return null;
}
