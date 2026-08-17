/**
 * 방향 앵커 = 사람이 승인한 **단 한 장** — sprite_gen/anchor.py 이식.
 *
 *     지정(pin)  >  그 방향 앵커 행의 큐레이션 시퀀스 첫 인스턴스
 *
 * 두 번째가 기본값이다(명시 기본값 — 폴백이 아니다). index 0 이 아니라 **시퀀스 첫
 * 인스턴스**인 이유: 사용자가 앞 프레임을 제외/재정렬했으면 index 0 은 기각분이다
 * (sprite-gen 실사고 2026-07-19 — side_idle 이 0·1·2 제외 후 3부터라 index 0 베이크가
 * 제외된 프레임을 앵커로 만들었다).
 *
 * 사라진 프레임을 가리키는 지정은 fail-loud 다 — 조용히 기본값으로 되돌리면
 * "지정했는데 왜 안 먹지"를 사용자가 영원히 못 본다 (No Silent Fallback).
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import { directionAnchorStates, stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";

/**
 * 큐레이션 사이드카 — sprite-gen `curation.json` 의 `states.<state>` 부분 이식.
 *
 * **`selected` 가 권위 필드다**: 재생 순서의 0-based 프레임 인덱스이며, 선택과 순서를
 * 한 배열이 함께 표현한다. `order` 는 웹뷰 소유의 표시 배열(시퀀스 줄 + 후보 풀)이고
 * 정본은 *"compose / state_plan ignore it and key off selected"* 라고 못박는다 —
 * 화면 배열이 구운 결과를 바꾸지 못하게 하기 위해서다.
 *
 * 우리 `SpriteCanvas` 는 `frameOrder`(표시 순서) + `excludedFrames`(제외)를 들고 있고
 * 그 둘에서 파생된 재생 시퀀스가 곧 `selected` 다. 저장할 때 파생값을 굽고, 표시 복원용
 * `order` 를 함께 남긴다.
 */
export type CurationRecord = {
  /** 재생 순서의 0-based 프레임 인덱스. 비어 있거나 없으면 전체 프레임을 원래 순서로. */
  selected: number[];
  /** 표시 전용. 해석은 무시한다. */
  order?: number[];
  /**
   * 호흡 후처리 레이어 (정본 `states.<state>.breathe`). 프레임 선택과 **직교**한다 —
   * 합성이 재생 시퀀스 위에 결정론으로 굽고 디스크 프레임은 불변이다.
   *
   * 검증 전 원시값이다. 읽는 쪽은 반드시 `stateBreathe` 를 통과시켜야 한다 —
   * 그 함수가 범위·정수성·폐기 키를 **조용히 고치지 않고** 거부한다.
   */
  breathe?: unknown;
  /**
   * 프레임별 비파괴 변형 (정본 `states.<state>.transforms`) — {프레임 인덱스: 변형}.
   *
   * breathe 와 마찬가지로 검증 전 원시값이다. 읽는 쪽이 `stateTransforms` 를 통과시켜
   * 전체 필드를 채우고 identity 를 걸러낸다.
   */
  transforms?: Record<string, unknown>;
};

/**
 * 앵커 지정. sprite-gen 은 `{state, index}` + `state_revision` 을 쓰지만 우리는
 * `generationId` 를 쓴다 — 행을 다시 생성하면 새 id 가 나오므로 낡은 지정은 정의상
 * 존재하지 않는 행을 가리킨다. 원본의 pick-stale-generation·pick-unverifiable 이
 * pick-unknown-generation 하나로 합쳐지는 이유다.
 */
export type AnchorPick = { generationId: string; index: number };

export type AnchorRow = {
  generationId: string;
  frameCount: number;
  curation: CurationRecord | null;
};

export type AnchorContext = {
  request: SpriteRequest;
  /** direction → 지정 */
  picks: Record<string, AnchorPick>;
  /** state → 생성된 행 */
  rows: Record<string, AnchorRow>;
};

export type ResolvedAnchor = {
  direction: string;
  state: string;
  index: number;
  source: "picked" | "default";
};

