/**
 * 방향 계약 — sprite_gen/prepare.py 의 directions 블록 이식.
 *
 * base = down(정면) 기본자세 하나. 방향 앵커(`<dir>_<anchorSuffix>`)를 base 에서 먼저
 * 뽑고, 각 행은 자기 방향 앵커를 identity 로 생성한다
 * (sprite-gen docs/directional-anchor-workflow.md).
 *
 * 순수 모듈 — sharp·fs·DB 를 모른다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
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
 * DOWN/UP/LEFT/RIGHT/대각선 8종을 정본 어휘로 옮긴다.
 *
 * **대각선은 `down45`/`up45` 다.** 정본이 등록해 둔 45도 토큰이 그 둘뿐이고, 좌/우
 * 구분은 방향이 아니라 **상태명 접미사**(`-front-right`)가 지고 있기 때문이다
 * (`directional_requirements`). 예전에 쓰던 `front-right` 같은 토큰은 정본
 * `DIRECTION_FACING` 에 없어서 두 경로를 모두 비껴갔다 — 접두사 경로는 폴백 문구
 * ("facing the front-right direction")만 내고, 접미사 경로는 상태명이 접미사로 끝나지
 * 않아 아예 발화하지 않았다. 정본도 미등록 토큰에 같은 폴백을 쓰므로(prepare.py:700)
 * 어긋난 동작은 아니었지만, 45도 잠금을 하나도 못 받는 상태였다.
 *
 * 그 결과 `DOWN-RIGHT` 와 `DOWN-LEFT` 는 방향(=앵커)을 공유하고 행마다 좌/우가 갈린다.
 * 정본의 좌우 쌍 절차(basis 먼저 → paired 에 basis 를 gait 참조로 부착)와 같은 구조다.
 *
 * null = 방향 계약을 걸지 않는다. REF 는 참조 이미지의 방향을 그대로 따르는 모드다.
 */
const UI_TO_SPRITE_GEN: Record<string, string> = {
  DOWN: "down",
  UP: "up",
  RIGHT: "right",
  LEFT: "left",
  "DOWN-RIGHT": "down45",
  "DOWN-LEFT": "down45",
  "UP-RIGHT": "up45",
  "UP-LEFT": "up45",
};

/**
 * UI 방향 → 정본 45도 상태명 접미사. 4방위는 null(접미사 없음).
 * 이 접미사가 붙어야 `directionalRequirements` 의 3/4 뷰 잠금이 발화한다.
 */
const UI_TO_SIDE_SUFFIX: Record<string, string> = {
  "DOWN-RIGHT": "-front-right",
  "DOWN-LEFT": "-front-left",
  "UP-RIGHT": "-back-right",
  "UP-LEFT": "-back-left",
};

export function toSpriteGenDirection(ui: string): string | null {
  return UI_TO_SPRITE_GEN[ui] ?? null;
}

export function toSideSuffix(ui: string): string {
  return UI_TO_SIDE_SUFFIX[ui] ?? "";
}
