"use client";

import { ArrowLeft, Lightbulb, Loader2, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AiSuggestButton, AiSuggestDropdown, type AiSuggestion } from "@/components/editor/AiSuggestControls";
import { useIsCodex } from "@/lib/context/orchestrator-context";


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
export type Perspective = "side" | "topdown" | "isometric" | "2.5d-topdown";
export type Direction =
  | "DOWN"
  | "LEFT"
  | "RIGHT"
  | "UP"
  | "DOWN-LEFT"
  | "DOWN-RIGHT"
  | "UP-LEFT"
  | "UP-RIGHT"
  | "REF";
export type FrameCount = 4 | 6 | 8 | 9 | 12 | 16;
export type EffectType = "attack" | "explosion" | "trail" | "buff" | "ambient";

export type SpriteGenState = {
  subjectType: SubjectType;
  direction: Direction;
  frames: FrameCount;
  seamlessLoop: boolean;
  actionPrompt: string;
  perspective?: Perspective;
  effectType?: EffectType;
};

type Props = {
  /** 참조 이미지 generation ID (있으면 그 캐릭터/오브젝트를 모든 프레임에 참조). */
  referenceId?: string;
  /** 참조 썸네일 URL. */
  referenceImageUrl?: string;
  /** 참조 이미지 생성 프롬프트 — 이펙트 탭 AI 제안에서 캐릭터/오브젝트 추론에 사용. */
  referencePrompt?: string;
  /** 패널 초기 컨텍스트. "character" → 캐릭터|이펙트, "object" → 오브젝트|이펙트. */
  initialSubjectMode?: ContextMode;
  onSubmit: (
    messages: Array<{ message: string; attachmentGenerationIds: string[] }>,
  ) => void;
  busy?: boolean;
  onClose: () => void;
  onCancel?: () => void;
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
  REF: "↻ 참조",
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
  REF: "↻",
};

const COMPASS: Array<Direction | null> = [
  "UP-LEFT", "UP",  "UP-RIGHT",
  "LEFT",    "REF", "RIGHT",
  "DOWN-LEFT","DOWN","DOWN-RIGHT",
];

const FRAME_OPTS: Array<{ value: FrameCount; rows: number; cols: number }> = [
  { value: 4,  rows: 2, cols: 2 },
  { value: 6,  rows: 2, cols: 3 },
  { value: 8,  rows: 2, cols: 4 },
  { value: 9,  rows: 3, cols: 3 },
  { value: 12, rows: 4, cols: 3 },
  { value: 16, rows: 4, cols: 4 },
];

// 이펙트 탭 전용 — 정사각형 그리드만 (VFX는 방향성이 없어 정사각형이 자연스러움)
const EFFECT_FRAME_OPTS = FRAME_OPTS.filter(f => f.rows === f.cols);

const EFFECT_TYPES: Array<{ value: EffectType; label: string; phrase: string }> = [
  { value: "attack",    label: "공격",  phrase: "directional strike or slash effect, motion toward an impact point" },
  { value: "explosion", label: "폭발",  phrase: "radiates outward from a center point, expands then dissipates into smoke" },
  { value: "trail",     label: "궤적",  phrase: "trailing motion path effect, fading streaks following the direction of movement" },
  { value: "buff",      label: "버프",  phrase: "aura or orbiting particle effect surrounding a central subject" },
  { value: "ambient",   label: "주변",  phrase: "subtle ambient particles, gentle drifting environmental effect" },
];

// 동작 텍스트 키워드 → 프레임·루프 자동 추천 (애니메이션 드롭다운 대체)
const ACTION_FRAME_HINTS: Array<{ pattern: RegExp; frames: FrameCount; loop: boolean }> = [
  { pattern: /걷기|보행|walk(ing)?/, frames: 8, loop: true },
  { pattern: /달리기|뛰기|run(ning)?|sprint/, frames: 8, loop: true },
  { pattern: /대기|idle|호흡|breath(ing)?|서있/, frames: 4, loop: true },
  { pattern: /공격|attack|slash|swing|때리|strike/, frames: 6, loop: false },
  { pattern: /점프|jump|도약|leap/, frames: 6, loop: false },
  { pattern: /사망|죽음|die|death|fall(ing)? down/, frames: 6, loop: false },
  { pattern: /시전|cast(ing)?|마법|magic|spell|스킬|skill/, frames: 8, loop: false },
  { pattern: /피격|움찔|경직|hurt|flinch|knockback/, frames: 4, loop: false },
];

