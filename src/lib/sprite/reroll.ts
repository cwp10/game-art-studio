// SPDX-License-Identifier: Apache-2.0
//
// sprite-gen `reroll.py` 이식 — 행을 새 테이크로 다시 생성(후보 추가, 교체 아님).
// 원본: sprite-gen/sprite_gen/reroll.py (Apache-2.0)

/**
 * 한 상태의 행을 **한 번 더 생성해 후보로 병기한다.**
 *
 * 정본의 계약이 "교체가 아니라 후보 추가" 라는 점이 핵심이다 — 기존 행은 그대로 두고
 * 새 테이크를 옆에 쌓는다. 어느 것을 쓸지 **픽/기각은 사람 몫**이다. 마음에 안 드는
 * 행을 눌러 덮어쓰는 버튼이었다면 되돌릴 수가 없다.
 *
 * ## 우리 구조로의 대응
 *
 * 정본은 테이크를 `raw/<state>.takes/rerollN.png` 파일과 request `states.<state>.takes`
 * 선언으로 기록하고, 추출이 그 풀을 하나로 합쳐 굽는다. 그 병합은 **런 전체 공유
 * 팔레트**를 전제로 하므로 정본은 픽셀 언페이크가 꺼진 런에서 리롤을 아예 거부한다
 * (생성비를 쓰기 전에 막는다).
 *
 * 우리에겐 그 팔레트 계층이 없고, 행 하나가 이미 독립된 generation 이다. 그래서 테이크를
 * **후보 generation 목록**으로 둔다:
 *
 *     params.rowTakes[state] = [{ label, generationId, frames }, ...]
 *     params.rowGenerationIds[state] = 지금 합성에 쓰는 것
 *
 * 고르기는 `rowGenerationIds` 를 바꾸고 재합성하는 것뿐이라 스키마가 늘지 않고, 기존
 * 행도 후보 목록에 그대로 남아 언제든 되돌릴 수 있다.
 */

/** 한 상태의 행 후보 하나. */
export type RowTake = {
  /** `reroll1`, `reroll2` … 또는 사람이 지정한 라벨. */
  label: string;
  /** 이 테이크의 행 generation. */
  generationId: string;
  /** 그 행이 담은 프레임 수. */
  frames: number;
};

export class RerollFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RerollFailed";
  }
}

/**
 * 다음 리롤 라벨 — `reroll1` 부터 **비어 있는 가장 작은 번호**.
 *
 * 정본과 같이 `reroll<숫자>` 에 정확히 맞는 라벨만 센다. 사람이 붙인 다른 라벨
 * (`tween_1_2_t0p5` 등)이 섞여 있어도 번호 계산을 방해하지 않는다. 결번이 있으면
 * 그 자리를 채운다 — 삭제한 테이크의 번호가 영구히 비지 않는다.
 */
export function nextRerollLabel(takes: readonly { label?: string | null }[] | null | undefined): string {
  const used = new Set<number>();
  for (const take of takes ?? []) {
    const m = /^reroll(\d+)$/.exec(String(take?.label ?? ""));
    if (m) used.add(Number(m[1]));
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return `reroll${n}`;
}

/** 파일명으로 쓸 수 있는 라벨인가 — 정본과 같은 거부 조건. */
export function assertSafeTakeLabel(label: string): void {
  if (label.includes("/") || label.startsWith(".")) {
    throw new RerollFailed(`take label must be filesystem-safe: '${label}'`);
  }
}

/**
 * 테이크 목록에 하나를 기록한다 (멱등) — 같은 라벨이면 덮어쓴다.
 *
 * 정본 `record_take` 와 같은 계약이다. 정본은 생성이 수 분 걸리는 동안 다른 변경이
 * 끼어드는 것을 락 안 fresh 재독으로 막는데, 우리는 이 함수가 **순수**하고 호출자가
 * 방금 읽은 목록을 넘기므로 같은 문제를 호출부에서 다룬다.
 */
export function recordTake(takes: readonly RowTake[] | null | undefined, entry: RowTake): RowTake[] {
  const out = [...(takes ?? [])];
  const at = out.findIndex(t => t.label === entry.label);
  if (at >= 0) out[at] = entry;
  else out.push(entry);
  return out;
}

/**
 * 지금 합성에 쓰는 행이 후보 목록에 없으면 **원본(`primary`)으로 넣어준다.**
 *
 * 첫 리롤 직후에 목록이 새 테이크 하나뿐이면 원래 행으로 되돌릴 방법이 사라진다 —
 * 후보 추가라는 계약이 깨진다. 그래서 리롤 기록 시 현재 행을 함께 등재한다.
 */
export function ensurePrimaryTake(
  takes: readonly RowTake[] | null | undefined,
  currentGenerationId: string,
  frames: number,
): RowTake[] {
  const list = [...(takes ?? [])];
  if (list.some(t => t.generationId === currentGenerationId)) return list;
  return [{ label: "primary", generationId: currentGenerationId, frames }, ...list];
}

/** 라벨로 후보를 찾는다. 없으면 던진다 — 조용히 현재 행을 유지하지 않는다. */
export function pickTake(takes: readonly RowTake[] | null | undefined, label: string): RowTake {
  const found = (takes ?? []).find(t => t.label === label);
  if (!found) {
    const known = (takes ?? []).map(t => t.label).join(", ") || "(없음)";
    throw new RerollFailed(`reroll: 테이크 '${label}' 을 찾을 수 없습니다 — 있는 것: ${known}`);
  }
  return found;
}
