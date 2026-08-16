// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `curation.state_breathe` 이식 — 호흡 사이드카의 정규화·검증.
// 원본: sprite-gen/sprite_gen/curation.py:217-315 (Apache-2.0)

/**
 * 큐레이션에 적힌 호흡 설정을 읽어 **검증을 마친** 형태로 낸다.
 *
 * 호흡은 프레임 선택(깜빡임 등)과 직교하는 변조 레이어다. 변형 수학은 봉투 기반
 * 스쿼시&스트레치이고(`@/lib/sprite/breathe`), 합성/GIF 가 재생 시퀀스 위에
 * 결정론으로 굽는다 — 디스크 프레임은 불변이다.
 *
 * ## 이 모듈의 계약은 "조용히 고치지 않는다" 하나다
 *
 * 정본이 실사고로 얻은 규칙이라 완화하면 안 된다:
 *
 * - **범위 밖은 깎지 않고 멈춘다.** 클램프가 굽기에만 있어서 `breaths` 12 를 8 로
 *   깎는데 프리뷰·필름스트립은 12회 숨쉬고 배지는 "적용 12회" 라고 띄웠다.
 * - **`breaths`·`rigid_row` 는 정수여야 한다.** 2.7 을 파이썬은 2 로 깎고 JS
 *   `Math.round` 는 3 을 내므로 어느 쪽으로 맞춰도 프리뷰와 굽기가 갈린다. 양쪽 다
 *   거부한다.
 * - **폐기된 분할선 스키마 키는 요란하게 거부한다.** 조용히 변환하지 않는다.
 * - **형식 오류도 마찬가지다.** 폐기 키는 요란하게 막으면서 형식 오류만 조용히
 *   호흡을 꺼버리면 계약이 어긋난다 — 둘 다 "이 사이드카는 그대로 못 쓴다" 이고,
 *   조용한 쪽은 사용자가 못 알아챈다.
 */

import type { BreatheConfig } from "@/lib/sprite/breathe";
import type { Anatomy } from "@/lib/sprite/anatomy";

/** 사이드카가 그대로는 못 쓰이는 상태 — 조용히 무시하지 않고 이 예외로 멈춘다. */
export class CurationBreatheInvalid extends Error {}

export const BREATHE_DEPTH_MAX = 0.2;
export const BREATHE_BREATHS_MAX = 8;
export const BREATHE_LAG_MAX = 0.45;

/** 구 분할선 스키마의 키 → 왜 폐기됐는지. 마이그레이션 안내에 그대로 실린다. */
export const RETIRED_BREATHE_KEYS: Record<string, string> = {
  splits: "분할선은 봉투 경계로 대체됐다 — 경계는 자동 검출되고 `rigid_row` 로만 덮어쓴다",
  amplitude: "정수 px 진폭은 몸통 높이 비율 `depth` 로 대체됐다 (기본 0.06)",
  subpixel: "서브픽셀 중간색은 2상태 토글을 보정하려던 것이라 연속 위상에서 의미가 없다",
  hold: "구 분할선 스키마의 유지 프레임 수 — 위상이 연속이라 유지 개념이 없다",
};

/**
 * 파이썬 `repr()` — 에러 문구를 정본과 글자까지 같게 하기 위한 것.
 *
 * 문자열은 작은따옴표로 감싸고, 숫자는 그대로 쓴다. 정본과 문구가 갈리면 교차 대조가
 * 성립하지 않는다(`frame-qa` 의 `pyFormat0` 과 같은 이유).
 */