// gpt-image-2 캔버스 하드 제약 — 셀 384px 고정 × 그리드(rows×cols)
// 실측 built-in tool 한계: 한 변 최대 1536px(CELL_PX=384 × 4). MCP server.ts 검증과 동일.
const SPRITE_CELL_PX = 384;
const API_MAX_PX = 1_536 * 1_536; // = 2_359_296 (최대 픽셀, 4×4)
const API_MAX_EDGE = 1_536; // 최대 한 변 (CELL_PX=384 × 4)
const API_MAX_RATIO = 3; // 장축/단축 종횡비

function frameCanvasInfo(rows: number, cols: number): {
  w: number; h: number; totalPx: number;
  status: "safe" | "near" | "over";
} {
  const w = cols * SPRITE_CELL_PX;
  const h = rows * SPRITE_CELL_PX;
  const totalPx = w * h;
  const maxEdge = Math.max(w, h);
  const ratio = maxEdge / Math.min(w, h);
  // px 는 >= 로 한계 동치(4×4=2.36M)도 초과 표시. edge·ratio 는 strict > 유지
  // (12프레임 높이 1536px 가 한계 동치라 >= 면 잘못 초과 처리됨).
  const isOver = totalPx >= API_MAX_PX || maxEdge > API_MAX_EDGE || ratio > API_MAX_RATIO;
  const isNear = !isOver && totalPx > API_MAX_PX * 0.72; // ≈ 1.7M px
  return { w, h, totalPx, status: isOver ? "over" : isNear ? "near" : "safe" };
}

type ExampleKey = "character" | "object" | "effect";

const EXAMPLES: Record<ExampleKey, Array<{ label: string; text: string }>> = {
  character: [
    { label: "대기 모션", text: "가만히 서서 아주 미세하게 호흡하고 몸이 살짝 흔들리는 자연스러운 대기 동작" },
    { label: "공격 모션", text: "짧은 예비동작 후 몸을 빠르게 앞으로 실으며 한 번 강하게 공격하고 자연스럽게 돌아오는 동작" },
    { label: "스킬 모션", text: "기를 모으듯 잠시 자세를 잡았다가 마법을 시전하며 강한 기운이 터져 나오는 스킬 동작" },
    { label: "달리기 모션", text: "몸을 약간 앞으로 기울이며 팔을 힘차게 흔들고 빠르게 달리는 동작" },
    { label: "피격 모션", text: "적의 일격에 몸이 뒤로 움찔 젖혀지며 잠깐 경직됐다가 자세를 회복하는 피격 동작" },
    { label: "사망 모션", text: "치명타를 맞고 힘없이 비틀거리다 바닥으로 쓰러져 사망하는 동작" },
  ],
  object: [
    { label: "코인 회전", text: "동전이 Y축으로 빙글빙글 회전하며 반짝이는 동작" },
    { label: "보물 상자 열림", text: "뚜껑이 천천히 열리며 빛이 흘러나오는 동작" },
    { label: "불꽃 흔들림", text: "촛불이나 모닥불이 부드럽게 좌우로 흔들리는 동작" },
    { label: "아이템 부유", text: "아이템이 천천히 위아래로 떠다니며 은은하게 빛나는 루프 동작" },
  ],
  effect: [
    { label: "공격 이펙트", text: "빠른 검 궤적과 빛 잔상이 대각선으로 지나가는 슬래시 이펙트" },
    { label: "마법 폭발", text: "중앙에서 바깥으로 퍼지는 강렬한 마법 폭발, 파티클이 사방으로 흩어지는 동작" },
    { label: "힐 이펙트", text: "아래에서 위로 올라오는 부드러운 녹색 빛 파티클, 치유의 기운이 감도는 동작" },
    { label: "획득 이펙트", text: "아이템 위에서 반짝이는 빛 파티클이 방사형으로 흩어지는 동작" },
    { label: "파괴 이펙트", text: "오브젝트가 산산조각 나며 파편이 사방으로 흩어지고 먼지가 피어오르는 동작" },
  ],
};

