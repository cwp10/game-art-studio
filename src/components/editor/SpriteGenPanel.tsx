"use client";

import { Grid3x3, Lightbulb, Sparkles, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StylePresetPicker } from "@/components/library/StylePresetPicker";
import { listPresets } from "@/lib/api/client";

/**
 * SpriteGenPanel — 스프라이트시트 전용 생성 패널 (editor 오버레이, ChatLayout 우측).
 *
 * 피사체(캐릭터/이펙트/오브젝트) · 방향(캐릭터 전용) · 프레임 수 · 스타일 · 루프 ·
 * 동작 프롬프트를 구성해 한 장의 단일 방향 스트립 시트를 생성한다. 패널이 스타일
 * suffix 까지 해석해 완성된 메시지를 onSubmit 으로 부모(ChatLayout)에 넘긴다.
 *
 * 경계면: onSubmit 은 완성된 { message, attachmentGenerationIds } 배열을 받는다.
 * 마커 directive(rows=1; cols=frames; directions=1)는 그대로 make_spritesheet 로 흐르며,
 * server.ts 가 directions=1 단일 스트립은 auto-reshape 하지 않는다(explicitSingleStrip).
 */

export type SubjectType = "character" | "effect" | "object";
export type Direction =
  | "DOWN"
  | "LEFT"
  | "RIGHT"
  | "UP"
  | "DOWN-LEFT"
  | "DOWN-RIGHT"
  | "UP-LEFT"
  | "UP-RIGHT";
export type FrameCount = 4 | 9 | 16 | 25;

export type SpriteGenState = {
  subjectType: SubjectType;
  direction: Direction; // 캐릭터만 사용
  frames: FrameCount;
  stylePresetId: string | null;
  seamlessLoop: boolean;
  actionPrompt: string;
};

type Props = {
  /** 참조 이미지 generation ID (있으면 그 캐릭터를 모든 프레임에 참조). */
  referenceId?: string;
  /** 참조 썸네일 URL. */
  referenceImageUrl?: string;
  onSubmit: (
    messages: Array<{ message: string; attachmentGenerationIds: string[] }>,
  ) => void;
  onClose: () => void;
};

// 방향 버튼 라벨 (주요 4방향은 한글 포함, 대각은 화살표만).
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

// 팝오버 나침반 셀 전용 심볼 — charAt(0) 대신 명시적 맵 사용.
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

// 나침반 레이아웃(3×3, 중앙 비움) — 팝오버 그리드 순서.
const COMPASS: Array<Direction | null> = [
  "UP-LEFT", "UP", "UP-RIGHT",
  "LEFT", null, "RIGHT",
  "DOWN-LEFT", "DOWN", "DOWN-RIGHT",
];

// 프레임 옵션 — 정사각 그리드(미리보기) + 추천 뱃지.
const FRAME_OPTS: Array<{ value: FrameCount; side: number }> = [
  { value: 4, side: 2 },
  { value: 9, side: 3 },
  { value: 16, side: 4 },
  { value: 25, side: 5 },
];

