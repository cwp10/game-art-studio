"use client";

import { Grid3x3, Lightbulb, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StylePresetPicker } from "@/components/library/StylePresetPicker";
import { listPresets } from "@/lib/api/client";

/**
 * SpriteGenPanel — 스프라이트시트 전용 생성 패널 (editor 오버레이, ChatLayout 우측).
 *
 * contextMode(캐릭터|오브젝트) + tab(subject|effect) 2축으로 피사체를 선택한다.
 * - 캐릭터 모드: 캐릭터 탭 | 이펙트 탭 (캐릭터에 어울리는 이펙트)
 * - 오브젝트 모드: 오브젝트 탭 | 이펙트 탭 (오브젝트에 어울리는 이펙트)
 * 모드 전환은 탭 아래 소형 링크로.
 */

export type SubjectType = "character" | "effect" | "object";
export type ContextMode = "character" | "object";
export type Direction =
  | "DOWN"
  | "LEFT"
  | "RIGHT"
  | "UP"
  | "DOWN-LEFT"
  | "DOWN-RIGHT"
  | "UP-LEFT"
  | "UP-RIGHT";
export type FrameCount = 4 | 6 | 8 | 12 | 16;

export type SpriteGenState = {
  subjectType: SubjectType;
  contextType: ContextMode; // effect 탭일 때 어떤 컨텍스트의 이펙트인지
  direction: Direction;
  frames: FrameCount;
  stylePresetId: string | null;
  seamlessLoop: boolean;
  actionPrompt: string;
};

type Props = {
  /** 참조 이미지 generation ID (있으면 그 캐릭터/오브젝트를 모든 프레임에 참조). */
  referenceId?: string;
  /** 참조 썸네일 URL. */
  referenceImageUrl?: string;
  /** 패널 초기 컨텍스트. "character" → 캐릭터|이펙트, "object" → 오브젝트|이펙트. */
  initialSubjectMode?: ContextMode;
  onSubmit: (
    messages: Array<{ message: string; attachmentGenerationIds: string[] }>,
  ) => void;
  onClose: () => void;
};

const DIRECTION_LABELS: Record<Direction, string> = {
  DOWN: "↓ 정면",
  LEFT: "← 왼쪽",
  RIGHT: "→ 오른쪽",
  UP: "↑ 뒤",
  "DOWN-LEFT": "↙",
  "DOWN-RIGHT": "↘",
  "UP-LEFT": "↖",
  "UP-RIGHT": "↗",
};

const DIRECTION_SYMBOLS: Record<Direction, string> = {
  DOWN: "↓",
  LEFT: "←",
  RIGHT: "→",
  UP: "↑",
  "DOWN-LEFT": "↙",
  "DOWN-RIGHT": "↘",
  "UP-LEFT": "↖",
  "UP-RIGHT": "↗",
};

const COMPASS: Array<Direction | null> = [
  "UP-LEFT", "UP", "UP-RIGHT",
  "LEFT", null, "RIGHT",
  "DOWN-LEFT", "DOWN", "DOWN-RIGHT",
];

const FRAME_OPTS: Array<{ value: FrameCount; rows: number; cols: number }> = [
  { value: 4,  rows: 2, cols: 2 },
  { value: 6,  rows: 2, cols: 3 },
  { value: 8,  rows: 2, cols: 4 },
  { value: 12, rows: 4, cols: 3 },
  { value: 16, rows: 4, cols: 4 },
];

type ExampleKey = "character" | "object" | "character-effect" | "object-effect";

