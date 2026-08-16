/**
 * 방향 계약 — sprite_gen/prepare.py 의 directions 블록 이식.
 *
 * base = down(정면) 기본자세 하나. 방향 앵커(`<dir>_<anchorSuffix>`)를 base 에서 먼저
 * 뽑고, 각 행은 자기 방향 앵커를 identity 로 생성한다
 * (sprite-gen docs/directional-anchor-workflow.md).
 *
 * 순수 모듈 — sharp·fs·DB 를 모른다.
 */
import type { DirectionsSpec, StateSpec } from "@/lib/sprite/request";

export type { DirectionsSpec };

export type RawDirections = {
  set?: unknown[];
  mirror?: Record<string, unknown> | null;
  anchor_suffix?: string;
};

/**
 * 45도 계열(`front-right` 등)이 여기 없는 것은 의도다 — 폴백 문구가 나가고 세부는
 * 상태명 접미사 경로(row-prompt 의 directionalRequirements)가 채운다.
 */
export const DIRECTION_FACING: Record<string, string> = {
  down: "facing the viewer (front view)",
  up: "facing away from the viewer (back view, no visible face)",
  side: "pure side profile view facing camera-right",
  right: "pure side profile view facing camera-right",
  left: "pure side profile view facing camera-left",
  down45: "45-degree three-quarter-front view",
  up45: "45-degree three-quarter-back view",
};

export function facingOf(direction: string): string {
  return DIRECTION_FACING[direction] ?? `facing the ${direction} direction`;
}

/** null = 방향 계약 없음(기존 flat 런). */
export function normalizeDirections(
  raw: RawDirections | null | undefined,
  states: Record<string, unknown>,
): DirectionsSpec | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const set = (raw.set ?? []).map(d => String(d));
  if (set.length === 0) {
    throw new Error("normalizeDirections: directions.set must list at least one direction");
  }
  const mirror: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.mirror ?? {})) mirror[String(k)] = String(v);
  for (const [target, source] of Object.entries(mirror)) {
    if (!set.includes(source)) {
      throw new Error(`normalizeDirections: mirror source '${source}' is not in directions.set`);
    }
    if (set.includes(target)) {
      throw new Error(
        `normalizeDirections: mirror target '${target}' must not also be a generated direction`,
      );
    }
  }
  const anchorSuffix = String(raw.anchor_suffix ?? "idle");
  // 방향 계약 런은 상태명이 <direction>_<state> 여야 한다 — 아니면 fail-loud.
  // 어느 행이 어느 방향의 앵커에서 identity 를 받아야 하는지가 이름으로만 결정되므로,
  // 이름이 어긋나면 앵커 없이 행이 생성된다.
  for (const state of Object.keys(states)) {
    if (!set.some(d => state.startsWith(d + "_"))) {
      throw new Error(
        `normalizeDirections: state '${state}' does not start with a declared direction prefix ` +
          `(${set.join(", ")}) — direction-contract runs name states <direction>_<state>`,
      );
    }
  }
  return { set, mirror, anchorSuffix };
}

/** direction → 앵커 상태명 (`<dir>_<anchorSuffix>`). */
export function directionAnchorStates(directions: DirectionsSpec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of directions.set) out[d] = `${d}_${directions.anchorSuffix}`;
  return out;
}

/**
 * 방향 앵커 상태가 요청에 없으면 합성해 **앞에** 끼운다 — 앵커 없는 방향 행 생성 금지.
 * 4프레임인 것은 정본의 단순 동작 기본 안정 범위와 같다 (states-and-frames.md).
 */
export function ensureDirectionAnchors(
  directions: DirectionsSpec,
  states: Record<string, StateSpec>,
): Record<string, StateSpec> {
  const synthesized: Record<string, StateSpec> = {};
  for (const [direction, anchor] of Object.entries(directionAnchorStates(directions))) {
    if (anchor in states) continue;
    synthesized[anchor] = {
      frames: 4,
      fps: 4,
      loop: true,
      action: `standing idle, ${facingOf(direction)}; subtle breathing; canonical direction anchor derived from the base`,
    };
  }
  return { ...synthesized, ...states };
}

export function stateDirection(state: string, directions: DirectionsSpec | null): string | null {
  if (!directions) return null;
  return directions.set.find(d => state.startsWith(d + "_")) ?? null;
}

/**
 * 방향 접두사를 뗀 상태명 — `down_run` → `run`.
 *
 * 정본은 상태명 자체가 `running-right` 처럼 방향을 품고 있어 이 함수가 없다. 우리는
 * `<direction>_<state>` 로 분리해 두었으므로(③ normalizeDirections), 정본의 상태 어휘를
 * 보는 판정(`classifyState`·`isLocomotionState`·`STATE_REQUIREMENTS`)에 넘기기 전에
 * 접두사를 떼어야 한다.
 */
export function bareState(state: string, directions: DirectionsSpec | null): string {
  const direction = stateDirection(state, directions);
  return direction === null ? state : state.slice(direction.length + 1);
}

/**
 * UI 방향 어휘 → sprite-gen 토큰. **이식이 아니라 신규 코드다** — 우리 패널의
 * DOWN/UP/LEFT/RIGHT/대각선 8종을 정본 어휘로 옮긴다. 내부를 정본 어휘로 통일해야
 * 이식한 두 요구사항 함수(접두사 계약·45도 접미사 규약)가 문구 수정 없이 돈다.
 *
 * null = 방향 계약을 걸지 않는다. REF 는 참조 이미지의 방향을 그대로 따르는 모드다.
 */
const UI_TO_SPRITE_GEN: Record<string, string> = {
  DOWN: "down",
  UP: "up",
  RIGHT: "right",
  LEFT: "left",
  "DOWN-RIGHT": "front-right",
  "DOWN-LEFT": "front-left",
  "UP-RIGHT": "back-right",
  "UP-LEFT": "back-left",
};

export function toSpriteGenDirection(ui: string): string | null {
  return UI_TO_SPRITE_GEN[ui] ?? null;
}