// subjectType 별 예시 — 라벨 + 동작 묘사(actionPrompt 에 삽입).
const EXAMPLES: Record<SubjectType, Array<{ label: string; text: string }>> = {
  character: [
    { label: "공격 모션", text: "짧은 예비동작 후 몸을 빠르게 앞으로 실으며 한 번 강하게 공격하고 자연스럽게 돌아오는 동작" },
    { label: "걷기 모션", text: "자연스러운 보행 사이클, 팔과 다리가 번갈아 움직이며 부드럽게 전진하는 동작" },
    { label: "점프 모션", text: "두 팔과 몸이 가볍게 위로 튀어 오르며 짧게 점프했다가 자연스럽게 착지하는 동작" },
    { label: "달리기 모션", text: "몸을 약간 앞으로 기울이며 팔을 힘차게 흔들고 빠르게 달리는 동작" },
    { label: "대기 모션", text: "가만히 서서 아주 미세하게 호흡하고 몸이 살짝 흔들리는 자연스러운 대기 동작" },
  ],
  effect: [
    { label: "폭발 이펙트", text: "중앙에서 바깥으로 퍼지는 강렬한 폭발, 불꽃과 연기가 함께 퍼지는 동작" },
    { label: "번개 이펙트", text: "위에서 아래로 지그재그로 내리치는 날카로운 번개 줄기 동작" },
    { label: "슬래시 이펙트", text: "대각선으로 빠르게 지나가는 검 궤적, 빛나는 잔상이 남는 동작" },
    { label: "힐 이펙트", text: "아래에서 위로 올라오는 부드러운 녹색 빛 파티클 동작" },
  ],
  object: [
    { label: "코인 회전", text: "동전이 Y축으로 빙글빙글 회전하며 반짝이는 동작" },
    { label: "보물 상자 열림", text: "뚜껑이 천천히 열리며 빛이 흘러나오는 동작" },
    { label: "불꽃 흔들림", text: "촛불이나 모닥불이 부드럽게 좌우로 흔들리는 동작" },
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
  if (trimmed.length < 20) return; // 20자 이상만 저장
  const prev = loadRecents().filter(x => x !== trimmed);
  const next = [trimmed, ...prev].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function SpriteGenPanel({ referenceId, referenceImageUrl, onSubmit, onClose }: Props) {
  const [subjectType, setSubjectType] = useState<SubjectType>("character");
  const [direction, setDirection] = useState<Direction>("DOWN");
  const [frames, setFrames] = useState<FrameCount>(9);
  const [stylePresetId, setStylePresetId] = useState<string | null>(null);
  const [seamlessLoop, setSeamlessLoop] = useState(true);
  const [actionPrompt, setActionPrompt] = useState("");

  // 팝오버 토글
  const [dirOpen, setDirOpen] = useState(false);
  const [frameOpen, setFrameOpen] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);

  // AI 제안
  const [aiOpen, setAiOpen] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // 마운트 시점 1회 로드 — 패널은 클라이언트 오버레이로만 마운트되므로 lazy initializer 안전.
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [submitting, setSubmitting] = useState(false);

  const side = FRAME_OPTS.find(f => f.value === frames)?.side ?? 2;
  const canSubmit = actionPrompt.trim().length > 0 && !submitting;

  async function handleAiSuggest() {
    const q = aiQuestion.trim();
    if (!q || aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiResult(null);
    try {
      const res = await fetch("/api/sprite-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          subjectType,
          direction: subjectType === "character" ? direction : undefined,
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

        {/* 세그먼트 탭 — 피사체 종류 */}
        <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-xs">
          {(["character", "effect", "object"] as const).map(s => (
            <button
              key={s}
              onClick={() => {
                setSubjectType(s);
                setExampleOpen(false);
              }}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                subjectType === s
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {s === "character" ? "캐릭터" : s === "effect" ? "이펙트" : "오브젝트"}
            </button>
          ))}
        </div>

        {/* 옵션 줄 — 방향 + 프레임 + 스타일 + 루프 */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
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

          <div className="relative">
            <button
              onClick={() => {
                setFrameOpen(o => !o);
                setDirOpen(false);
              }}
              className="flex h-8 items-center gap-1 rounded-lg border border-border bg-bg-card px-3 text-xs text-text-primary hover:border-[color:var(--accent)]/40"
            >
              {frames}프레임 {side}×{side}
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
                  onClick={() => {
                    setExampleOpen(o => !o);
                  }}
                  className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted hover:text-text-primary"
                >
                  <Lightbulb size={12} /> 예시
                </button>
                {exampleOpen && (
                  <ExamplePopover
                    subjectType={subjectType}
                    onPick={text => {
                      setActionPrompt(text);
                      setExampleOpen(false);
                    }}
                    onClose={() => setExampleOpen(false)}
                  />
                )}
              </div>
              <button
                onClick={() => setAiOpen(o => !o)}
                className={`flex h-7 items-center gap-1 rounded-md border px-2 text-xs ${
                  aiOpen
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border text-text-muted hover:text-text-primary"
                }`}
              >
                <Sparkles size={12} /> AI 제안
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

          {/* AI 제안 미니 입력창 */}
          {aiOpen && (
            <div className="space-y-2 rounded-lg border border-border bg-bg-card p-2">
              <div className="flex items-center gap-2">
                <input
                  value={aiQuestion}
                  onChange={e => setAiQuestion(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      handleAiSuggest();
                    }
                  }}
                  placeholder="어떤 동작이 필요한지 물어보세요..."
                  className="h-8 flex-1 rounded-md border border-border bg-bg-app px-2 text-xs text-text-primary outline-none placeholder:text-text-muted/40"
                />
                <button
                  onClick={handleAiSuggest}
                  disabled={aiLoading || !aiQuestion.trim()}
                  className="flex h-8 w-8 items-center justify-center rounded-md bg-[color:var(--accent)] text-white disabled:opacity-40"
                  title="제안 받기"
                >
                  <Send size={13} />
                </button>
              </div>
              {aiLoading && <p className="text-[11px] text-text-muted">생각 중…</p>}
              {aiError && (
                <p className="text-[11px] text-[color:var(--danger)]">{aiError}</p>
              )}
              {aiResult && (
                <div className="space-y-1 rounded-md border border-border bg-bg-app/60 p-2">
                  <p className="text-xs text-text-primary">{aiResult}</p>
                  <button
                    onClick={() => {
                      setActionPrompt(aiResult);
                      setAiResult(null);
                      setAiOpen(false);
                    }}
                    className="rounded border border-[color:var(--accent)]/50 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
                  >
                    적용
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 최근 동작 chips */}
          {recents.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 pt-1">
              <span className="text-[11px] text-text-muted/70">최근:</span>
              {recents.map((r) => (
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
                {f.side}×{f.side}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ExamplePopover({
  subjectType,
  onPick,
  onClose,
}: {
  subjectType: SubjectType;
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
      {EXAMPLES[subjectType].map((ex, i) => (
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

// 바깥 클릭 시 닫기 — StylePresetPicker 와 동일 패턴(mousedown outside).
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

/**
 * directionLabel → make_spritesheet 자연어 facing 구. 측면은 side view, 정/후면은
 * front/back view, 대각은 3/4 view. (기존 facingPhrase 분기 유지.)
 */
function facingPhrase(label: Direction): string {
  if (label.startsWith("DOWN-")) return `facing ${label} (3/4 front view)`;
  if (label.startsWith("UP-")) return `facing ${label} (3/4 back view)`;
  if (label.startsWith("DOWN")) return "facing DOWN (front view)";
  if (label.startsWith("UP")) return "facing UP (back view)";
  if (label === "LEFT") return "facing LEFT (side view)";
  if (label === "RIGHT") return "facing RIGHT (side view)";
  return `facing ${label}`;
}

/**
 * SpriteGenState → { message, attachmentGenerationIds } 순수 빌더.
 *
 * 마커(계약 — 키 이름은 make_spritesheet 입력명과 일치): 단일 방향 1행 스트립.
 *   [spritesheet: subjectType=character; anchorStrategy=feet; directions=1; framesPerDir=9; rows=1; cols=9; seamlessLoop=true]
 * - 캐릭터: anchorStrategy=feet, 자연어에 facingPhrase 포함.
 * - 이펙트/오브젝트: anchorStrategy=center, facingPhrase 생략.
 *
 * directions=1 이라 server.ts 가 1×N 스트립을 auto-reshape 하지 않는다(explicitSingleStrip).
 * 참조는 마커가 아니라 attachmentGenerationIds 로 전달 → /api/chat 이 [reference: id] prefix.
 */
export function buildSpriteMessage(
  state: SpriteGenState,
  stylePresetSuffix?: string | null,
  referenceId?: string | null,
): { message: string; attachmentGenerationIds: string[] } {
  const isCharacter = state.subjectType === "character";
  const anchor = isCharacter ? "feet" : "center";

  const directive =
    `[spritesheet: subjectType=${state.subjectType}; anchorStrategy=${anchor}; ` +
    `directions=1; framesPerDir=${state.frames}; rows=1; cols=${state.frames}; ` +
    `seamlessLoop=${state.seamlessLoop}]`;

  const nlParts: string[] = [state.actionPrompt];
  if (stylePresetSuffix) nlParts.push(stylePresetSuffix);
  nlParts.push(facingPhrase(state.direction));
  nlParts.push("transparent background");
  const nl = nlParts.join(", ");

  return {
    message: `${directive}\n${nl}`,
    attachmentGenerationIds: referenceId ? [referenceId] : [],
  };
}

// presetId → prompt_suffix 해석. listPresets 1회 조회 — 가벼움(기존 로직 유지).
export async function resolveStyleSuffix(presetId: string | null): Promise<string | null> {
  if (!presetId) return null;
  try {
    const all = await listPresets();
    return all.find(p => p.id === presetId)?.prompt_suffix ?? null;
  } catch {
    return null;
  }
}
