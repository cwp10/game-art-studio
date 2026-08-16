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
 */
import { directionAnchorStates, stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";

/** 표시 순서와 제외 집합. SpriteCanvas 의 frameOrder/excludedFrames 와 같은 뜻이다. */
export type CurationRecord = { order: number[]; excluded: number[] };

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
 * 재생·내보내기가 따르는 그 순서. order 길이가 프레임 수와 다르면 원본 순서로 본다
 * (SpriteCanvas 도 초기화 전에는 같은 판정을 한다).
 */
export function curatedSequence(frameCount: number, curation: CurationRecord | null): number[] {
  const natural = Array.from({ length: frameCount }, (_, i) => i);
  if (!curation) return natural;
  const order = curation.order.length === frameCount ? curation.order : natural;
  const excluded = new Set(curation.excluded);
  return order.filter(i => !excluded.has(i));
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