const EXAMPLES: Record<ExampleKey, Array<{ label: string; text: string }>> = {
  character: [
    { label: "공격 모션", text: "짧은 예비동작 후 몸을 빠르게 앞으로 실으며 한 번 강하게 공격하고 자연스럽게 돌아오는 동작" },
    { label: "걷기 모션", text: "자연스러운 보행 사이클, 팔과 다리가 번갈아 움직이며 부드럽게 전진하는 동작" },
    { label: "점프 모션", text: "두 팔과 몸이 가볍게 위로 튀어 오르며 짧게 점프했다가 자연스럽게 착지하는 동작" },
    { label: "달리기 모션", text: "몸을 약간 앞으로 기울이며 팔을 힘차게 흔들고 빠르게 달리는 동작" },
    { label: "대기 모션", text: "가만히 서서 아주 미세하게 호흡하고 몸이 살짝 흔들리는 자연스러운 대기 동작" },
  ],
  object: [
    { label: "코인 회전", text: "동전이 Y축으로 빙글빙글 회전하며 반짝이는 동작" },
    { label: "보물 상자 열림", text: "뚜껑이 천천히 열리며 빛이 흘러나오는 동작" },
    { label: "불꽃 흔들림", text: "촛불이나 모닥불이 부드럽게 좌우로 흔들리는 동작" },
    { label: "아이템 부유", text: "아이템이 천천히 위아래로 떠다니며 은은하게 빛나는 루프 동작" },
  ],
  "character-effect": [
    { label: "공격 이펙트", text: "빠른 검 궤적과 빛 잔상이 대각선으로 지나가는 슬래시 이펙트" },
    { label: "마법 폭발", text: "중앙에서 바깥으로 퍼지는 강렬한 마법 폭발, 파티클이 사방으로 흩어지는 동작" },
    { label: "힐 이펙트", text: "아래에서 위로 올라오는 부드러운 녹색 빛 파티클, 치유의 기운이 감도는 동작" },
    { label: "방어막 이펙트", text: "캐릭터 주변을 둘러싸는 에너지 방어막이 생겼다가 사라지는 동작" },
  ],
  "object-effect": [
    { label: "획득 이펙트", text: "아이템 위에서 반짝이는 빛 파티클이 방사형으로 흩어지는 동작" },
    { label: "파괴 이펙트", text: "오브젝트가 산산조각 나며 파편이 사방으로 흩어지고 먼지가 피어오르는 동작" },
    { label: "상호작용 이펙트", text: "오브젝트 주변에 빛나는 테두리와 스파크가 생겼다 사라지는 동작" },
    { label: "등장 이펙트", text: "오브젝트 아래에서 빛이 수직으로 솟구치며 나타나는 연출" },
  ],
};

