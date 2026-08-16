/**
 * SpriteRequest — 스프라이트 런의 숫자형 SSoT.
 *
 * sprite-gen `sprite_gen/prepare.py` 의 normalize_cell / normalize_states 이식.
 * 셀 기하·상태 정의를 프롬프트 문자열에서 매번 재해석하지 않고 한 객체가 소유한다.
 *
 * 이 모듈은 순수하다 — sharp·fs·DB 를 import 하지 않는다. 크로마 키 자동 선택은
 * 이미지 IO 가 필요하므로 chroma-key.ts 가 맡는다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 픽셀 수가 아니라 비율이다 — 9.4% 는 모든 셀 크기에서 같은 상대 여백을 남긴다
 * (256 → 24px, 128 → 12px). 요청·CLI 의 명시값은 절대값으로 그대로 이긴다.
 */
export const DEFAULT_SAFE_MARGIN_RATIO = 0.094;
export const DEFAULT_CELL_SIZE = 256;

export type CellSpec = {
  shape: "square" | "rect";
  width: number;
  height: number;
  safeMarginX: number;
  safeMarginY: number;
};

/** normalizeCell 입력. sprite-gen 이 받아주는 별칭 키를 모두 허용한다. */
export type RawCell = {
  size?: number;
  width?: number;
  height?: number;
  cell_width?: number;
  cell_height?: number;
  safe_margin?: number;
  safe_margin_x?: number;
  safe_margin_y?: number;
};

export type StateSpec = { frames: number; fps: number; loop: boolean; action: string };

export type ChromaKeySpec = {
  name: string;
  hex: string;
  rgb: [number, number, number];
  selection: "auto" | "manual" | "fallback";
  score?: number;
  minSubjectDistance?: number;
  selectionReason?: string;
  warning?: string;
};

export type ChromaTunables = {
  mode: "rgb";
  keyThreshold: number;
  unmixReach: number;
  spillMaxFraction: number;
};

/**
 * 추출기가 유효값을 request 에 되쓰기 때문에 request 가 튜너블을 소유한다 —
 * 어떤 파라미터가 그 결과를 만들었는지 런마다 기록에 남는다.
 * `mode: "rgb"` 가 기본이다. ycbcr 은 열화된 소스용 옵트인이다.
 */
export const DEFAULT_CHROMA_TUNABLES: ChromaTunables = {
  mode: "rgb",
  keyThreshold: 96,
  unmixReach: 4,
  spillMaxFraction: 0.005,
};

/**
 * 방향 계약. `set` 의 각 방향마다 `<dir>_<anchorSuffix>` 앵커 상태가 존재해야 하고,
 * `mirror` 에 오른 방향은 생성을 생략하고 런타임 미러로 커버한다.
 * 정규화는 `directions.ts` 가 소유한다 — 여기 있는 것은 타입뿐이다(순환 방지).
 */
export type DirectionsSpec = {
  set: string[];
  mirror: Record<string, string>;
  anchorSuffix: string;
};

export type SpriteRequest = {
  version: 1;
  character: { id: string; description: string; anchorGenerationId: string };
  cell: CellSpec;
  chromaKey: ChromaKeySpec;
  chroma: ChromaTunables;
  states: Record<string, StateSpec>;
  /** 없으면(undefined) 기존 flat 런 — 방향 계약을 걸지 않는다. */
  directions?: DirectionsSpec;
};

export const DEFAULT_STATES: Record<string, StateSpec> = {
  idle: { frames: 4, fps: 4, loop: true, action: "subtle breathing and blinking" },
  attack: {
    frames: 4,
    fps: 8,
    loop: false,
    action: "simple windup, strike, recovery attack pose sequence with no detached effects",
  },
  jump: { frames: 4, fps: 8, loop: false, action: "jump arc through body position only" },
  wave: {
    frames: 4,
    fps: 6,
    loop: false,
    action: "friendly hand wave gesture; arm changes clearly while feet stay planted",
  },
};

function pick(...values: Array<number | undefined>): number | undefined {
  for (const v of values) if (v !== undefined) return v;
  return undefined;
}

export function normalizeCell(
  raw: RawCell,
  size: number = DEFAULT_CELL_SIZE,
  safeMargin?: number | null,
): CellSpec {
  const width = Math.trunc(pick(raw.width, raw.cell_width, raw.size, size) as number);
  const height = Math.trunc(pick(raw.height, raw.cell_height, raw.size, size) as number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("normalizeCell: cell width and height must be positive");
  }

  const rawMarginX = pick(raw.safe_margin_x, raw.safe_margin, safeMargin ?? undefined);
  const rawMarginY = pick(raw.safe_margin_y, raw.safe_margin, safeMargin ?? undefined);
  // Python int() 는 0 방향 절삭이고 치수는 양수이므로 floor 와 같다.
  const marginX =
    rawMarginX === undefined
      ? Math.floor(width * DEFAULT_SAFE_MARGIN_RATIO)
      : Math.trunc(rawMarginX);
  const marginY =
    rawMarginY === undefined
      ? Math.floor(height * DEFAULT_SAFE_MARGIN_RATIO)
      : Math.trunc(rawMarginY);

  if (marginX < 0 || marginY < 0 || marginX * 2 >= width || marginY * 2 >= height) {
    throw new Error(
      `normalizeCell: safe margins must fit inside the cell (${marginX}x${marginY} in ${width}x${height})`,
    );
  }

  return {
    shape: width === height ? "square" : "rect",
    width,
    height,
    safeMarginX: marginX,
    safeMarginY: marginY,
  };
}

