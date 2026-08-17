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
  toSideSuffix,
  toSpriteGenDirection,
} from "@/lib/sprite/directions";
import {
  classifyState,
  DEFAULT_CELL_SIZE,
  DEFAULT_CHROMA_TUNABLES,
  frameCountAdvice,
  isLocomotionState,
  normalizeCell,
  normalizeStates,
  type SpriteRequest,
  type StateSpec,
  type FitSpec,
} from "@/lib/sprite/request";
import { inferActionHint } from "@/lib/sprite/state-name";
import { stateMotionPhases } from "@/lib/sprite/motion-phase";

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
  /**
   * 레이아웃 가이드에 스틱 포즈 모션 위상 힌트를 그린다. **명시적 로코모션 실험 전용**
   * 옵트인이다(정본 `--motion-phase-guides`). 8프레임 로코모션이 아니면 무시된다.
   */
  motionPhaseGuides?: boolean;
  /**
   * 추출 튜닝 (정본 `fit`). **지정하지 않으면 request 에 키가 아예 안 실린다** —
   * 기존 런과 바이트 동일을 지키려면 `undefined` 와 `{}` 가 달라야 한다.
   */
  fit?: FitSpec;
};

const DEFAULT_STATE_NAME = "action";

export async function buildSpriteRequest(
  input: PanelInput,
): Promise<{ request: SpriteRequest; warnings: string[] }> {
  const warnings: string[] = [];

  const direction = toSpriteGenDirection(input.uiDirection);
  // 동작 텍스트에서 정본 상태 어휘를 뽑는다. 여기가 비면 상태명이 `action` 으로 고정되고
  // STATE_REQUIREMENTS·상태별 fps·등급 판정이 전부 죽는다 (state-name.ts 참조).
  const bare = input.stateName ?? inferActionHint(input.actionPrompt)?.state ?? DEFAULT_STATE_NAME;
  // 45도는 좌/우를 **상태명 접미사**가 진다 — 정본이 그렇게 나눈다. `down45_run-front-right`
  // 는 접두사 경로(45도 facing)와 접미사 경로(3/4 뷰 잠금)를 둘 다 발화시킨다.
  const sideSuffix = toSideSuffix(input.uiDirection);
  // 정본은 방향성 로코모션을 진행형으로 쓴다(`running-front-right`, `walking-back-left`).
  // 그 형태여야 classifyState 의 `running-`/`walking-` 접두사와 isLocomotionState 의
  // `running-front-` 계열이 걸린다. 4방위 런은 정본대로 `run`/`walk` 그대로 둔다.
  const DIRECTIONAL_VERB: Record<string, string> = { run: "running", walk: "walking" };
  const stem = sideSuffix ? (DIRECTIONAL_VERB[bare] ?? bare) : bare;
  // 방향 계약 런은 상태명이 <direction>_<state> 여야 한다 (③ normalizeDirections).
  const stateName = direction === null ? bare : `${direction}_${stem}${sideSuffix}`;

  const advice = frameCountAdvice(input.frames);
  if (advice.band === "not-default" || advice.band === "advanced") {
    warnings.push(`frames=${input.frames} (${advice.band}): ${advice.note}`);
  }

  // 정본은 약한 walk/run 행을 simple MVP 산출물과 같은 등급으로 조용히 승격하지 말라고
  // 못박는다 — 모션 QA 를 통과하기 전에는 experimental 로 **보고**한다.
  const grade = classifyState(`${stem}${sideSuffix}`);
  if (grade === "experimental") {
    warnings.push(
      `상태 '${bare}' 는 정본 experimental 등급이다 — 모션 QA(qa/${stateName}.gif)를 ` +
        `통과하기 전에는 pass 로 다루지 않는다`,
    );
  } else if (grade === "simple-candidate") {
    warnings.push(`상태 '${bare}' 는 정본 simple 후보다 — 모션 QA 통과 전에는 pass 가 아니다`);
  }
  // 정본 체크리스트 3번. 우리는 아직 로코모션 행에 모션 위상 참조를 붙이지 못한다.
  if (isLocomotionState(`${stem}${sideSuffix}`)) {
    warnings.push(
      `상태 '${bare}' 는 주기적 이동이다 — 정본은 양쪽 접지가 다 보이는 모션 위상 참조` +
        `(접촉 시트·선택 사이클·레이아웃 페이즈 가이드)를 요구한다. 지금은 방향 idle 앵커만 붙는다`,
    );
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
      // 빈 객체도 싣지 않는다 — 켠 것이 하나도 없으면 없는 것과 같아야 한다.
      ...(input.fit && Object.keys(input.fit).length > 0 ? { fit: input.fit } : {}),
      // 로코모션 8프레임이면 **자동으로 켠다**. 정본은 이걸 CLI 플래그
      // (`--motion-phase-guides`)로 사람이 켜고 기본은 false 인데, 우리 앱에는 그
      // 플래그를 켤 자리가 없다 — ycbcr·앵커 면제와 같은 상황이라 같은 방식으로 푼다.
      //
      // 조건을 `stateMotionPhases` 자신에게 묻는 이유: 그 함수가 위상을 내는 조건과
      // 정확히 같아야 한다. 위상이 빈 배열인데 켜면 "가이드의 스틱 힌트를 따르라" 는
      // 지시만 붙고 가이드에는 아무것도 안 그려져, 없는 것을 가리키는 프롬프트가 된다.
      //
      // 이걸 켜지 않아 실제로 걷기 8프레임의 다리가 거의 교차하지 않았다(2026-08-16).
      // 그런데 우리 검사 신호 넷 중 어느 것도 "다리가 교차하는가" 를 보지 않아
      // 100점이 나왔다 — 가이드를 켜는 것과 별개로 남는 공백이다.
      ...(input.motionPhaseGuides || stateMotionPhases(bare, input.frames).length > 0
        ? { motionPhaseGuides: true }
        : {}),
    },
    warnings,
  };
}