const RECENT_KEY = "sprite-recent-actions";
const RECENT_MAX = 5;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(action: string) {
  if (typeof window === "undefined") return;
  const trimmed = action.trim();
  if (trimmed.length < 20) return;
  const prev = loadRecents().filter(x => x !== trimmed);
  const next = [trimmed, ...prev].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function SpriteGenPanel({
  referenceId,
  referenceImageUrl,
  initialSubjectMode,
  onSubmit,
  onClose,
}: Props) {
  // contextMode: 캐릭터 모드 or 오브젝트 모드
  const [contextMode, setContextMode] = useState<ContextMode>(initialSubjectMode ?? "character");
  // tab: "subject"(캐릭터 또는 오브젝트) or "effect"
  const [tab, setTab] = useState<"subject" | "effect">("subject");

  // tab + contextMode → subjectType
  const subjectType: SubjectType = tab === "effect" ? "effect" : contextMode;

  const [direction, setDirection] = useState<Direction>("DOWN");
  const [frames, setFrames] = useState<FrameCount>(8);
  const [stylePresetId, setStylePresetId] = useState<string | null>(null);
  const [seamlessLoop, setSeamlessLoop] = useState(true);
  const [actionPrompt, setActionPrompt] = useState("");

  const [dirOpen, setDirOpen] = useState(false);
  const [frameOpen, setFrameOpen] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [submitting, setSubmitting] = useState(false);

  const grid = FRAME_OPTS.find(f => f.value === frames) ?? { rows: 2, cols: 4 };
  const canSubmit = actionPrompt.trim().length > 0 && !submitting;

  // 탭·모드 전환 시 AI 결과/에러 초기화
  function switchTab(t: "subject" | "effect") {
    setTab(t);
    setExampleOpen(false);
    setAiResult(null);
    setAiError(null);
  }

  function switchContextMode(mode: ContextMode) {
    setContextMode(mode);
    setTab("subject");
    setExampleOpen(false);
    setAiResult(null);
    setAiError(null);
  }

  // 이펙트 탭용 exampleKey — 컨텍스트(character-effect | object-effect)
  const exampleKey: ExampleKey = tab === "subject"
    ? contextMode
    : `${contextMode}-effect` as ExampleKey;

  async function handleAiSuggest() {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    const question = actionPrompt.trim() || "동작을 추천해주세요";
    try {
      const res = await fetch("/api/sprite-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          subjectType,
          contextType: tab === "effect" ? contextMode : undefined,
          direction: subjectType === "character" ? direction : undefined,
          frames,
          seamlessLoop,
        }),
      });
      const data = (await res.json()) as { suggestion?: string; error?: string };
      if (!res.ok || !data.suggestion) {
        setAiError(data.error ?? "제안 생성에 실패했습니다.");
        return;
      }
      setAiResult(data.suggestion);
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const suffix = await resolveStyleSuffix(stylePresetId);
      const state: SpriteGenState = {
        subjectType,
        contextType: contextMode,
        direction,
        frames,
        stylePresetId,
        seamlessLoop,
        actionPrompt: actionPrompt.trim(),
      };
      const msg = buildSpriteMessage(state, suffix, referenceId ?? null);
      saveRecent(state.actionPrompt);
      setRecents(loadRecents());
      onSubmit([msg]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Grid3x3 size={14} /> 스프라이트시트 생성
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-4 overflow-y-auto p-3">
        {/* 참조 이미지 썸네일 */}
        {referenceImageUrl && (
          <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-bg-card p-2">
            <div className="overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={referenceImageUrl}
                alt="참조"
                className="block h-14 w-14 object-contain"
              />
            </div>
            <div className="min-w-0 text-xs">
              <div className="text-text-primary">참조 이미지</div>
              <div className="truncate text-text-muted/70">
                {referenceId?.slice(0, 12)}…
              </div>
            </div>
          </div>
        )}

        {/* 2-탭 — contextMode 에 따라 [캐릭터|이펙트] 또는 [오브젝트|이펙트] */}
        <div className="shrink-0 space-y-1.5">
          <div className="flex gap-1 rounded-lg border border-border bg-bg-card p-1 text-xs">
            <button
              onClick={() => switchTab("subject")}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                tab === "subject"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {contextMode === "character" ? "캐릭터" : "오브젝트"}
            </button>
            <button
              onClick={() => switchTab("effect")}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                tab === "effect"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              이펙트
            </button>
          </div>
          {/* 모드 전환 링크 */}
          <div className="flex justify-end">
            <button
              onClick={() => switchContextMode(contextMode === "character" ? "object" : "character")}
              className="text-[11px] text-text-muted/50 hover:text-text-muted"
            >
              {contextMode === "character" ? "오브젝트 모드로 전환 →" : "캐릭터 모드로 전환 →"}
            </button>
          </div>
        </div>

        {/* 옵션 줄 — 방향(캐릭터 탭만) + 프레임 + 스타일 + 루프 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {subjectType === "character" && (
            <div className="relative">
              <button
                onClick={() => {
                  setDirOpen(o => !o);
                  setFrameOpen(false);
                }}
                className="flex h-8 items-center gap-1 rounded-lg border border-border bg-bg-card px-3 text-xs text-text-primary hover:border-[color:var(--accent)]/40"
              >
                {DIRECTION_LABELS[direction]}
              </button>
              {dirOpen && (
                <DirectionPopover
                  selected={direction}
                  onSelect={d => {
                    setDirection(d);
                    setDirOpen(false);
                  }}
                  onClose={() => setDirOpen(false)}
                />
              )}
            </div>
          )}

          <div className="relative">
            <button
              onClick={() => {
                setFrameOpen(o => !o);
                setDirOpen(false);
              }}
              className="flex h-8 items-center gap-1 rounded-lg border border-border bg-bg-card px-3 text-xs text-text-primary hover:border-[color:var(--accent)]/40"
            >
              {frames}프레임 {grid.rows}×{grid.cols}
            </button>
            {frameOpen && (
              <FramePopover
                selected={frames}
                onSelect={f => {
                  setFrames(f);
                  setFrameOpen(false);
                }}
                onClose={() => setFrameOpen(false)}
              />
            )}
          </div>

          <StylePresetPicker value={stylePresetId} onChange={setStylePresetId} popoverDirection="down" />

          <label className="flex cursor-pointer items-center gap-1 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={seamlessLoop}
              onChange={e => setSeamlessLoop(e.target.checked)}
            />
            루프
          </label>
        </div>

        {/* 동작 프롬프트 */}
        <div className="shrink-0 space-y-1">
          <div className="flex items-center gap-2">
            <label className="text-xs text-text-muted">동작</label>
            <div className="ml-auto flex items-center gap-1">
              <div className="relative">
                <button
                  onClick={() => setExampleOpen(o => !o)}
                  className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted hover:text-text-primary"
                >
                  <Lightbulb size={12} /> 예시
                </button>
                {exampleOpen && (
                  <ExamplePopover
                    exampleKey={exampleKey}
                    onPick={text => {
                      setActionPrompt(text);
                      setExampleOpen(false);
                    }}
                    onClose={() => setExampleOpen(false)}
                  />
                )}
              </div>
              <button
                onClick={handleAiSuggest}
                disabled={aiLoading}
                className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs ${
                  aiLoading
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border text-text-muted hover:text-text-primary"
                } disabled:opacity-60`}
              >
                <Sparkles size={12} /> {aiLoading ? "생각 중…" : "AI 제안"}
              </button>
            </div>
          </div>

          <textarea
            value={actionPrompt}
            onChange={e => setActionPrompt(e.target.value)}
            placeholder="어떤 동작을 만들지 설명하세요 (예시·AI 제안 활용 가능)"
            rows={3}
            className="block min-h-[78px] w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
          />

          {/* 걷기·달리기 추천 힌트 — 캐릭터 탭만 */}
          {subjectType === "character" && (
            <p className="text-[11px] text-text-muted/60 leading-relaxed">
              걷기·달리기는 <span className="text-text-muted">8프레임(2×4)</span> + <span className="text-text-muted">루프 켜기</span> 추천
            </p>
          )}

          {/* AI 제안 결과 */}
          {(aiError || aiResult) && (
            <div className="space-y-1 rounded-lg border border-border bg-bg-card p-2">
              {aiError && (
                <p className="text-[11px] text-[color:var(--danger)]">{aiError}</p>
              )}
              {aiResult && (
                <>
                  <p className="text-xs text-text-primary">{aiResult}</p>
                  <button
                    onClick={() => {
                      setActionPrompt(aiResult);
                      setAiResult(null);
                    }}
                    className="rounded border border-[color:var(--accent)]/50 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
                  >
                    적용
                  </button>
                </>
              )}
            </div>
          )}

          {/* 최근 동작 chips */}
          {recents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              <span className="text-[11px] text-text-muted/70">최근:</span>
              {recents.map(r => (
                <button
                  key={r}
                  onClick={() => setActionPrompt(r)}
                  title={r}
                  className="rounded-full border border-border bg-bg-card px-2 py-0.5 text-[11px] text-text-muted hover:border-[color:var(--accent)]/40 hover:text-text-primary"
                >
                  {r.length > 15 ? r.slice(0, 15) + "…" : r}
                </button>
              ))}
            </div>
          )}
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
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="flex h-9 flex-[2] items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          title={canSubmit ? "" : "동작 설명을 입력하세요"}
        >
          <Sparkles size={14} /> 생성하기
        </button>
      </footer>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 팝오버들

function DirectionPopover({
  selected,
  onSelect,
  onClose,
}: {
  selected: Direction;
  onSelect: (d: Direction) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose);
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-1 w-[180px] rounded-xl border border-border bg-bg-panel p-2 shadow-xl"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {COMPASS.map((d, i) =>
          d === null ? (
            <span key={i} />
          ) : (
            <button
              key={d}
              onClick={() => onSelect(d)}
              title={DIRECTION_LABELS[d]}
              className={`flex h-12 w-full flex-col items-center justify-center gap-0.5 rounded-lg border text-base leading-none ${
                selected === d
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border bg-bg-card text-text-muted hover:border-[color:var(--accent)]/40 hover:text-text-primary"
              }`}
            >
              <span>{DIRECTION_SYMBOLS[d]}</span>
              {(d === "DOWN" || d === "UP" || d === "LEFT" || d === "RIGHT") && (
                <span className="text-[9px] leading-none opacity-60">
                  {d === "DOWN" ? "정면" : d === "UP" ? "뒤" : d === "LEFT" ? "좌" : "우"}
                </span>
              )}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

function FramePopover({
  selected,
  onSelect,
  onClose,
}: {
  selected: FrameCount;
  onSelect: (f: FrameCount) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose);
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-1 w-[240px] rounded-xl border border-border bg-bg-panel p-2 shadow-xl"
    >
      <div className="grid grid-cols-2 gap-2">
        {FRAME_OPTS.map(f => {
          const active = selected === f.value;
          return (
            <button
              key={f.value}
              onClick={() => onSelect(f.value)}
              className={`relative rounded-lg border p-3 text-left text-xs ${
                active
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border bg-bg-card text-text-muted hover:border-[color:var(--accent)]/40"
              }`}
            >
              <div className="font-medium text-text-primary">{f.value}프레임</div>
              <div className="text-[11px] text-text-muted/70">
                {f.rows}×{f.cols}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExamplePopover({
  exampleKey,
  onPick,
  onClose,
}: {
  exampleKey: ExampleKey;
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose);
  return (
    <div
      ref={ref}
      className="absolute right-0 top-full z-30 mt-1 w-[320px] space-y-1 rounded-xl border border-border bg-bg-panel p-2 shadow-xl"
    >
      {EXAMPLES[exampleKey].map((ex, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-lg border border-border bg-bg-card p-2 text-xs"
        >
          <div className="min-w-0 flex-1">
            <div className="font-medium text-text-primary">{ex.label}</div>
            <div className="mt-0.5 text-[11px] text-text-muted/80">{ex.text}</div>
          </div>
          <button
            onClick={() => onPick(ex.text)}
            className="shrink-0 rounded border border-[color:var(--accent)]/50 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
          >
            선택
          </button>
        </div>
      ))}
    </div>
  );
}

function useOutsideClose(
  ref: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [ref, onClose]);
}

// ────────────────────────────────────────────────────────────────────────────
// 메시지 빌더 + 스타일 suffix 해석

function facingPhrase(label: Direction): string {
  if (label.startsWith("DOWN-")) return `facing ${label} (3/4 front view)`;
  if (label.startsWith("UP-")) return `facing ${label} (3/4 back view)`;
  if (label.startsWith("DOWN")) return "facing DOWN (front view)";
  if (label.startsWith("UP")) return "facing UP (back view)";
  if (label === "LEFT") return "facing LEFT (side view)";
  if (label === "RIGHT") return "facing RIGHT (side view)";
  return `facing ${label}`;
}

export function buildSpriteMessage(
  state: SpriteGenState,
  stylePresetSuffix?: string | null,
  referenceId?: string | null,
): { message: string; attachmentGenerationIds: string[] } {
  const isCharacter = state.subjectType === "character";
  const anchor = isCharacter ? "feet" : "center";
  const grid = FRAME_OPTS.find(f => f.value === state.frames) ?? { rows: 2, cols: 4 };

  const directive =
    `[spritesheet: subjectType=${state.subjectType}; anchorStrategy=${anchor}; ` +
    `framesPerDir=${state.frames}; rows=${grid.rows}; cols=${grid.cols}; ` +
    `seamlessLoop=${state.seamlessLoop}]`;

  const nlParts: string[] = [state.actionPrompt];
  if (stylePresetSuffix) nlParts.push(stylePresetSuffix);
  if (isCharacter) nlParts.push(facingPhrase(state.direction));
  nlParts.push("transparent background");
  const nl = nlParts.join(", ");

  return {
    message: `${directive}\n${nl}`,
    attachmentGenerationIds: referenceId ? [referenceId] : [],
  };
}

export async function resolveStyleSuffix(presetId: string | null): Promise<string | null> {
  if (!presetId) return null;
  try {
    const all = await listPresets();
    return all.find(p => p.id === presetId)?.prompt_suffix ?? null;
  } catch {
    return null;
  }
}
