"use client";

import { Loader2, Palette, Upload, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { listGenerations, removeGeneration, uploadImage } from "@/lib/api/client";
import { PanelFooter } from "@/components/editor/PanelFooter";
import { AiSuggestButton, AiSuggestDropdown } from "@/components/editor/AiSuggestControls";
import { detectSpriteGrid } from "@/lib/shared/detect-sprite-grid";
import type { Generation } from "@/types/db";

/**
 * ReskinPanel — 결과 카드의 [🎨 리스킨] 단축어가 여는 패널.
 *
 * 상단 탭 2개(외형 교체 / 색만 변경). "외형 교체"는 서브 토글(텍스트 / 이미지 참조)로
 * 입력 방식을 분기 — 텍스트 = 기존 모드 a, 이미지 참조 = 기존 모드 c.
 * 실행은 기존 단축어와 동일 — onSubmit 으로 ReskinSubmit(mode a/b/b-precise/c)을 부모(ChatLayout)에
 * 넘기면 부모가 handleSend 로 Claude → reskin_image 라우팅. (UI만 재구성, 백엔드 계약 불변.)
 *
 * 자연어 문구는 system-orchestrator.md 라우팅과 정합:
 *  - (a) "…로 리스킨해줘" → prompt 모드            (외형 교체 · 텍스트)
 *  - (b) "색 팔레트만 …로 바꿔줘. 형태는 그대로 유지." → paletteOnly 모드 (색만 변경)
 *  - (c) "첫 번째 이미지 + 두 번째 이미지의 화풍" + 두 첨부 → styleReferenceId 모드 (외형 교체 · 이미지 참조)
 */

type UIMode = "skin" | "color" | "style";
type SkinInput = "text" | "image";

export type ReskinSubmit =
  | { mode: "a"; prompt: string }
  | { mode: "b"; prompt: string }
  | { mode: "c"; styleReferenceId: string; extra: string }
  | {
      /** 모드 b 정밀 — codex 없이 sharp 픽셀 색교체. 형태 100% 보존. */
      mode: "b-precise";
      mappings: Array<{ from: string; to: string }>;
      includeGrays: boolean;
    }
  | { mode: "d"; styleName: string };

type Props = {
  /** 리스킨 대상 generationId. */
  generationId: string;
  /** 원본 이미지 URL — 미리보기용. */
  imageUrl: string;
  width: number;
  height: number;
  /** 시트면 셀 정렬·투명 후처리 안내 배너 표시. 미지정 시 치수로 추정. */
  kind?: string;
  /** 진입 시 기본 탭. 미지정 시 "skin"(외형 교체). */
  initialMode?: UIMode;
  /** "외형 교체" 탭의 기본 서브. 캐릭터 오버레이 단축어는 "image"로 바로 연다. 미지정 시 "text". */
  initialSkinInput?: SkinInput;
  /** 현재 세션 — 이미지 참조 서브의 참조 썸네일 그리드 조회용. */
  sessionId: string | null;
  busy?: boolean;
  onSubmit: (payload: ReskinSubmit) => void;
  onClose: () => void;
  onCancel?: () => void;
};

const UI_MODE_LABELS: Record<UIMode, string> = {
  skin: "외형 교체",
  color: "색만 변경",
  style: "화풍",
};

const SKIN_INPUT_LABELS: Record<SkinInput, string> = {
  text: "텍스트",
  image: "이미지 참조",
};

const STYLE_PRESETS = [
  { label: "픽셀아트", value: "pixel art style" },
  { label: "애니메이션", value: "anime illustration style" },
  { label: "수채화", value: "watercolor painting style" },
  { label: "스케치", value: "pencil sketch style" },
  { label: "오일페인팅", value: "oil painting style" },
  { label: "만화", value: "cartoon comic style" },
  { label: "3D 렌더", value: "3D render style" },
  { label: "포토리얼", value: "photorealistic style" },
];

// 썸네일 그리드에서 제외할 비-이미지 kind.
const NON_IMAGE_KINDS = new Set(["mask"]);

export function ReskinPanel({
  generationId,
  imageUrl,
  width,
  height,
  kind,
  initialMode,
  initialSkinInput,
  sessionId,
  busy = false,
  onSubmit,
  onClose,
  onCancel,
}: Props) {
  const [uiMode, setUiMode] = useState<UIMode>(initialMode ?? "skin");
  const [skinInput, setSkinInput] = useState<SkinInput>(initialSkinInput ?? "text");
  const [prompt, setPrompt] = useState("");
  const [extra, setExtra] = useState("");
  const [styleRefId, setStyleRefId] = useState<string | null>(null);
  const [refs, setRefs] = useState<Generation[] | null>(null);
  const [refScope, setRefScope] = useState<"session" | "gallery">("session");
  const [galleryRefs, setGalleryRefs] = useState<Generation[] | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 모드 b 하위: "ai"=codex img2img(자연어), "precise"=sharp 픽셀 색교체(팔레트→타깃).
  const [bMode, setBMode] = useState<"ai" | "precise">("ai");
  const [palette, setPalette] = useState<string[] | null>(null);
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [includeGrays, setIncludeGrays] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);
  // 화풍 변환 탭: 프리셋 선택(토글) + 커스텀 입력. 둘 중 하나라도 있으면 제출 가능.
  const [stylePreset, setStylePreset] = useState<string | null>(null);
  const [styleCustom, setStyleCustom] = useState("");

  // AI 제안
  const [aiLoading, setAiLoading] = useState(false);
  const [aiTarget, setAiTarget] = useState<"prompt" | "extra" | null>(null);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<{ title: string; body: string }[] | null>(null);

  // 이미지 참조 서브: 사용자가 외부 이미지를 업로드해 참조로 사용.
  async function handleUploadRef(file: File) {
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as string);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(file);
      });
      const g = await uploadImage({ dataUrl, sessionId, filename: file.name });
      setStyleRefId(g.generationId);
      setRefs(null); // 세션 목록 재조회 → 업로드한 이미지가 그리드에도 포함.
    } catch (e) {
      console.error("[reskin-upload]", e);
    } finally {
      setUploading(false);
    }
  }

  // 시트 여부: kind 우선, 없으면 치수에서 grid 감지(SpriteCanvas 와 동일 GCD 역산).
  const isSheet = kind === "spritesheet" || (!kind && detectSpriteGrid(width, height) !== null);
  const grid = detectSpriteGrid(width, height);
  // 시트 베이스 + 외형 교체·이미지 참조 서브 = 캐릭터 오버레이 → 라벨/안내 리프레이밍(백엔드는 동일).
  const overlay = isSheet && uiMode === "skin" && skinInput === "image";

  // 선택한 참조 이미지가 시트인지 — 베이스가 아닌 "참조" 쪽 시트 감지(오버레이 안내·실행 라벨용).
  const currentRefs = refScope === "session" ? refs : galleryRefs;
  const selectedRef = currentRefs?.find(g => g.id === styleRefId);
  const refIsSheet =
    selectedRef?.kind === "spritesheet" ||
    (!selectedRef?.kind &&
      detectSpriteGrid(selectedRef?.width ?? 0, selectedRef?.height ?? 0) !== null);

  // 이미지 참조 서브 진입 시 세션 이미지 목록 로드 — 원본 자신·마스크 제외.
  useEffect(() => {
    if (uiMode !== "skin" || skinInput !== "image" || refs !== null) return;
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens =>
        setRefs(gens.filter(g => g.id !== generationId && !NON_IMAGE_KINDS.has(g.kind))),
      )
      .catch(() => setRefs([]));
  }, [uiMode, skinInput, refs, sessionId, generationId]);

  // 갤러리 전체 이미지 목록 로드 — refScope가 "gallery"로 전환 시.
  useEffect(() => {
    if (uiMode !== "skin" || skinInput !== "image" || refScope !== "gallery" || galleryRefs !== null) return;
    listGenerations({ limit: 120 })
      .then(gens =>
        setGalleryRefs(gens.filter(g => g.id !== generationId && !NON_IMAGE_KINDS.has(g.kind))),
      )
      .catch(() => setGalleryRefs([]));
  }, [uiMode, skinInput, refScope, galleryRefs, generationId]);

  async function handleAiSuggest(target: "prompt" | "extra") {
    if (aiLoading) return;
    setAiLoading(true);
    setAiTarget(target);
    setAiError(null);
    setAiResult(null);
    const currentVal = target === "prompt" ? prompt : extra;
    const question =
      currentVal.trim() ||
      (uiMode === "skin" && skinInput === "text"
        ? "새 스킨을 제안해주세요"
        : uiMode === "color"
        ? "색 변경을 제안해주세요"
        : uiMode === "style"
        ? "아트 스타일 변환을 제안해주세요"
        : "추가 지시를 제안해주세요");
    // /api/reskin-suggest 는 레거시 mode(a/b/c) 계약 — UI 상태를 그대로 매핑해 전달.
    const apiMode: "a" | "b" | "c" =
      uiMode === "color" ? "b" : skinInput === "image" ? "c" : "a";
    try {
      const res = await fetch("/api/reskin-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: apiMode, question, isSheet, isOverlay: overlay }),
      });
      const data = (await res.json()) as {
        suggestion?: string;
        suggestions?: { title: string; body: string }[];
        error?: string;
      };
      if (!res.ok) {
        setAiError(data.error ?? "제안 생성에 실패했습니다.");
        return;
      }
      if (data.suggestions && data.suggestions.length > 0) {
        setAiSuggestions(data.suggestions);
        setAiResult(null);
      } else if (data.suggestion) {
        setAiResult(data.suggestion);
        setAiSuggestions(null);
      } else {
        setAiError(data.error ?? "제안 생성에 실패했습니다.");
      }
    } catch (e) {
      setAiError((e as Error).message);
    } finally {
      setAiLoading(false);
    }
  }

  // 정밀 토글 진입 — 최초 1회 원본에서 주요 색 추출(클라이언트 canvas, 동일 출처라 taint 없음).
  function enterPrecise() {
    setBMode("precise");
    if (palette !== null) return;
    setExtracting(true);
    extractPalette(imageUrl)
      .then(cols => {
        setPalette(cols);
        setTargets(Object.fromEntries(cols.map(c => [c, c]))); // 기본 타깃 = 원본색(변경 없음)
      })
      .catch(() => setPalette([]))
      .finally(() => setExtracting(false));
  }

  // 정밀 모드에서 실제로 바뀌는 매핑(타깃 ≠ 원본).
  const preciseMappings = useMemo(
    () =>
      (palette ?? [])
        .filter(c => (targets[c] ?? c).toLowerCase() !== c.toLowerCase())
        .map(c => ({ from: c, to: targets[c]! })),
    [palette, targets],
  );

  const canSubmit = useMemo(() => {
    if (uiMode === "skin" && skinInput === "text") return prompt.trim().length > 0;
    if (uiMode === "skin" && skinInput === "image") return styleRefId !== null;
    if (uiMode === "style") return stylePreset !== null || styleCustom.trim().length > 0;
    // color
    return bMode === "ai" ? prompt.trim().length > 0 : preciseMappings.length > 0;
  }, [uiMode, skinInput, bMode, prompt, preciseMappings, styleRefId, stylePreset, styleCustom]);

  function submit() {
    if (!canSubmit) return;
    if (uiMode === "skin" && skinInput === "text") {
      onSubmit({ mode: "a", prompt: prompt.trim() });
    } else if (uiMode === "skin" && skinInput === "image" && styleRefId) {
      onSubmit({ mode: "c", styleReferenceId: styleRefId, extra: extra.trim() });
    } else if (uiMode === "color") {
      if (bMode === "ai") onSubmit({ mode: "b", prompt: prompt.trim() });
      else onSubmit({ mode: "b-precise", mappings: preciseMappings, includeGrays });
    } else if (uiMode === "style") {
      const styleName = styleCustom.trim() || stylePreset!;
      onSubmit({ mode: "d", styleName });
    }
  }

  const styleRefUrl = styleRefId ? `/api/images/${styleRefId}` : null;

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Palette size={14} /> {overlay ? "캐릭터 오버레이" : "리스킨"}
        </span>
        <span className="text-xs text-text-muted/60">
          {width}×{height} · parent {generationId.slice(0, 6)}…
        </span>
        <button
          onClick={onClose}
          disabled={busy}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary disabled:opacity-40"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 상단 탭 세그먼트 토글 (외형 교체 / 색만 변경 / 화풍) */}
        <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-xs">
          {(["skin", "color", "style"] as const).map(m => (
            <button
              key={m}
              onClick={() => setUiMode(m)}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                uiMode === m
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {UI_MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {/* 원본 미리보기 + kind 배지 — 크게 표시. */}
        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-text-muted/80">{overlay ? "베이스 시트" : "원본"}</span>
            <span className="text-text-primary">{width}×{height}</span>
            {isSheet && (
              <span className="inline-flex items-center rounded bg-[color:var(--accent)]/15 px-1.5 py-0.5 text-[10px] text-text-primary">
                스프라이트시트{grid ? ` · ${grid.rows}×${grid.cols}` : ""}
              </span>
            )}
          </div>
          <div className="overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/16px_16px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="원본" className="mx-auto block max-h-[44vh] w-auto object-contain" />
          </div>
        </div>

        {/* "외형 교체" 탭 내부 서브 토글 (텍스트 / 이미지 참조) */}
        {uiMode === "skin" && (
          <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-[11px]">
            {(["text", "image"] as const).map(s => (
              <button
                key={s}
                onClick={() => setSkinInput(s)}
                className={`flex h-7 flex-1 items-center justify-center rounded border px-2 ${
                  skinInput === s
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-transparent text-text-muted hover:text-text-primary"
                }`}
              >
                {SKIN_INPUT_LABELS[s]}
              </button>
            ))}
          </div>
        )}

        {/* 모드별 입력 */}
        {uiMode === "skin" && skinInput === "text" && (
          <div className="shrink-0 space-y-1">
            <label className="text-xs text-text-muted">새 스킨 설명</label>
            <div className="rounded-lg border border-border bg-bg-card focus-within:border-[color:var(--accent)]/60 transition-colors">
              <textarea
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="예: 파란 갑옷의 기사, 은빛 검"
                rows={3}
                className="block min-h-[78px] w-full shrink-0 resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-text-primary outline-none placeholder:text-text-muted/40"
              />
              <div className="flex items-center border-t border-border px-2 py-1.5">
                <div className="relative ml-auto">
                  <AiSuggestButton
                    loading={aiLoading && aiTarget === "prompt"}
                    onClick={() => handleAiSuggest("prompt")}
                  />
                  {aiSuggestions && aiTarget === "prompt" && (
                    <AiSuggestDropdown
                      suggestions={aiSuggestions}
                      onSelect={v => { setPrompt(v); setAiSuggestions(null); setAiTarget(null); }}
                      onClose={() => { setAiSuggestions(null); setAiTarget(null); }}
                    />
                  )}
                </div>
              </div>
            </div>
            <AiSuggestResult
              show={aiTarget === "prompt" && aiSuggestions === null}
              result={aiResult}
              error={aiError}
              onApply={v => { setPrompt(v); setAiResult(null); }}
            />
            <p className="text-[11px] text-text-muted/70">
              포즈·실루엣·구도는 유지하고 색·재질·테마만 교체됩니다.
            </p>
          </div>
        )}

        {uiMode === "color" && (
          <div className="shrink-0 space-y-2">
            {/* AI(codex) vs 정밀(sharp) 하위 토글 */}
            <div className="flex gap-1 rounded-lg border border-border bg-bg-card p-1 text-[11px]">
              {(["ai", "precise"] as const).map(bm => (
                <button
                  key={bm}
                  onClick={() => (bm === "precise" ? enterPrecise() : setBMode("ai"))}
                  className={`flex h-7 flex-1 items-center justify-center rounded border px-2 ${
                    bMode === bm
                      ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                      : "border-transparent text-text-muted hover:text-text-primary"
                  }`}
                >
                  {bm === "ai" ? "AI 변경" : "정밀 (픽셀)"}
                </button>
              ))}
            </div>

            {bMode === "ai" ? (
              <div className="space-y-1">
                <label className="text-xs text-text-muted">원하는 색 팔레트</label>
                <div className="rounded-lg border border-border bg-bg-card focus-within:border-[color:var(--accent)]/60 transition-colors">
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    placeholder="예: 빨강→파랑, 금색 장식은 은색으로"
                    rows={3}
                    className="block min-h-[78px] w-full shrink-0 resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-text-primary outline-none placeholder:text-text-muted/40"
                  />
                  <div className="flex items-center border-t border-border px-2 py-1.5">
                    <div className="relative ml-auto">
                      <AiSuggestButton
                        loading={aiLoading && aiTarget === "prompt"}
                        onClick={() => handleAiSuggest("prompt")}
                      />
                      {aiSuggestions && aiTarget === "prompt" && (
                        <AiSuggestDropdown
                          suggestions={aiSuggestions}
                          onSelect={v => { setPrompt(v); setAiSuggestions(null); setAiTarget(null); }}
                          onClose={() => { setAiSuggestions(null); setAiTarget(null); }}
                        />
                      )}
                    </div>
                  </div>
                </div>
                <AiSuggestResult
                  show={aiTarget === "prompt" && aiSuggestions === null}
                  result={aiResult}
                  error={aiError}
                  onApply={v => { setPrompt(v); setAiResult(null); }}
                />
                <p className="text-[11px] text-text-muted/70">형태·선은 그대로 두고 색 팔레트만 바꿉니다.</p>
                <p className="text-[11px] text-[color:var(--danger)]/90">
                  ⚠ img2img 특성상 형태가 미세하게 틀어질 수 있어요.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-xs text-text-muted">원본 색 → 바꿀 색</label>
                {extracting && (
                  <p className="flex items-center gap-1 text-[11px] text-text-muted/60">
                    <Loader2 size={12} className="animate-spin" /> 팔레트 추출 중…
                  </p>
                )}
                {!extracting && palette && palette.length === 0 && (
                  <p className="text-[11px] text-text-muted/60">추출된 색이 없습니다(채도가 낮은 이미지).</p>
                )}
                {!extracting && palette && palette.length > 0 && (
                  <div className="space-y-1.5">
                    {palette.map(c => {
                      const t = targets[c] ?? c;
                      const changed = t.toLowerCase() !== c.toLowerCase();
                      return (
                        <div key={c} className="flex items-center gap-2 text-xs">
                          <span
                            className="h-6 w-6 shrink-0 rounded border border-border"
                            style={{ background: c }}
                          />
                          <span className="w-16 font-mono text-text-muted">{c}</span>
                          <span className="text-text-muted">→</span>
                          <input
                            type="color"
                            value={t}
                            onChange={e => setTargets(p => ({ ...p, [c]: e.target.value }))}
                            className="h-6 w-9 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
                          />
                          <span className="flex-1 font-mono text-text-muted/70">
                            {changed ? t : "(변경 안 함)"}
                          </span>
                          {changed && (
                            <button
                              onClick={() => setTargets(p => ({ ...p, [c]: c }))}
                              className="rounded px-1 text-[10px] text-text-muted hover:text-text-primary"
                              title="원래 색으로"
                            >
                              초기화
                            </button>
                          )}
                        </div>
                      );
                    })}
                    <label className="flex items-center gap-2 pt-1 text-[11px] text-text-muted">
                      <input
                        type="checkbox"
                        checked={includeGrays}
                        onChange={e => setIncludeGrays(e.target.checked)}
                      />
                      회색·흑백 영역도 포함 (기본: 외곽선 보호 위해 제외)
                    </label>
                  </div>
                )}
                <p className="text-[11px] text-text-muted/70">
                  형태·음영을 100% 보존하고 색조만 교체합니다 (codex 미사용, 즉시 처리).
                </p>
              </div>
            )}
          </div>
        )}

        {uiMode === "style" && (
          <div className="shrink-0 space-y-3">
            {/* 프리셋 그리드 */}
            <div className="space-y-1">
              <label className="text-xs text-text-muted">스타일 프리셋</label>
              <div className="grid grid-cols-4 gap-1">
                {STYLE_PRESETS.map(p => (
                  <button
                    key={p.value}
                    onClick={() => setStylePreset(prev => (prev === p.value ? null : p.value))}
                    className={`rounded border px-2 py-1.5 text-[11px] transition-colors ${
                      stylePreset === p.value
                        ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                        : "border-border text-text-muted hover:border-[color:var(--accent)]/50 hover:text-text-primary"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* 커스텀 입력 */}
            <div className="space-y-1">
              <label className="text-xs text-text-muted">직접 입력 (선택)</label>
              <div className="rounded-lg border border-border bg-bg-card focus-within:border-[color:var(--accent)]/60 transition-colors">
                <textarea
                  value={styleCustom}
                  onChange={e => setStyleCustom(e.target.value)}
                  placeholder="예: 16비트 레트로 RPG 스타일"
                  rows={2}
                  className="block w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-text-primary outline-none placeholder:text-text-muted/40"
                />
                <div className="flex items-center border-t border-border px-2 py-1.5">
                  <div className="relative ml-auto">
                    <AiSuggestButton
                      loading={aiLoading && aiTarget === "prompt"}
                      onClick={() => handleAiSuggest("prompt")}
                    />
                    {aiSuggestions && aiTarget === "prompt" && (
                      <AiSuggestDropdown
                        suggestions={aiSuggestions}
                        onSelect={v => { setStyleCustom(v); setAiSuggestions(null); setAiTarget(null); }}
                        onClose={() => { setAiSuggestions(null); setAiTarget(null); }}
                      />
                    )}
                  </div>
                </div>
              </div>
              <AiSuggestResult
                show={aiTarget === "prompt" && aiSuggestions === null}
                result={aiResult}
                error={aiError}
                onApply={v => { setStyleCustom(v); setAiResult(null); }}
              />
            </div>

            <p className="text-[11px] text-text-muted/70">
              구성·형태는 유지하고 화풍(재질·색조·렌더링 스타일)만 바꿉니다.
            </p>
          </div>
        )}

        {uiMode === "skin" && skinInput === "image" && (
          <div className="shrink-0 space-y-2">
            {overlay && (
              <div className="rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 p-2 text-[11px] text-text-primary">
                ⓘ 베이스 시트의 포즈는 그대로 두고, 선택한 캐릭터의 외형을 모든 프레임에 입힙니다.
              </div>
            )}
            {refIsSheet && (
              <div className="rounded-lg border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 p-2 text-[11px] text-text-primary">
                ⓘ 참조 이미지가 스프라이트시트입니다. 베이스의 모든 포즈에 이 시트의 캐릭터 외형을 전 프레임에 입힙니다.
              </div>
            )}
            <div className="flex items-center justify-between">
              <label className="text-xs text-text-muted">
                {overlay ? "입힐 캐릭터" : "스타일 참조 이미지"}
              </label>
              <div className="flex gap-0.5 rounded border border-border bg-bg-card p-0.5 text-[11px]">
                {(["session", "gallery"] as const).map(scope => (
                  <button
                    key={scope}
                    onClick={() => setRefScope(scope)}
                    className={`rounded px-2 py-0.5 ${
                      refScope === scope
                        ? "bg-[color:var(--accent)]/20 text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    {scope === "session" ? "세션" : "갤러리"}
                  </button>
                ))}
              </div>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={e => {
                const f = e.target.files?.[0];
                if (f) handleUploadRef(f);
                e.target.value = "";
              }}
            />
            {(refScope === "session" ? refs : galleryRefs) === null ? (
              <p className="text-[11px] text-text-muted/60">
                {refScope === "session" ? "세션 이미지를 불러오는 중…" : "갤러리를 불러오는 중…"}
              </p>
            ) : (
              <div
                className={`grid grid-cols-4 gap-1 rounded-lg transition-colors ${
                  dragOver ? "bg-[color:var(--accent)]/10 ring-2 ring-[color:var(--accent)]/40" : ""
                }`}
                onDragEnter={e => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  dragCounter.current += 1;
                  if (dragCounter.current === 1) setDragOver(true);
                }}
                onDragOver={e => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={() => {
                  dragCounter.current = Math.max(0, dragCounter.current - 1);
                  if (dragCounter.current === 0) setDragOver(false);
                }}
                onDrop={e => {
                  if (!e.dataTransfer.types.includes("Files")) return;
                  e.preventDefault();
                  dragCounter.current = 0;
                  setDragOver(false);
                  const f = [...e.dataTransfer.files].find(x => /^image\//.test(x.type));
                  if (f) handleUploadRef(f);
                }}
              >
                {/* 업로드 타일 — 클릭 + 드롭 안내. */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className={`flex aspect-square flex-col items-center justify-center gap-1 rounded border border-dashed text-text-muted disabled:opacity-50 ${
                    dragOver
                      ? "border-[color:var(--accent)] text-[color:var(--accent)]"
                      : "border-border hover:border-[color:var(--accent)]/60 hover:text-text-primary"
                  }`}
                  title="클릭하거나 이미지를 드롭해서 업로드"
                >
                  {uploading ? <Loader2 size={16} className="animate-spin" /> : <Upload size={16} />}
                  <span className="text-[9px]">{uploading ? "업로드 중" : dragOver ? "드롭!" : "업로드"}</span>
                </button>
                {(refScope === "session" ? refs! : galleryRefs!).map(g => {
                  const sel = styleRefId === g.id;
                  return (
                    <div key={g.id} className="group relative aspect-square">
                      <button
                        onClick={() => setStyleRefId(sel ? null : g.id)}
                        className={`h-full w-full overflow-hidden rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px] ${
                          sel
                            ? "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]"
                            : "border-border hover:border-[color:var(--accent)]/50"
                        }`}
                        title={g.prompt ?? g.id}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={`/api/images/${g.id}`}
                          alt={g.prompt ?? "참조"}
                          className="h-full w-full object-contain"
                        />
                        {sel && (
                          <span className="absolute right-0.5 top-0.5 rounded-full bg-[color:var(--accent)] px-1 text-[9px] font-bold text-white">
                            ✓
                          </span>
                        )}
                      </button>
                      {/* 삭제 버튼 — 세션 스코프에서만 노출 */}
                      {refScope === "session" && (
                      <button
                        onClick={async e => {
                          e.stopPropagation();
                          if (sel) setStyleRefId(null);
                          setRefs(prev => prev?.filter(r => r.id !== g.id) ?? prev);
                          await removeGeneration(g.id);
                        }}
                        className="absolute left-0.5 top-0.5 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[9px] text-white hover:bg-[color:var(--danger)] group-hover:flex"
                        title="삭제"
                      >
                        ✕
                      </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* 선택 시 원본 + 참조 나란히 미리보기 */}
            {styleRefUrl && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card p-2">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt="원본" className="h-full w-full object-contain" />
                </div>
                <span className="text-text-muted">→</span>
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={styleRefUrl} alt="참조" className="h-full w-full object-contain" />
                </div>
                <span className="text-[11px] text-text-muted/70">
                  {overlay ? "이 캐릭터를 모든 프레임에 입힙니다." : "이 참조의 화풍·팔레트를 입힙니다."}
                </span>
              </div>
            )}

            {overlay && (
              <p className="text-[11px] text-[color:var(--danger)]/90">
                ⚠ 모든 프레임의 머리·얼굴·복장 일관성은 모델에 의존합니다(드리프트 가능). 베이스 시트 정렬 품질이 중요합니다.
              </p>
            )}

            <div className="space-y-1">
              <label className="text-xs text-text-muted">(선택) 추가 지시</label>
              <div className="rounded-lg border border-border bg-bg-card focus-within:border-[color:var(--accent)]/60 transition-colors">
                <textarea
                  value={extra}
                  onChange={e => setExtra(e.target.value)}
                  placeholder="예: 더 어둡고 차분하게"
                  rows={2}
                  className="block w-full resize-none bg-transparent px-3 pt-2 pb-1 text-sm text-text-primary outline-none placeholder:text-text-muted/40"
                />
                <div className="flex items-center border-t border-border px-2 py-1.5">
                  <div className="relative ml-auto">
                    <AiSuggestButton
                      loading={aiLoading && aiTarget === "extra"}
                      onClick={() => handleAiSuggest("extra")}
                    />
                    {aiSuggestions && aiTarget === "extra" && (
                      <AiSuggestDropdown
                        suggestions={aiSuggestions}
                        onSelect={v => { setExtra(v); setAiSuggestions(null); setAiTarget(null); }}
                        onClose={() => { setAiSuggestions(null); setAiTarget(null); }}
                      />
                    )}
                  </div>
                </div>
              </div>
              <AiSuggestResult
                show={aiTarget === "extra" && aiSuggestions === null}
                result={aiResult}
                error={aiError}
                onApply={v => { setExtra(v); setAiResult(null); }}
              />
            </div>
          </div>
        )}

        {/* 시트 후처리 안내 — 시트일 때만 */}
        {isSheet && (
          <div className="shrink-0 rounded-lg border border-border bg-bg-card p-2 text-[11px] text-text-muted/70">
            ⓘ 스프라이트시트는 셀 정렬·투명 후처리가 자동 적용됩니다.
          </div>
        )}
      </div>

      <PanelFooter
        busy={busy}
        canSubmit={canSubmit}
        onSubmit={submit}
        onClose={onClose}
        onCancel={onCancel}
        submitLabel={overlay || refIsSheet ? "오버레이 실행 ▸" : uiMode === "style" ? "화풍 변환 ▸" : "리스킨 실행 ▸"}
        submitTitle={
          canSubmit || busy
            ? ""
            : uiMode === "skin" && skinInput === "image"
            ? "참조 이미지 선택 필요"
            : uiMode === "style"
            ? "스타일 선택 또는 입력 필요"
            : "설명 입력 필요"
        }
      />

    </aside>
  );
}

function AiSuggestResult({
  show,
  result,
  error,
  onApply,
}: {
  show: boolean;
  result: string | null;
  error: string | null;
  onApply: (v: string) => void;
}) {
  if (!show || (!result && !error)) return null;
  return (
    <div className="space-y-1 rounded-lg border border-border bg-bg-card p-2">
      {error && <p className="text-[11px] text-[color:var(--danger)]">{error}</p>}
      {result && (
        <>
          <p className="text-xs text-text-primary">{result}</p>
          <button
            onClick={() => onApply(result)}
            className="rounded border border-[color:var(--accent)]/50 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
          >
            적용
          </button>
        </>
      )}
    </div>
  );
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join("");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

/**
 * 원본 이미지에서 주요 색(채도 있는) maxColors 개를 빈도순으로 추출.
 * 작은 캔버스로 다운스케일 후 4-bit/채널 양자화 히스토그램 → 빈별 평균색.
 * 저채도(회색·흑백)는 제외 — 정밀 색교체의 기본 대상이 chromatic 이므로.
 */
async function extractPalette(url: string, maxColors = 6): Promise<string[]> {
  const img = await loadImage(url);
  const W = Math.min(96, img.width || 96);
  const H = Math.max(1, Math.round((img.height / Math.max(1, img.width)) * W));
  const cvs = document.createElement("canvas");
  cvs.width = W;
  cvs.height = H;
  const ctx = cvs.getContext("2d");
  if (!ctx) return [];
  ctx.drawImage(img, 0, 0, W, H);
  const { data } = ctx.getImageData(0, 0, W, H);
  const bins = new Map<string, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue; // 투명 제외
    const r = data[i],
      g = data[i + 1],
      b = data[i + 2];
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b);
    const sat = mx === 0 ? 0 : (mx - mn) / mx;
    if (sat < 0.15) continue; // 저채도 제외
    const key = `${r >> 4}-${g >> 4}-${b >> 4}`;
    const e = bins.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    e.count++;
    e.r += r;
    e.g += g;
    e.b += b;
    bins.set(key, e);
  }
  return [...bins.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, maxColors)
    .map(e => rgbToHex(Math.round(e.r / e.count), Math.round(e.g / e.count), Math.round(e.b / e.count)));
}