function pyRepr(value: unknown): string {
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

/**
 * 파이썬 `repr()` 중 **float 인 줄 아는 값**용 — `1` 이 아니라 `1.0` 으로 찍는다.
 *
 * JS 는 정수값 float 와 int 를 구분하지 못하는데 파이썬 문구는 구분한다. `depth`·
 * `lag`·`depth_x` 는 `float()` 를 거쳐 항상 float 이고 `breaths` 는 항상 int 라,
 * 어느 쪽인지는 호출부가 안다.
 */
function pyFloatRepr(value: number): string {
  return Number.isInteger(value) && Number.isFinite(value) ? `${value}.0` : String(value);
}

/** 파이썬 `type(x).__name__` — `float()` 의 TypeError 문구에 실린다. */
function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return "NoneType";
  if (Array.isArray(value)) return "list";
  if (typeof value === "object") return "dict";
  if (typeof value === "boolean") return "bool";
  if (typeof value === "number") return Number.isInteger(value) ? "int" : "float";
  return typeof value;
}

/**
 * 파이썬 `float()` — 숫자와 **숫자 문자열**만 받고 나머지는 던진다.
 *
 * `Number()` 를 그대로 쓰면 `""`·`null`·`[]` 가 전부 0 이 되는데 파이썬은 셋 다
 * 예외다. 반대로 `float("inf")` 는 파이썬에서 무한대라 범위 검사에서 걸리지만
 * `Number("inf")` 는 NaN 이다 — 사이드카는 JSON 이고 JSON 에 inf/nan 리터럴이
 * 없으므로 이 차이는 도달 불가능하다.
 */
function pyFloat(value: unknown): number {
  if (typeof value === "number") {
    if (Number.isNaN(value)) throw new TypeError("nan");
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") throw new TypeError(`could not convert string to float: ${pyRepr(value)}`);
    const n = Number(trimmed);
    if (!Number.isFinite(n)) {
      throw new TypeError(`could not convert string to float: ${pyRepr(value)}`);
    }
    return n;
  }
  throw new TypeError(
    `float() argument must be a string or a real number, not '${pyTypeName(value)}'`,
  );
}

/**
 * 정수만 받는다 — 2.7 이나 "3.5" 를 조용히 깎지 않는다.
 *
 * 파이썬 `int()` 는 2.7 을 2 로 깎고, JS `Math.round` 는 3 을 낸다. 어느 쪽으로
 * 맞추든 조용히 깎는 순간 프리뷰와 굽기가 갈리므로 **양쪽 다 거부**한다.
 */
function exactInt(name: string, value: unknown, state: string): number {
  let number: number;
  try {
    number = pyFloat(value);
  } catch {
    throw new CurationBreatheInvalid(
      `curation: states.${state}.breathe.${name} 을 숫자로 못 읽는다: ${pyRepr(value)}`,
    );
  }
  if (number !== Math.trunc(number)) {
    throw new CurationBreatheInvalid(
      `curation: states.${state}.breathe.${name} = ${pyRepr(value)} 가 정수가 아니다. ` +
        `조용히 깎지 않는다 — 프리뷰는 반올림하고 굽기는 버려서 서로 다른 애니메이션이 된다.`,
    );
  }
  return Math.trunc(number);
}

/** 큐레이션 한 상태분 — 우리는 생성물 row 하나가 상태 하나라 `states` 계층이 없다. */
export type BreatheSidecar = { breathe?: unknown } | null | undefined;

/**
 * 상태의 호흡 후처리 레이어 설정 (없으면 `null`) — 정규화·검증 포함.
 *
 * 정본은 `curation.states.<state>.breathe` 를 읽지만 우리 큐레이션은 생성물 row
 * 하나가 곧 상태 하나라 그 계층이 없다. `state` 는 에러 문구를 정본과 맞추기 위한
 * 이름일 뿐이다.
 */
