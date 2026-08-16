/**
 * 패널 인자 → SpriteRequest 조립.
 *
 * ②의 셀·상태·크로마 정규화와 ③의 방향 계약을 한 자리에서 엮는다. 이 함수의 출력이
 * 이후 모든 것(가이드·프롬프트·플랜·추출·아틀라스)의 SSoT 다.
 */
import { chooseChromaKey } from "@/lib/sprite/chroma-key";
import {
  ensureDirectionAnchors,
  normalizeDirections,
  toSpriteGenDirection,
} from "@/lib/sprite/directions";
import {
  DEFAULT_CELL_SIZE,
  DEFAULT_CHROMA_TUNABLES,
  frameCountAdvice,
  normalizeCell,
  normalizeStates,
  type SpriteRequest,
  type StateSpec,
} from "@/lib/sprite/request";

export type PanelInput = {
  characterId: string;
  description: string;
  /** 잠긴 base 의 파일 경로. null 이면 크로마 키가 마젠타로 폴백한다. */
  baseImagePath: string | null;
  /** SpriteGenPanel 의 Direction 값 (DOWN/UP/... /REF). */
  uiDirection: string;
  frames: number;
  loop: boolean;
  actionPrompt: string;
  /** 상태 이름(방향 접두사 제외). 기본 "action". */
  stateName?: string;
  cellSize?: number;
  /** 런타임 미러로 커버할 UI 방향. 생성하지 않고 계약으로만 기록한다. */
  mirrorFrom?: string;
};

const DEFAULT_STATE_NAME = "action";

export async function buildSpriteRequest(
  input: PanelInput,
): Promise<{ request: SpriteRequest; warnings: string[] }> {
  const warnings: string[] = [];

  const direction = toSpriteGenDirection(input.uiDirection);
  const bareState = input.stateName ?? DEFAULT_STATE_NAME;
  // 방향 계약 런은 상태명이 <direction>_<state> 여야 한다 (③ normalizeDirections).
  const stateName = direction === null ? bareState : `${direction}_${bareState}`;

  const advice = frameCountAdvice(input.frames);
  if (advice.band === "not-default" || advice.band === "advanced") {
    warnings.push(`frames=${input.frames} (${advice.band}): ${advice.note}`);
  }

  // fps 를 넘기지 않는다 — normalizeStates 가 DEFAULT_STATES 에서 상태별 값을 찾고,
  // 미지 상태는 6 으로 떨어진다. 프레임 수에서 파생하지 않는 것이 정본 동작이다.
  const requested: Record<string, Partial<StateSpec>> = {
    [stateName]: { frames: input.frames, loop: input.loop, action: input.actionPrompt },
  };

  let states = normalizeStates(requested);
  let directions: SpriteRequest["directions"];
  if (direction !== null) {
    const mirrorTarget = input.mirrorFrom ? toSpriteGenDirection(input.mirrorFrom) : null;
    directions =
      normalizeDirections(
        {
          set: [direction],
          ...(mirrorTarget && mirrorTarget !== direction
            ? { mirror: { [mirrorTarget]: direction } }
            : {}),
        },
        states,
      ) ?? undefined;
    // 앵커 없는 방향 행 생성 금지 — 빠진 <dir>_idle 을 합성해 앞에 끼운다.
    if (directions) states = ensureDirectionAnchors(directions, states);
  }

  const chromaKey = await chooseChromaKey(input.baseImagePath, "auto");
  if (chromaKey.selection === "fallback") {
    warnings.push(`chroma key fallback: ${chromaKey.selectionReason ?? "unknown reason"}`);
  }
  if (chromaKey.warning) warnings.push(`chroma key: ${chromaKey.warning}`);

  return {
    request: {
      version: 1,
      character: {
        id: input.characterId,
        description: input.description,
        // 실제 앵커는 ③의 resolveAnchor 가 생성 중에 정한다. 조립 시점에는 비워 둔다.
        anchorGenerationId: "",
      },
      cell: normalizeCell({ size: input.cellSize ?? DEFAULT_CELL_SIZE }),
      chromaKey,
      chroma: DEFAULT_CHROMA_TUNABLES,
      states,
      ...(directions ? { directions } : {}),
    },
    warnings,
  };
}
