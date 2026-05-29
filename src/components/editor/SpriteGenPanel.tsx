"use client";

import { Grid3x3, Sparkles, X } from "lucide-react";
import { useMemo, useState } from "react";
import { StylePresetPicker } from "@/components/library/StylePresetPicker";
import { listPresets } from "@/lib/api/client";
import { directionLabels, type Directions } from "@/lib/mcp/spritesheet-classify";

/**
 * SpriteGenPanel — Composer 의 [스프라이트시트 생성] 버튼 / 결과카드 [시트 만들기]
 * 단축어가 여는 전용 생성 패널. (editor 오버레이 패턴 — ReskinPanel 과 동일 자리.)
 *
 * 패널은 구조화 선택(payload)만 onSubmit 으로 부모(ChatLayout)에 넘긴다. 마커+자연어
 * 합성은 부모 핸들러가 buildSpriteMessage() 로 수행 — reskin 패턴과 일관. 생성은 기존
 * handleSend(chat 흐름) → make_spritesheet 으로 흐른다(새 API 라우트 없음). 부모가
 * 마커 directive 를 그대로 make_spritesheet 에 전달하도록 오케스트레이터가 지시받음.
 */

export type SpriteSubject = "character" | "effect";
export type SpriteAnchor = "auto" | "feet" | "hip" | "center" | "top";
export type SpriteDirections = 1 | 2 | 4 | 8;

/** 패널이 부모에 넘기는 구조화 선택 — 마커·자연어는 부모(buildSpriteMessage)가 조립. */
export type SpriteGenSubmit = {
  subjectType: SpriteSubject;
  /** character: 액션 라벨(프리셋) 또는 "custom". effect: 이펙트 종류 라벨 또는 "custom". */
  preset: string;
  /** preset==="custom" 일 때 자유 텍스트(동작/이펙트 설명). */
  customText: string;
  /** character 전용. */
  anchorStrategy: SpriteAnchor;
  directions: SpriteDirections;
  /** 방향당 프레임 수 (character) — cols 로 매핑. */
  framesPerDir: number;
  /** effect 전용 총 프레임 수 → rows×cols. */
  effectFrames: number;
  /**
   * character & directions>1 전용. true 면 방향별로 directions=1 시트를 따로 N장 생성.
   * 한 장에 24포즈를 그리면 프레임 차별화가 희석돼 측면 보행 발 교차가 약해지므로,
   * 방향마다 집중 생성해 gait 품질을 높인다(부모가 순차 멀티 메시지로 분기).
   */
  perDirection?: boolean;
  /** 최종 그리드 (그리드 미리보기·마커 rows/cols 와 동일). */
  rows: number;
  cols: number;
  /** 스타일 프리셋 — prompt_suffix 결합용(부모가 presetId 로 처리하지 않고 직접 suffix? — 아래 주석). */
  stylePresetId: string | null;
  /** 추가 설명(선택). */
  description: string;
  /** 배경: 투명/흰. 자연어로 결합. */
  background: "transparent" | "white";
  seamlessLoop: boolean;
  /** 참조 이미지(있으면) — attachmentGenerationIds 로 전달됨. */
  referenceId?: string;
};

type EditTarget = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  kind?: string;
};

type Props = {
  /** 결과카드 [시트 만들기] 단축어로 들어온 경우의 참조 이미지(캐릭터). 없으면 fresh. */
  reference?: EditTarget;
  /** 현재 세션 — 향후 참조 썸네일 그리드용(ReskinPanel 패턴). 현재 미사용이나 부모 계약 유지. */
  sessionId?: string | null;
  onSubmit: (payload: SpriteGenSubmit) => void;
  onClose: () => void;
};