export function stateBreathe(entry: BreatheSidecar, state: string): BreatheConfig | null {
  if (!entry) return null;
  const raw = entry.breathe;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;

  const retired = Object.keys(RETIRED_BREATHE_KEYS)
    .filter((k) => k in rec)
    .sort();
  if (retired.length > 0) {
    const detail = retired.map((k) => `  - ${k}: ${RETIRED_BREATHE_KEYS[k]}`).join("\n");
    throw new CurationBreatheInvalid(
      `curation: states.${state}.breathe 에 폐기된 분할선 스키마 키가 있다: ${retired.join(", ")}\n` +
        `${detail}\n` +
        `  마이그레이션: 해당 키를 지우고 \`depth\`(기본 0.06)·\`breaths\`·\`lag\`(기본 0.10) 로 ` +
        `다시 적어라. 조용히 변환하지 않는다.`,
    );
  }

  // 형변환 계약: depth/lag 는 실수(숫자 문자열 허용), breaths/rigid_row 는 **정수여야 한다**.
  let depth: number;
  let depthX: number | null;
  let lag: number;
  try {
    depth = pyFloat("depth" in rec ? rec.depth : 0.06);
    // 가로 독립 진폭: null/부재 = depth 따름(레거시 동일), 0 = 가로 사상 항등.
    // depth 와 달리 0 이 유효하다 — "가로만 끄기" 가 정당한 상태다.
    const rawDx = rec.depth_x;
    depthX = rawDx === null || rawDx === undefined ? null : pyFloat(rawDx);
    lag = pyFloat("lag" in rec ? rec.lag : 0.1);
  } catch (exc) {
    throw new CurationBreatheInvalid(
      `curation: states.${state}.breathe 의 depth/breaths/lag 를 숫자로 못 읽는다: ` +
        `${exc instanceof Error ? exc.message : String(exc)}\n` +
        `  받은 값: depth=${pyRepr(rec.depth)} breaths=${pyRepr(rec.breaths)} lag=${pyRepr(rec.lag)}`,
    );
  }
  // 정본은 이 호출이 try 안에 있지만 SystemExit 은 잡히지 않는다 — 즉 exactInt 의
  // 메시지가 그대로 나간다. 밖에 두어 같은 문구가 나오게 한다.
  const breaths = exactInt("breaths", "breaths" in rec ? rec.breaths : 1, state);

  // 마지막 플래그는 "이 값이 파이썬에서 float 인가" 다 — 문구가 `0` 과 `0.0` 을
  // 구분하므로 표시에 필요하다. breaths 만 int 다.
  const ranged: Array<[string, number, number, number, boolean]> = [
    ["depth", depth, 0.005, BREATHE_DEPTH_MAX, true],
    ["breaths", breaths, 1, BREATHE_BREATHS_MAX, false],
    ["lag", lag, 0.0, BREATHE_LAG_MAX, true],
  ];
  if (depthX !== null) ranged.push(["depth_x", depthX, 0.0, BREATHE_DEPTH_MAX, true]);
  for (const [name, value, lo, hi, isFloat] of ranged) {
    if (!(lo <= value && value <= hi)) {
      const show = isFloat ? pyFloatRepr : (v: number) => String(v);
      throw new CurationBreatheInvalid(
        `curation: states.${state}.breathe.${name} = ${show(value)} 가 범위 [${show(lo)}, ${show(hi)}] 밖이다. ` +
          `조용히 깎지 않는다 — 사이드카를 고쳐라 (큐레이터 컨트롤은 이 범위 안에서만 값을 낸다).`,
      );
    }
  }

  const rigidRow = rec.rigid_row === null || rec.rigid_row === undefined
    ? null
    : exactInt("rigid_row", rec.rigid_row, state);
  // 영역 조정 오버라이드: rigid_row 와 같은 지위의 사람 의도 입력이다 — anatomy 는
  // 파생 캐시일 뿐이다. 범위 검증은 프레임을 아는 anatomy.analyze 가 한다(여기선 정수성만).
  const axisX = rec.axis_x === null || rec.axis_x === undefined
    ? null
    : exactInt("axis_x", rec.axis_x, state);
  const torsoHalf = rec.torso_half === null || rec.torso_half === undefined
    ? null
    : exactInt("torso_half", rec.torso_half, state);
  const frozen = rec.anatomy;

  return {
    depth,
    depth_x: depthX,
    breaths,
    lag,
    rigid_row: rigidRow,
    axis_x: axisX,
    torso_half: torsoHalf,
    anatomy:
      frozen && typeof frozen === "object" && !Array.isArray(frozen)
        ? (frozen as Partial<Anatomy>)
        : null,
  };
}
