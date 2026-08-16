/**
 * 생성 체인 SSoT — sprite_gen/prepare.py `build_generation_plan()` 이식.
 *
 * 1단계 방향 앵커(base 기반) → 2단계 액션 행(앵커 기반). 미러 방향은 **생성 생략을
 * 명시적으로 기록한다** — 조용한 누락이 아니라 계약이다.
 *
 * refs 는 파일 경로가 아니라 태그 객체다(우리에게 run 디렉터리가 없다). `kind` 를
 * 남기는 목적은 ④에서 "액션 행에 base 를 붙였는지"를 기계적으로 검증하기 위해서다.
 *
 * Ported from sprite-gen (https://github.com/cwp10/sprite-gen),
 * Copyright 2026 Alex Kim, licensed under the Apache License, Version 2.0.
 * See NOTICE and licenses/sprite-gen-Apache-2.0.txt.
 * SPDX-License-Identifier: Apache-2.0
 */
import { directionAnchorStates, stateDirection } from "@/lib/sprite/directions";
import type { SpriteRequest } from "@/lib/sprite/request";

export type PlanRef =
  | { kind: "base"; ref: "locked-base" }
  | { kind: "anchor"; ref: string } // ref = direction
  | { kind: "layout-guide"; ref: string }; // ref = state

export type PlanItem = {
  state: string;
  role: "direction-anchor" | "action-row";
  direction: string;
  refs: PlanRef[];
  note: string;
};

export type MirroredDirection = { direction: string; mirrorOf: string; note: string };

export type GenerationPlan = {
  version: 1;
  kind: "sprite-gen-generation-plan";
  order: [
    { stage: 1; name: "direction-anchors"; items: PlanItem[] },
    { stage: 2; name: "action-rows"; items: PlanItem[] },
  ];
  mirroredDirections: MirroredDirection[];
};

const ANCHOR_NOTE =
  "base 는 방향 앵커 생성까지만 identity 소스다 — 앵커 수락 후 행 생성에 base 를 재부착하지 않는다";

const ROW_NOTE =
  "앵커 ref 는 파생 캐시다 — 생성 직전 bakeAnchorImage 로 큐레이션 진실에서 다시 굽는다. " +
  "정적 스냅샷을 재사용하면 사용자가 프레임을 편집·제외한 순간 소리 없이 낡는다";

function mirrorNote(source: string): string {
  return (
    "생성 생략 — 런타임 미러가 기본. 미러로 부족해 재생성할 때는 반대편 행" +
    `(${source} 행)을 timing/scale 참조로만 부착하고, 대상 방향 앵커를 새로 뽑아 identity 로 쓴다`
  );
}

export function buildGenerationPlan(request: SpriteRequest): GenerationPlan | null {
  const directions = request.directions;
  if (!directions) return null;

  const anchors = directionAnchorStates(directions);
  const anchorNames = new Set(Object.values(anchors));

  const stageAnchors: PlanItem[] = directions.set.map(d => ({
    state: anchors[d],
    role: "direction-anchor",
    direction: d,
    refs: [
      { kind: "base", ref: "locked-base" },
      { kind: "layout-guide", ref: anchors[d] },
    ],
    note: ANCHOR_NOTE,
  }));

  const stageRows: PlanItem[] = [];
  for (const state of Object.keys(request.states)) {
    if (anchorNames.has(state)) continue;
    const direction = stateDirection(state, directions);
    if (direction === null) continue;
    stageRows.push({
      state,
      role: "action-row",
      direction,
      refs: [
        { kind: "anchor", ref: direction },
        { kind: "layout-guide", ref: state },
      ],
      note: ROW_NOTE,
    });
  }

  return {
    version: 1,
    kind: "sprite-gen-generation-plan",
    order: [
      { stage: 1, name: "direction-anchors", items: stageAnchors },
      { stage: 2, name: "action-rows", items: stageRows },
    ],
    mirroredDirections: Object.entries(directions.mirror).map(([target, source]) => ({
      direction: target,
      mirrorOf: source,
      note: mirrorNote(source),
    })),
  };
}