// 캐릭터 액션 프리셋 — 라벨(한글 표시) + 영문 동작구(자연어 결합용).
const CHARACTER_ACTIONS: Array<{ key: string; label: string; phrase: string }> = [
  { key: "walk", label: "걷기 (walk)", phrase: "walking" },
  { key: "run", label: "달리기 (run)", phrase: "running" },
  { key: "idle", label: "대기 (idle)", phrase: "idle breathing stance" },
  { key: "jump", label: "점프 (jump)", phrase: "jumping" },
  { key: "crouch", label: "웅크리기 (crouch)", phrase: "crouching" },
  { key: "attack", label: "공격 (attack)", phrase: "melee attack swing motion" },
  { key: "skill", label: "스킬 시전 (skill cast)", phrase: "spell casting pose" },
  { key: "block", label: "방어 (block)", phrase: "blocking with a guard stance" },
  { key: "dodge", label: "회피 (dodge)", phrase: "dodging sideways" },
  { key: "hit", label: "피격 (hit)", phrase: "getting hit, recoil" },
  { key: "death", label: "사망 (death)", phrase: "death collapse" },
  { key: "victory", label: "승리 (victory)", phrase: "victory cheer pose" },
  { key: "custom", label: "커스텀…", phrase: "" },
];

// 이펙트 종류 프리셋 — 라벨 + 영문 구.
const EFFECT_KINDS: Array<{ key: string; label: string; phrase: string }> = [
  { key: "slash", label: "슬래시 (slash)", phrase: "slash trail vfx" },
  { key: "explosion", label: "폭발 (explosion)", phrase: "explosion blast vfx" },
  { key: "lightning", label: "번개 (lightning)", phrase: "lightning bolt vfx" },
  { key: "aura", label: "오라 (aura)", phrase: "glowing aura vfx" },
  { key: "beam", label: "빔 (beam)", phrase: "energy beam vfx" },
  { key: "impact", label: "임팩트 (impact)", phrase: "impact flash vfx" },
  { key: "custom", label: "커스텀…", phrase: "" },
];

const DIRECTION_OPTS: SpriteDirections[] = [1, 2, 4, 8];
const FRAMES_PER_DIR_OPTS = [4, 6, 8, 10] as const;
const EFFECT_FRAME_OPTS = [4, 6, 8, 10] as const;

const ANCHOR_OPTS: Array<{ key: SpriteAnchor; label: string }> = [
  { key: "auto", label: "자동" },
  { key: "feet", label: "발 (ground line)" },
  { key: "hip", label: "엉덩이 (hip)" },
  { key: "center", label: "중앙" },
  { key: "top", label: "머리" },
];

// 방향 수 → 행 라벨(그리드 미리보기). directions=1 은 라벨 없음.
const DIRECTION_ROW_LABELS: Record<SpriteDirections, string[]> = {
  1: [""],
  2: ["정면", "후면"],
  4: ["정면(S)", "측면(E)", "후면(N)", "측면(W)"],
  8: ["S", "SE", "E", "NE", "N", "NW", "W", "SW"],
};

// 총 프레임 수 → near-square rows×cols (이펙트 시트). make_spritesheet auto-reshape 와 정합.
function effectGrid(n: number): { rows: number; cols: number } {
  const map: Record<number, { rows: number; cols: number }> = {
    4: { rows: 2, cols: 2 },
    6: { rows: 2, cols: 3 },
    8: { rows: 2, cols: 4 },
    12: { rows: 3, cols: 4 },
    16: { rows: 4, cols: 4 },
  };
  return map[n] ?? { rows: 2, cols: 2 };
}