export function normalizeStates(
  raw: Record<string, Partial<StateSpec>> | null,
): Record<string, StateSpec> {
  const source: Record<string, Partial<StateSpec>> = raw ?? DEFAULT_STATES;
  const out: Record<string, StateSpec> = {};
  for (const [state, entry] of Object.entries(source)) {
    const frames = Math.trunc(entry.frames ?? 0);
    if (!Number.isFinite(frames) || frames <= 0) {
      throw new Error(`normalizeStates: state '${state}' must have positive frames`);
    }
    const fallback = DEFAULT_STATES[state] as StateSpec | undefined;
    out[state] = {
      frames,
      fps: Math.trunc(entry.fps ?? fallback?.fps ?? 6),
      // 원본 그대로(prepare.py:509): 폴백은 무조건 true 다. DEFAULT_STATES 의
      // attack/jump/wave(loop:false)와 어긋나 보이지만, loop 은 UX 가 항상 명시로
      // 넘기는 변수이므로 폴백이 실제로 쓰이지 않는다. 원본과 다르게 두지 않는다.
      loop: entry.loop ?? true,
      action: entry.action ?? fallback?.action ?? state,
    };
  }
  return out;
}

/* --- 상태 등급과 프레임 수 대역 (sprite-gen docs/states-and-frames.md) ------- */

export type StateClass = "simple" | "simple-candidate" | "experimental" | "unknown";

const SIMPLE_STATES = new Set(["idle", "jump", "attack", "wave"]);
const SIMPLE_CANDIDATES = new Set(["talk", "blink", "bounce", "hurt", "celebrate", "magic_cast"]);
const EXPERIMENTAL_STATES = new Set(["walk", "run", "frontwalk", "45_frontwalk"]);
const EXPERIMENTAL_PREFIXES = ["running-", "walking-"];

/**
 * 정본은 주기적 이동을 simple MVP 산출물과 같은 등급으로 승격하지 말라고 못박는다.
 * `unknown` 은 "안전"이 아니라 "정본이 분류하지 않았다"는 뜻이다 — 호출자가 판단한다.
 */
export function classifyState(state: string): StateClass {
  if (SIMPLE_STATES.has(state)) return "simple";
  if (SIMPLE_CANDIDATES.has(state)) return "simple-candidate";
  if (EXPERIMENTAL_STATES.has(state)) return "experimental";
  if (EXPERIMENTAL_PREFIXES.some(p => state.startsWith(p))) return "experimental";
  return "unknown";
}

/**
 * 주기적 이동인가 — `prepare.py:state_motion_phases()` 의 멤버십 판정 이식.
 *
 * 정본 체크리스트 3번이 여기에 걸린다: 로코모션 행에는 단일 피크 포즈 상태 앵커를
 * **넣지 않는다**. 한 접지 포즈가 모든 프레임의 다리 위상을 그 하나로 고정하기
 * 때문이다. 로코모션에는 양쪽 접지가 다 보이는 모션 위상 참조(접촉 시트·선택 사이클·
 * 레이아웃 페이즈 가이드)가 필요하다.
 *
 * 인자는 **방향 접두사를 뗀 상태명**이다(`down_run` 이 아니라 `run`).
 */
const LOCOMOTION_STATES = new Set(["running-right", "running-left", "run", "walk"]);
const LOCOMOTION_PREFIXES = ["running-front-", "running-back-", "walking-front-", "walking-back-"];

export function isLocomotionState(state: string): boolean {
  if (LOCOMOTION_STATES.has(state)) return true;
  return LOCOMOTION_PREFIXES.some(p => state.startsWith(p));
}

export type FrameBand =
  | "default"
  | "return-to-idle"
  | "conservative-edge"
  | "advanced"
  | "not-default"
  | "unspecified";

export type FrameAdvice = { band: FrameBand; note: string };

/** 정본이 명시한 대역만 돌려준다. 나머지는 unspecified — 없는 근거를 지어내지 않는다. */
export function frameCountAdvice(frames: number): FrameAdvice {
  switch (frames) {
    case 4:
      return { band: "default", note: "단순 동작의 기본 안정 범위" };
    case 5:
      return { band: "return-to-idle", note: "비루프 제스처가 대기 복귀 포즈를 가질 때만" };
    case 6:
      return { band: "conservative-edge", note: "인간형 one-shot 기본값의 보수적 상한" };
    case 8:
      return {
        band: "advanced",
        note: "hatch-pet 급 고급 영역 — 컴팩트 마스코트·로코모션 행·명시적 실험에만. 추출·모션 QA 통과가 조건",
      };
    case 9:
    case 12:
      return {
        band: "not-default",
        note: "기본값이 아니다 — 검증 런에서 duplicate bodies·빈 프레임·슬롯 붕괴·추출 실패가 늘었다. 명시적 실험으로 돌리고 결과를 정직하게 보고할 것",
      };
    default:
      return { band: "unspecified", note: "정본이 이 프레임 수를 다루지 않는다" };
  }
}