/**
 * 앵커를 지금 낼 수 없다. `kind` 가 **"아직"(pending)** 과 **"깨졌다"(broken)** 를 가른다.
 *
 * 두 상태는 사용자에게 전혀 다른 뜻이다 — pending 은 생성이 거기까지 안 온 정상 구간이고,
 * broken 은 사람이 고쳐야 하는 것이다. 이 구분이 없으면 뷰가 멀쩡한 작업 중간 런에
 * 빨간 오류를 띄운다.
 */
export class AnchorUnavailable extends Error {
  static readonly PENDING_KINDS = new Set(["no-anchor-row", "row-not-generated"]);
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = "AnchorUnavailable";
    this.kind = kind;
  }

  get pending(): boolean {
    return AnchorUnavailable.PENDING_KINDS.has(this.kind);
  }
}

/**
 * 재생·내보내기가 따르는 그 순서 = `selected`.
 *
 * 범위를 벗어난 인덱스는 조용히 버리지 않고 던진다. 정본은 행별 `revision` 스탬프로
 * 프레임 인덱스 공간이 바뀐 큐레이션을 걸러내는데(재추출·리롤), 우리에겐 그 스탬프가
 * 없다. 그대로 필터링하면 사람이 승인한 것과 **다른 프레임이 시퀀스 헤드**가 되고,
 * 그것이 이 모듈이 존재하는 사고와 같은 형태다.
 */
export function curatedSequence(frameCount: number, curation: CurationRecord | null): number[] {
  const natural = Array.from({ length: frameCount }, (_, i) => i);
  if (!curation || curation.selected.length === 0) return natural;
  const stale = curation.selected.filter(i => i < 0 || i >= frameCount);
  if (stale.length > 0) {
    throw new AnchorUnavailable(
      "curation-stale",
      `anchor: curated selection references frames ${stale.join(", ")} but the row has ` +
        `${frameCount} frames — the curation was made for a different extraction. ` +
        `Re-curate the row.`,
    );
  }
  return [...curation.selected];
}

export function resolveAnchor(ctx: AnchorContext, direction: string): ResolvedAnchor {
  const directions = ctx.request.directions ?? null;
  if (!directions || !directions.set.includes(direction)) {
    throw new AnchorUnavailable(
      "unknown-direction",
      `anchor: '${direction}' is not a generated direction ` +
        `(${directions?.set.join(", ") || "run has no directions block"})`,
    );
  }

  const pick = ctx.picks[direction];
  if (pick) {
    const entry = Object.entries(ctx.rows).find(([, r]) => r.generationId === pick.generationId);
    if (!entry) {
      throw new AnchorUnavailable(
        "pick-unknown-generation",
        `anchor: pinned anchor frame ${pick.generationId}#${pick.index} is not a row of this run ` +
          `(the row was regenerated or removed) — re-pick the anchor frame`,
      );
    }
    const [state, row] = entry;
    const owner = stateDirection(state, directions);
    if (owner !== direction) {
      throw new AnchorUnavailable(
        "pick-wrong-direction",
        `anchor: pinned frame ${state}#${pick.index} belongs to direction '${owner}', ` +
          `not '${direction}' — an anchor owns its own facing`,
      );
    }
    if (!curatedSequence(row.frameCount, row.curation).includes(pick.index)) {
      throw new AnchorUnavailable(
        "pick-missing",
        `anchor: pinned anchor frame ${state}#${pick.index} is not in the curated sequence ` +
          `(excluded, or out of range) — re-pick the anchor frame`,
      );
    }
    return { direction, state, index: pick.index, source: "picked" };
  }

  const state = directionAnchorStates(directions)[direction];
  if (!(state in ctx.request.states)) {
    throw new AnchorUnavailable(
      "no-anchor-row",
      `anchor: direction '${direction}' has no anchor row '${state}' and no pinned anchor frame ` +
        `— declare/generate the anchor row, or pin a frame of this direction`,
    );
  }
  const row = ctx.rows[state];
  if (!row) {
    throw new AnchorUnavailable(
      "row-not-generated",
      `anchor: anchor row '${state}' has not been generated yet`,
    );
  }
  const ordered = curatedSequence(row.frameCount, row.curation);
  if (ordered.length === 0) {
    throw new AnchorUnavailable(
      "empty-sequence",
      `anchor: '${state}' has an empty curated sequence — nothing to use as the direction anchor ` +
        `(restore a frame, or pin one explicitly)`,
    );
  }
  return { direction, state, index: ordered[0], source: "default" };
}