export function SpriteGenPanel({ reference, onSubmit, onClose }: Props) {
  // 참조가 있으면 캐릭터 시트로 기본 진입(결과카드 단일 이미지 → 시트화는 캐릭터 의도).
  const [subjectType, setSubjectType] = useState<SpriteSubject>("character");
  const [charAction, setCharAction] = useState<string>("walk");
  const [effectKind, setEffectKind] = useState<string>("slash");
  const [customText, setCustomText] = useState("");
  const [anchorStrategy, setAnchorStrategy] = useState<SpriteAnchor>("auto");
  const [directions, setDirections] = useState<SpriteDirections>(4);
  const [framesPerDir, setFramesPerDir] = useState<number>(6);
  const [effectFrames, setEffectFrames] = useState<number>(8);
  const [stylePresetId, setStylePresetId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [background, setBackground] = useState<"transparent" | "white">("transparent");
  const [seamlessLoop, setSeamlessLoop] = useState(true);
  const [perDirection, setPerDirection] = useState(false);

  const isCharacter = subjectType === "character";
  // 방향별 개별 생성은 캐릭터 다방향에서만 의미 있음(directions=1·effect 면 숨김).
  const canPerDirection = isCharacter && directions > 1;
  const preset = isCharacter ? charAction : effectKind;
  const isCustom = preset === "custom";

  // 최종 그리드: 캐릭터=방향×프레임/방향, 이펙트=총프레임 near-square.
  const grid = useMemo(() => {
    if (isCharacter) return { rows: directions, cols: framesPerDir };
    return effectGrid(effectFrames);
  }, [isCharacter, directions, framesPerDir, effectFrames]);

  const canSubmit = !isCustom || customText.trim().length > 0;

  function submit() {
    if (!canSubmit) return;
    onSubmit({
      subjectType,
      preset,
      customText: customText.trim(),
      anchorStrategy,
      directions,
      framesPerDir,
      effectFrames,
      rows: grid.rows,
      cols: grid.cols,
      stylePresetId,
      description: description.trim(),
      background,
      seamlessLoop,
      perDirection: canPerDirection && perDirection,
      referenceId: reference?.generationId,
    });
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Grid3x3 size={14} /> 스프라이트시트 생성
        </span>
        {reference && (
          <span className="text-xs text-text-muted/60">
            참조 {reference.generationId.slice(0, 6)}…
          </span>
        )}
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 종류 토글 — 캐릭터/이펙트별 옵션 게이팅. */}
        <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-xs">
          {(["character", "effect"] as const).map(s => (
            <button
              key={s}
              onClick={() => setSubjectType(s)}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                subjectType === s
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {s === "character" ? "캐릭터" : "이펙트"}
            </button>
          ))}
        </div>

        {/* 참조 이미지 미리보기 — 결과카드 단축어로 들어온 경우만. */}
        {reference && (
          <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-text-muted/80">참조 캐릭터</span>
              <span className="text-text-primary">
                {reference.width}×{reference.height}
              </span>
            </div>
            <div className="overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/16px_16px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={reference.imageUrl}
                alt="참조"
                className="mx-auto block max-h-[28vh] w-auto object-contain"
              />
            </div>
            <p className="text-[11px] text-text-muted/70">
              이 캐릭터의 외형·스타일을 모든 프레임에 참조해 시트를 생성합니다.
            </p>
          </div>
        )}

        {/* 캐릭터 옵션 */}
        {isCharacter && (
          <div className="shrink-0 space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">액션</label>
              <select
                value={charAction}
                onChange={e => setCharAction(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
              >
                {CHARACTER_ACTIONS.map(a => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>

            {isCustom && (
              <div className="space-y-1">
                <label className="text-xs text-text-muted">동작 설명</label>
                <textarea
                  value={customText}
                  onChange={e => setCustomText(e.target.value)}
                  placeholder="예: 방패로 막으면서 뒤로 한 걸음 물러나기"
                  rows={3}
                  className="block min-h-[78px] w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
                />
                <p className="text-[11px] text-text-muted/70">
                  ⓘ 캐릭터 동작만 묘사하세요 — 이펙트(슬래시·폭발 등)는 적어도 그려지지 않습니다(별도 이펙트 시트로).
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-text-muted">방향</label>
                <select
                  value={directions}
                  onChange={e => setDirections(Number(e.target.value) as SpriteDirections)}
                  className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
                >
                  {DIRECTION_OPTS.map(d => (
                    <option key={d} value={d}>
                      {d}방향
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs text-text-muted">프레임/방향</label>
                <select
                  value={framesPerDir}
                  onChange={e => setFramesPerDir(Number(e.target.value))}
                  className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
                >
                  {FRAMES_PER_DIR_OPTS.map(f => (
                    <option key={f} value={f}>
                      {f}프레임
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-text-muted">앵커</label>
              <select
                value={anchorStrategy}
                onChange={e => setAnchorStrategy(e.target.value as SpriteAnchor)}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
              >
                {ANCHOR_OPTS.map(a => (
                  <option key={a.key} value={a.key}>
                    {a.label}
                  </option>
                ))}
              </select>
              {anchorStrategy === "hip" && (
                <p className="text-[11px] text-text-muted/70">ⓘ 엉덩이 기준은 이족 인간형에 권장됩니다(4족·부유체는 발/중앙).</p>
              )}
            </div>

            <p className="text-[11px] text-[color:var(--danger)]/90">
              ⓘ 공격·스킬도 캐릭터 모션만 그려집니다 — 슬래시·폭발 등 VFX 는 별도 [이펙트] 시트로 생성하세요.
            </p>

            {/* 방향별 개별 생성 — 다방향에서만. 한 장에 모든 방향을 그리면 프레임 차별화가
                희석돼 측면 보행 발 교차가 약해지므로, 방향마다 집중 생성해 품질↑(부모가 순차 N장). */}
            {canPerDirection && (
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
                <input
                  type="checkbox"
                  checked={perDirection}
                  onChange={e => setPerDirection(e.target.checked)}
                  className="mt-0.5"
                />
                <span className="space-y-0.5">
                  <span className="block text-text-primary">방향별로 따로 생성 (품질↑)</span>
                  <span className="block text-[11px] text-text-muted/70">
                    각 방향을 따로 생성해 발 교차 품질↑ ({directions}장 생성)
                  </span>
                </span>
              </label>
            )}
          </div>
        )}

        {/* 이펙트 옵션 */}
        {!isCharacter && (
          <div className="shrink-0 space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-text-muted">이펙트 종류</label>
              <select
                value={effectKind}
                onChange={e => setEffectKind(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
              >
                {EFFECT_KINDS.map(k => (
                  <option key={k.key} value={k.key}>
                    {k.label}
                  </option>
                ))}
              </select>
            </div>

            {isCustom && (
              <div className="space-y-1">
                <label className="text-xs text-text-muted">이펙트 설명</label>
                <textarea
                  value={customText}
                  onChange={e => setCustomText(e.target.value)}
                  placeholder="예: 회전하는 빙결 소용돌이"
                  rows={3}
                  className="block min-h-[78px] w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
                />
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs text-text-muted">프레임 수</label>
              <select
                value={effectFrames}
                onChange={e => setEffectFrames(Number(e.target.value))}
                className="h-9 w-full rounded-lg border border-border bg-bg-card px-2 text-sm text-text-primary focus:outline-none"
              >
                {EFFECT_FRAME_OPTS.map(f => (
                  <option key={f} value={f}>
                    {f}프레임 ({effectGrid(f).rows}×{effectGrid(f).cols})
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}

        {/* 공통: 스타일 / 설명 / 배경 / 루프 */}
        <div className="shrink-0 space-y-3 border-t border-border pt-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-text-muted">스타일</span>
            <StylePresetPicker value={stylePresetId} onChange={setStylePresetId} />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-text-muted">설명 (선택)</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="예: 파란 갑옷의 기사, 은빛 검"
              rows={2}
              className="block w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
            />
          </div>

          <div className="flex items-center gap-4 text-xs">
            <span className="text-text-muted">배경</span>
            {(["transparent", "white"] as const).map(b => (
              <label key={b} className="flex cursor-pointer items-center gap-1 text-text-muted">
                <input
                  type="radio"
                  name="bg"
                  checked={background === b}
                  onChange={() => setBackground(b)}
                />
                {b === "transparent" ? "투명" : "흰 배경"}
              </label>
            ))}
            <label className="ml-auto flex cursor-pointer items-center gap-1 text-text-muted">
              <input
                type="checkbox"
                checked={seamlessLoop}
                onChange={e => setSeamlessLoop(e.target.checked)}
              />
              루프
            </label>
          </div>
        </div>

        {/* 정적 그리드 미리보기 — 실제 생성 없이 rows×cols 격자 + 방향 라벨만. */}
        <div className="shrink-0 space-y-1">
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <span>미리보기</span>
            <span className="text-text-primary">
              그리드 {grid.rows}×{grid.cols}
            </span>
            <span className="text-text-muted/60">(셀 {grid.rows * grid.cols}개)</span>
          </div>
          <div
            className="grid gap-0.5 rounded-lg border border-border bg-bg-card p-2"
            style={{ gridTemplateColumns: `auto repeat(${grid.cols}, minmax(0, 1fr))` }}
          >
            {Array.from({ length: grid.rows }).map((_, r) => {
              const rowLabel =
                isCharacter && directions > 1 ? DIRECTION_ROW_LABELS[directions]?.[r] ?? "" : "";
              return (
                <RowCells key={r} rowLabel={rowLabel} cols={grid.cols} />
              );
            })}
          </div>
        </div>
      </div>

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
        <button
          onClick={onClose}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="flex h-9 flex-[2] items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          title={canSubmit ? "" : "커스텀 동작/이펙트 설명 입력 필요"}
        >
          <Sparkles size={14} /> 생성 ▸
        </button>
      </footer>
    </aside>
  );
}

// 그리드 미리보기 한 행: 방향 라벨 셀(있으면) + cols 개의 빈 셀.
function RowCells({ rowLabel, cols }: { rowLabel: string; cols: number }) {
  return (
    <>
      <span className="flex min-w-[44px] items-center pr-1 text-[10px] text-text-muted/70">
        {rowLabel}
      </span>
      {Array.from({ length: cols }).map((_, c) => (
        <span
          key={c}
          className="aspect-square rounded-sm border border-border/60 bg-bg-app/40"
        />
      ))}
    </>
  );
}

/**
 * SpriteGenSubmit → { message, attachmentGenerationIds } 순수 빌더.
 *
 * 마커 형식(계약 — 키 이름은 make_spritesheet 입력명과 정확히 일치):
 *  - character: [spritesheet: subjectType=character; anchorStrategy=hip; directions=4; framesPerDir=6; rows=4; cols=6; seamlessLoop=true]
 *  - effect:    [spritesheet: subjectType=effect; rows=2; cols=4; seamlessLoop=false]
 * directive 다음 줄에 자연어(피사체·액션·스타일·설명·배경). 참조는 마커가 아니라
 * attachmentGenerationIds 로 전달 → /api/chat 이 [reference: id] prefix → inputGenerationId.
 *
 * stylePresetSuffix 는 부모가 presetCache 로 해석한 prompt_suffix 를 넘긴다(클라이언트
 * 측 결합 — 서버 orchestrator 는 preset 개념 모름, Composer 흐름과 동일).
 */
export function buildSpriteMessage(
  payload: SpriteGenSubmit,
  stylePresetSuffix?: string | null,
): { message: string; attachmentGenerationIds: string[] } {
  const { subjectType, rows, cols, seamlessLoop } = payload;
  const isCharacter = subjectType === "character";

  // 마커 directive — 캐릭터면 directions/anchorStrategy/framesPerDir 포함, 이펙트면 생략.
  const parts = [`subjectType=${subjectType}`];
  if (isCharacter) {
    parts.push(`anchorStrategy=${payload.anchorStrategy}`);
    parts.push(`directions=${payload.directions}`);
    parts.push(`framesPerDir=${payload.framesPerDir}`);
  }
  parts.push(`rows=${rows}`);
  parts.push(`cols=${cols}`);
  parts.push(`seamlessLoop=${seamlessLoop}`);
  const directive = `[spritesheet: ${parts.join("; ")}]`;

  // 자연어: 피사체/액션(또는 이펙트 종류) + 설명 + 스타일 suffix + 배경.
  const actionPhrase = lookupPhrase(payload);
  const nlParts: string[] = [];
  if (isCharacter) {
    nlParts.push(actionPhrase ? `캐릭터 ${actionPhrase} 모션 스프라이트 시트` : "캐릭터 모션 스프라이트 시트");
  } else {
    nlParts.push(actionPhrase ? `${actionPhrase} 이펙트 스프라이트 시트` : "이펙트 스프라이트 시트");
  }
  if (payload.description) nlParts.push(payload.description);
  if (stylePresetSuffix) nlParts.push(stylePresetSuffix);
  nlParts.push(payload.background === "white" ? "white background" : "transparent background");
  const nl = nlParts.join(", ");

  return {
    message: `${directive}\n${nl}`,
    attachmentGenerationIds: payload.referenceId ? [payload.referenceId] : [],
  };
}

/**
 * directionLabels(n) 의 행 라벨(예: "DOWN (toward viewer)", "LEFT", "DOWN-LEFT") →
 * 단일 방향 시트 자연어용 facing 구. 측면(LEFT/RIGHT)은 side view, 정/후면은 front/back view.
 */
function facingPhrase(label: string): string {
  if (label.startsWith("DOWN-")) return `facing ${label} (3/4 front view)`;
  if (label.startsWith("UP-")) return `facing ${label} (3/4 back view)`;
  if (label.startsWith("DOWN")) return "facing DOWN (front view)";
  if (label.startsWith("UP")) return "facing UP (back view)";
  if (label === "LEFT") return "facing LEFT (side view)";
  if (label === "RIGHT") return "facing RIGHT (side view)";
  return `facing ${label}`;
}

/**
 * 방향별 개별 생성 — directions>1 캐릭터 시트를 방향마다 directions=1·rows=1·cols=framesPerDir
 * 단일 방향 시트로 쪼갠 N개 메시지 빌더. 한 장에 모든 방향을 그리면 프레임 차별화가
 * 희석돼(측면 보행 발 교차 약함) 방향마다 집중 생성한다. 부모(ChatLayout)가 순차 await 로
 * N장을 개별 결과 카드로 생성한다(한 장 스티칭은 범위 밖 — 사용자가 개별 사용/조합).
 *
 * 각 메시지 마커는 단일 방향(directions=1, rows=1, cols=framesPerDir) — 백엔드가 cols>4 면
 * auto-reshape(2×3 등) 처리. 자연어엔 buildSpriteMessage 와 동일한 액션/설명/스타일/배경에
 * 더해 해당 방향 facing 구를 명시. 참조는 매 방향에 동일 첨부.
 */
export function buildSpriteMessagesPerDirection(
  payload: SpriteGenSubmit,
  stylePresetSuffix?: string | null,
): Array<{ message: string; attachmentGenerationIds: string[] }> {
  const labels = directionLabels(payload.directions as Directions);
  // 방어: 단일 방향이거나 라벨이 없으면 단일 메시지로 폴백(분기 진입 조건은 부모가 게이팅).
  if (labels.length === 0) return [buildSpriteMessage(payload, stylePresetSuffix)];

  const { framesPerDir, anchorStrategy, seamlessLoop } = payload;
  const directive =
    `[spritesheet: subjectType=character; anchorStrategy=${anchorStrategy}; ` +
    `directions=1; framesPerDir=${framesPerDir}; rows=1; cols=${framesPerDir}; seamlessLoop=${seamlessLoop}]`;

  const actionPhrase = lookupPhrase(payload);
  const attachmentGenerationIds = payload.referenceId ? [payload.referenceId] : [];

  return labels.map(label => {
    const nlParts: string[] = [];
    nlParts.push(actionPhrase ? `캐릭터 ${actionPhrase} 모션 스프라이트 시트` : "캐릭터 모션 스프라이트 시트");
    nlParts.push(facingPhrase(label));
    if (payload.description) nlParts.push(payload.description);
    if (stylePresetSuffix) nlParts.push(stylePresetSuffix);
    nlParts.push(payload.background === "white" ? "white background" : "transparent background");
    return {
      message: `${directive}\n${nlParts.join(", ")}`,
      attachmentGenerationIds,
    };
  });
}

// 프리셋 key → 영문 자연어 구. custom 이면 customText 그대로.
function lookupPhrase(payload: SpriteGenSubmit): string {
  if (payload.preset === "custom") return payload.customText;
  const table = payload.subjectType === "character" ? CHARACTER_ACTIONS : EFFECT_KINDS;
  return table.find(x => x.key === payload.preset)?.phrase ?? payload.preset;
}

// presetId → prompt_suffix 해석(부모가 호출). listPresets 캐시 없이 1회 조회 — 가벼움.
export async function resolveStyleSuffix(presetId: string | null): Promise<string | null> {
  if (!presetId) return null;
  try {
    const all = await listPresets();
    return all.find(p => p.id === presetId)?.prompt_suffix ?? null;
  } catch {
    return null;
  }
}