const RECENT_MAX = 5;

function recentKey(key: ExampleKey) { return `sprite-recent-${key}`; }

function loadRecents(key: ExampleKey): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentKey(key));
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveRecent(key: ExampleKey, action: string) {
  if (typeof window === "undefined") return;
  const trimmed = action.trim();
  if (trimmed.length < 20) return;
  const prev = loadRecents(key).filter(x => x !== trimmed);
  const next = [trimmed, ...prev].slice(0, RECENT_MAX);
  try {
    window.localStorage.setItem(recentKey(key), JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
}

export function SpriteGenPanel({
  referenceId,
  referenceImageUrl,
  referencePrompt,
  initialSubjectMode,
  onSubmit,
  busy = false,
  onClose,
  onCancel,
}: Props) {
  const [subjectType, setSubjectType] = useState<SubjectType>(initialSubjectMode ?? "character");
  const [direction, setDirection] = useState<Direction>(referenceImageUrl ? "REF" : "DOWN");
  const [frames, setFrames] = useState<FrameCount>(8);
  const [seamlessLoop, setSeamlessLoop] = useState(true);
  const [effectType, setEffectType] = useState<EffectType>("explosion");
  const [actionPrompt, setActionPrompt] = useState("");
  const [perspective, setPerspective] = useState<Perspective>("side");
  // 사용자가 직접 프레임을 변경했는지 추적 — true면 자동 추천 덮어쓰기 안 함
  const [userSetFrames, setUserSetFrames] = useState(false);

  // 참조 이미지 연결·해제 시 방향 자동 전환 — 함수형 업데이트로 stale closure 방지
  useEffect(() => {
    if (referenceImageUrl) {
      // 참조 이미지 연결 시 방향을 REF 로 동기화 — 외부 prop 변화에 대한 동기화.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDirection("REF");
    } else {
      setDirection(prev => prev === "REF" ? "DOWN" : prev);
    }
  }, [referenceImageUrl]);

  // 동작 텍스트 변경 시 자동 프레임·루프 추천 (사용자가 직접 설정하지 않은 경우만)
  useEffect(() => {
    if (userSetFrames || !actionPrompt.trim()) return;
    const lower = actionPrompt.toLowerCase();
    for (const hint of ACTION_FRAME_HINTS) {
      if (hint.pattern.test(lower)) {
        // 동작 텍스트(외부 입력) 변화에 맞춘 프레임·루프 자동 추천 동기화.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setFrames(hint.frames);
        setSeamlessLoop(hint.loop);
        break;
      }
    }
  }, [actionPrompt, userSetFrames]);

  const [dirOpen, setDirOpen] = useState(false);
  const [frameOpen, setFrameOpen] = useState(false);
  const [exampleOpen, setExampleOpen] = useState(false);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[] | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const isCodex = useIsCodex();

  const [submitting, setSubmitting] = useState(false);

  const grid = FRAME_OPTS.find(f => f.value === frames) ?? { rows: 2, cols: 4 };
  const canSubmit = actionPrompt.trim().length > 0 && !submitting && !busy;

  function handleSubjectChange(s: SubjectType) {
    setSubjectType(s);
    setExampleOpen(false);
    setAiSuggestions(null);
    setAiError(null);
    if (s === "effect") {
      setSeamlessLoop(false);
      if (!EFFECT_FRAME_OPTS.find(f => f.value === frames)) setFrames(9);
    } else {
      setSeamlessLoop(true);
    }
  }

  const exampleKey: ExampleKey = subjectType === "effect" ? "effect" : subjectType;

  // 카테고리별 최근 프롬프트 — exampleKey 변경 시 갱신
  const [recents, setRecents] = useState<string[]>(() => loadRecents(exampleKey));
  useEffect(() => {
    // 카테고리(exampleKey) 변경 시 localStorage 에서 최근 목록 재로드 — 외부 저장소 동기화.
    // (recents 는 saveRecent 로도 쓰이므로 render-derived 로 만들 수 없음)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRecents(loadRecents(exampleKey));
  }, [exampleKey]);

  async function handleAiSuggest() {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    setAiSuggestions(null);
    const question = actionPrompt.trim() || "동작을 추천해주세요";
    try {
      const res = await fetch("/api/sprite-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          subjectType,
          referencePrompt: subjectType === "effect" ? referencePrompt : undefined,
          direction: subjectType === "character" && direction !== "REF" ? direction : undefined,
          frames,
          seamlessLoop,
        }),
      });
      const data = (await res.json()) as { suggestions?: AiSuggestion[]; error?: string };
      if (!res.ok || !data.suggestions?.length) {
        setAiError(data.error ?? "제안 생성에 실패했습니다.");
        return;
      }
      setAiSuggestions(data.suggestions);
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
        const state: SpriteGenState = {
        subjectType,
        direction,
        frames,
        seamlessLoop,
        actionPrompt: actionPrompt.trim(),
        perspective,
        effectType: subjectType === "effect" ? effectType : undefined,
      };
      const msg = buildSpriteMessage(state, null, referenceId ?? null);
      saveRecent(exampleKey, state.actionPrompt);
      setRecents(loadRecents(exampleKey));
      onSubmit([msg]);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-[50px] flex-none items-center gap-3 border-b border-border px-3.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
          title="대화로 돌아가기"
        >
          <ArrowLeft size={14} /> 대화로 돌아가기
        </button>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium text-text-primary">스프라이트시트 생성</span>
          <span className="text-[11px] text-text-muted">방향·프레임 스프라이트시트를 생성합니다</span>
        </div>
      </header>

      {/* 상단 툴스트립 — 캐릭터/오브젝트/이펙트(+이펙트 종류). 캔버스 도구 스트립 자리. */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
        <div className="flex gap-1 rounded-lg border border-border bg-bg-card p-0.5">
          {([
            { value: "character", label: "캐릭터" },
            { value: "object",    label: "오브젝트" },
            { value: "effect",    label: "이펙트" },
          ] as { value: SubjectType; label: string }[]).map(opt => (
            <button
              key={opt.value}
              onClick={() => handleSubjectChange(opt.value)}
              className={`flex h-7 items-center justify-center rounded-md px-4 transition-colors ${
                subjectType === opt.value
                  ? "bg-[color:var(--accent)]/20 text-text-primary"
                  : "text-text-muted hover:text-text-primary"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {subjectType === "effect" && (
          <div className="flex items-center gap-1">
            <span className="text-text-muted">종류</span>
            {EFFECT_TYPES.map(et => (
              <button
                key={et.value}
                onClick={() => setEffectType(et.value)}
                className={`flex h-7 items-center px-3 rounded-md border text-xs transition-colors ${
                  effectType === et.value
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border bg-bg-card text-text-muted hover:text-text-primary"
                }`}
              >
                {et.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 본문 — 중앙(참조 스테이지 + 동작 입력) + 우측 레일(옵션 + 생성하기). 캔버스 골격. */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 참조 이미지 스테이지 */}
          <div className="relative m-3 flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-[#0c0c0d]">
            {referenceImageUrl ? (
              <div className="checkerboard overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={referenceImageUrl} alt="참조" className="block max-h-[56vh] max-w-full object-contain" />
              </div>
            ) : (
              <p className="px-4 text-center text-xs text-text-muted/50">참조 이미지 없음 — 아래 텍스트 설명으로 생성합니다</p>
            )}
          </div>

          {/* 동작 텍스트 입력 (하단) */}
          <div className="flex-none space-y-1 border-t border-border p-3">
            <label className="text-xs text-text-muted">동작</label>
            <div className="rounded-lg border border-border bg-bg-card transition-colors focus-within:border-[color:var(--accent)]/60">
              <textarea
                value={actionPrompt}
                onChange={e => setActionPrompt(e.target.value)}
                placeholder={subjectType === "effect"
                  ? "어떤 이펙트인지 설명하세요 (예: 불꽃 폭발이 퍼지며 연기로 사라짐)"
                  : "어떤 동작을 만들지 설명하세요 (예시·AI 제안 활용 가능)"
                }
                rows={2}
                className="block min-h-[60px] w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-text-primary outline-none placeholder:text-text-muted/40"
              />
              {/* 입력 헬퍼 — 예시·AI 제안(위로 열림). */}
              <div className="flex items-center gap-1.5 border-t border-border px-2 py-1.5">
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
                        placement="bottom"
                        onPick={text => { setActionPrompt(text); setExampleOpen(false); }}
                        onClose={() => setExampleOpen(false)}
                      />
                    )}
                  </div>
                  <div className="relative">
                    <AiSuggestButton loading={aiLoading} onClick={handleAiSuggest} disabled={isCodex} />
                    {aiSuggestions && (
                      <AiSuggestDropdown
                        suggestions={aiSuggestions}
                        placement="bottom"
                        onSelect={v => { setActionPrompt(v); setAiSuggestions(null); }}
                        onClose={() => setAiSuggestions(null)}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>
            {!userSetFrames && actionPrompt.trim().length > 0 && (
              <p className="text-[11px] leading-relaxed text-text-muted/60">
                <span className="text-text-muted">{frames}프레임{seamlessLoop ? " · 루프" : ""}</span>으로 자동 설정됨 — 오른쪽에서 변경 가능
              </p>
            )}
            {aiError && <p className="text-[11px] text-[color:var(--danger)]">{aiError}</p>}
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

        {/* 우측 레일 — 생성 옵션(시점·방향·프레임·루프) + 하단 생성하기. */}
        <div className="flex w-[256px] flex-none flex-col border-l border-border bg-bg-panel">
          <div className="flex-1 space-y-3 overflow-y-auto p-3 text-xs">
            {/* 시점 */}
            <div className="space-y-1">
              <span className="block text-text-muted">시점</span>
              <div className="flex flex-wrap gap-0.5 rounded-lg border border-border bg-bg-card p-0.5">
                {([
                  { value: "side", label: "사이드" },
                  { value: "topdown", label: "탑다운" },
                  { value: "isometric", label: "아이소" },
                  { value: "2.5d-topdown", label: "2.5D" },
                ] as { value: Perspective; label: string }[]).map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setPerspective(opt.value)}
                    className={`flex h-7 items-center rounded-md px-2.5 transition-colors ${
                      perspective === opt.value
                        ? "bg-[color:var(--accent)]/20 text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {/* 방향 — 캐릭터만 */}
            {subjectType === "character" && (
              <div className="space-y-1">
                <span className="block text-text-muted">방향</span>
                <div className="relative">
                  <button
                    onClick={() => { setDirOpen(o => !o); setFrameOpen(false); }}
                    className="flex h-7 w-full items-center justify-between rounded-md border border-border bg-bg-panel px-2 text-xs text-text-primary hover:border-[color:var(--accent)]/40"
                  >
                    {DIRECTION_LABELS[direction]}
                  </button>
                  {dirOpen && (
                    <DirectionPopover
                      selected={direction}
                      onSelect={d => { setDirection(d); setDirOpen(false); }}
                      onClose={() => setDirOpen(false)}
                      referenceImageUrl={referenceImageUrl}
                    />
                  )}
                </div>
              </div>
            )}
            {/* 프레임 */}
            <div className="space-y-1">
              <span className="block text-text-muted">프레임</span>
              <div className="relative">
                <button
                  onClick={() => { setFrameOpen(o => !o); setDirOpen(false); }}
                  className="flex h-7 w-full items-center justify-between rounded-md border border-border bg-bg-panel px-2 text-xs text-text-primary hover:border-[color:var(--accent)]/40"
                >
                  {frames}프레임 {grid.rows}×{grid.cols}
                </button>
                {frameOpen && (
                  <FramePopover
                    selected={frames}
                    opts={subjectType === "effect" ? EFFECT_FRAME_OPTS : undefined}
                    onSelect={f => { setFrames(f); setUserSetFrames(true); setFrameOpen(false); }}
                    onClose={() => setFrameOpen(false)}
                  />
                )}
              </div>
              {(() => {
                const info = frameCanvasInfo(grid.rows, grid.cols);
                if (info.status === "safe") return null;
                const mpx = (info.totalPx / 1_000_000).toFixed(1);
                return (
                  <span className={`block text-[10px] ${info.status === "over" ? "text-red-400" : "text-orange-400"}`}>
                    ⚠ {info.w}×{info.h} = {mpx}M px {info.status === "over" ? "(초과)" : "(근접)"}
                  </span>
                );
              })()}
            </div>
            {/* 루프 */}
            <button
              type="button"
              onClick={() => setSeamlessLoop(v => !v)}
              className={`flex h-7 w-full items-center justify-center rounded-md border text-xs transition-colors ${
                seamlessLoop
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border bg-bg-panel text-text-muted hover:text-text-primary"
              }`}
            >
              루프 {seamlessLoop ? "ON" : "OFF"}
            </button>
          </div>
          {/* 하단 — 생성하기(생성 중엔 중단). 캔버스 합치기 자리. */}
          <div className="flex-none space-y-2 border-t border-border p-3">
            {busy && onCancel && (
              <button
                onClick={onCancel}
                className="h-9 w-full rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
              >
                ■ 생성 취소
              </button>
            )}
            <button
              onClick={handleSubmit}
              disabled={!canSubmit || busy}
              title={canSubmit || busy ? "" : "동작 설명을 입력하세요"}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
            >
              {busy ? <><Loader2 size={14} className="animate-spin" /> 생성 중…</> : <><Sparkles size={14} /> 생성하기</>}
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// 팝오버들

function DirectionPopover({
  selected,
  onSelect,
  onClose,
  referenceImageUrl,
}: {
  selected: Direction;
  onSelect: (d: Direction) => void;
  onClose: () => void;
  referenceImageUrl?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose);
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-30 mt-1 w-[180px] rounded-xl border border-border bg-bg-panel p-2 shadow-xl"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {COMPASS.map((d, i) => {
          if (d === null) return <span key={i} />;

          // 중앙 REF 버튼 — 참조 이미지가 없으면 빈 칸
          if (d === "REF") {
            if (!referenceImageUrl) return <span key="REF" />;
            return (
              <button
                key="REF"
                onClick={() => onSelect("REF")}
                title="참조 이미지 방향·포즈 기준"
                className={`flex h-12 w-full flex-col items-center justify-center gap-0.5 overflow-hidden rounded-lg border text-base leading-none ${
                  selected === "REF"
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border bg-bg-card text-text-muted hover:border-[color:var(--accent)]/40 hover:text-text-primary"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={referenceImageUrl}
                  alt="참조"
                  className="h-8 w-8 rounded object-contain"
                />
                <span className="text-[9px] leading-none opacity-60">참조</span>
              </button>
            );
          }

          return (
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
          );
        })}
      </div>
    </div>
  );
}

function FramePopover({
  selected,
  opts = FRAME_OPTS,
  onSelect,
  onClose,
}: {
  selected: FrameCount;
  opts?: typeof FRAME_OPTS;
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
        {opts.map(f => {
          const active = selected === f.value;
          const info = frameCanvasInfo(f.rows, f.cols);
          const mpx = (info.totalPx / 1_000_000).toFixed(1);
          return (
            <button
              key={f.value}
              onClick={() => onSelect(f.value)}
              className={`relative rounded-lg border p-3 text-left text-xs ${
                active
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : info.status === "over"
                    ? "border-red-500/40 bg-red-500/5 text-text-muted hover:border-red-500/60"
                    : "border-border bg-bg-card text-text-muted hover:border-[color:var(--accent)]/40"
              }`}
            >
              <div className="font-medium text-text-primary">{f.value}프레임</div>
              <div className="text-[11px] text-text-muted/70">
                {f.rows}×{f.cols}
              </div>
              {/* 캔버스 크기 정보 */}
              <div className={`mt-1 text-[10px] tabular-nums ${
                info.status === "over" ? "text-red-400"
                : info.status === "near" ? "text-orange-400"
                : "text-text-muted/50"
              }`}>
                {info.w}×{info.h} · {mpx}M
              </div>
              {/* 상태 뱃지 */}
              {info.status === "over" && (
                <span className="absolute right-1.5 top-1.5 rounded bg-red-500/20 px-1 py-0.5 text-[9px] font-medium text-red-400">
                  한계 초과
                </span>
              )}
              {info.status === "near" && (
                <span className="absolute right-1.5 top-1.5 rounded bg-orange-500/20 px-1 py-0.5 text-[9px] font-medium text-orange-400">
                  한계 근접
                </span>
              )}
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
  placement = "top",
}: {
  exampleKey: ExampleKey;
  onPick: (text: string) => void;
  onClose: () => void;
  placement?: "top" | "bottom";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(ref, onClose);
  return (
    <div
      ref={ref}
      className={`absolute right-0 z-30 ${placement === "bottom" ? "bottom-full mb-1" : "top-full mt-1"} w-[320px] space-y-1 rounded-xl border border-border bg-bg-panel p-2 shadow-xl`}
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

function facingPhrase(label: Direction, perspective: Perspective = "side"): string {
  if (label === "REF") return "facing the exact same direction as the reference character, preserving its pose and orientation";
  if (perspective !== "side") {
    return `facing ${label}`;
  }
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

  // UI에서 방향이 명시 선택된 경우(REF + 참조이미지 포함). 미설정이면 대화창이 결정.
  const hasExplicitDirection =
    isCharacter && (state.direction !== "REF" || !!referenceId);

  const viewpointClause =
    state.perspective && state.perspective !== "side"
      ? `; viewpoint=${state.perspective}`
      : "";
  // 방향 명시 시 directive에도 facing 박아 LLM이 다방향으로 오해 못 하게 방지
  const facingClause = hasExplicitDirection
    ? `; facing=${state.direction}`
    : "";
  const directive =
    `[spritesheet: subjectType=${state.subjectType}; anchorStrategy=${anchor}; ` +
    `rows=${grid.rows}; cols=${grid.cols}; directions=1` +
    `${facingClause}${viewpointClause}; seamlessLoop=${state.seamlessLoop}]`;

  const nlParts: string[] = [state.actionPrompt];
  if (stylePresetSuffix) nlParts.push(stylePresetSuffix);
  const perspectivePhrase: Partial<Record<Perspective, string>> = {
    topdown: "top-down bird's-eye view",
    isometric: "isometric 45-degree angle view",
    "2.5d-topdown": "2.5D top-down perspective, slightly overhead",
  };
  const perspPhrase = perspectivePhrase[state.perspective ?? "side"];
  if (perspPhrase) nlParts.push(perspPhrase);
  if (hasExplicitDirection) {
    // 방향이 명시된 경우: 단일 방향임을 강하게 명시해 LLM이 미러/반대 방향 추가 못 하게 방지
    const fp = facingPhrase(state.direction, state.perspective ?? "side");
    nlParts.push(
      `SINGLE DIRECTION ONLY — ${fp}. Every frame must face this same direction. Do NOT include mirrored, opposite, or any other facing variants`,
    );
  }
  if (state.subjectType === "effect" && state.effectType) {
    const et = EFFECT_TYPES.find(e => e.value === state.effectType);
    if (et) nlParts.push(et.phrase);
  }
  nlParts.push("transparent background");
  const nl = nlParts.join(", ");

  return {
    message: `${directive}\n${nl}`,
    attachmentGenerationIds: referenceId ? [referenceId] : [],
  };
}

