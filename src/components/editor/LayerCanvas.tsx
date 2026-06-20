"use client";

import { Eraser, Layers, Loader2, Paintbrush, Sparkles, Tags, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AiSuggestButton, AiSuggestDropdown } from "@/components/editor/AiSuggestControls";
import { ZoomPanControls, useZoomPan } from "./useZoomPan";

/**
 * LayerCanvas — 두 가지 방식으로 부위를 투명 배경 PNG 로 추출한다.
 *
 *  ① "입력으로 분리" — 부위 이름 태그를 입력하면 AI 가 각 부위를 텍스트 기반으로 추출.
 *     Enter / 쉼표(,) 로 태그 추가, Backspace 로 마지막 삭제, 최대 10개.
 *  ② "브러쉬로 분리" — 추출할 영역을 직접 칠해 마스크를 만든 뒤 부위 이름과 함께 추출.
 *     마스크는 MaskCanvas 인페인트와 동일 계약(칠한 영역=#ff0000, 배경=#000000, alpha=255).
 *
 * 양쪽 탭 모두 스크롤 영역 하단에 누적된 추출 결과 그리드를 표시한다(results prop).
 * 실제 추출 호출(uploadMask·handleSend)은 ChatLayout 이 처리.
 */

const MAX_PARTS = 10;

type ResultItem = { id: string; url: string; prompt: string };

type Props = {
  parentGenerationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  busy?: boolean;
  results?: ResultItem[];
  onSubmit: (args: { parts: string[]; autoRestore: boolean }) => void;
  onBrushSubmit: (args: { maskDataUrl: string; prompt: string }) => void;
  onCancel: () => void;
};

export function LayerCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  busy = false,
  results = [],
  onSubmit,
  onBrushSubmit,
  onCancel,
}: Props) {
  const [tab, setTab] = useState<"input" | "brush">("input");

  // ── ① "입력으로 분리" 상태 ──────────────────────────────────────────────────
  const [parts, setParts] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [autoRestore, setAutoRestore] = useState(true);

  // AI 제안
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSuggestions, setAiSuggestions] = useState<{ title: string; body: string }[] | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const handleAiSuggest = useCallback(async () => {
    if (aiLoading) return;
    setAiLoading(true);
    setAiError(null);
    const question = parts.length > 0
      ? `이미 선택된 부위: ${parts.join(", ")} — 이를 참고해 다른 세트를 제안해주세요`
      : "게임 캐릭터 스프라이트의 부위를 제안해주세요";
    try {
      const res = await fetch("/api/layer-suggest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      const data = (await res.json()) as { suggestions?: { title: string; body: string }[]; error?: string };
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
  }, [aiLoading, parts]);

  function addPart(raw: string) {
    const value = raw.trim();
    if (!value) return;
    setParts(prev => {
      if (prev.length >= MAX_PARTS || prev.includes(value)) return prev;
      return [...prev, value];
    });
  }

  function commitInput() {
    addPart(input);
    setInput("");
  }

  function removePart(i: number) {
    setParts(prev => prev.filter((_, idx) => idx !== i));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitInput();
    } else if (e.key === "Backspace" && input === "" && parts.length > 0) {
      // 빈 입력에서 Backspace → 마지막 태그 제거 (입력 편의).
      e.preventDefault();
      setParts(prev => prev.slice(0, -1));
    }
  }

  // ── ② "브러쉬로 분리" 상태 ──────────────────────────────────────────────────
  const [brushName, setBrushName] = useState("");
  const [eraseMode, setEraseMode] = useState(false);
  // 캔버스 내부 해상도: 긴 변을 640px 로, 비율 유지.
  const [canvasW, canvasH] = useMemo<[number, number]>(() => {
    if (imageWidth >= imageHeight) return [640, Math.round((640 * imageHeight) / imageWidth)];
    return [Math.round((640 * imageWidth) / imageHeight), 640];
  }, [imageWidth, imageHeight]);

  const displayCanvasRef = useRef<HTMLCanvasElement>(null);
  // 숨겨진 마스크 캔버스 — DOM 에 렌더하지 않고 메모리에서만 관리.
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgLoadedRef = useRef<HTMLImageElement | null>(null);
  const isDrawingRef = useRef(false);
  const [brushSize, setBrushSize] = useState(24);
  const brushViewRef = useRef<HTMLDivElement>(null);
  const zp = useZoomPan();

  useEffect(() => {
    maskCanvasRef.current = document.createElement("canvas");
  }, []);

  // 이미지 로드 → displayCanvas 에 그리고, maskCanvas 를 검정으로 채운다.
  // 브러쉬 탭 진입(또는 imageUrl·치수 변경) 시 초기화.
  useEffect(() => {
    if (tab !== "brush") return;
    const mask = maskCanvasRef.current;
    if (!mask) return;
    mask.width = canvasW;
    mask.height = canvasH;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = imageUrl;
    img.onload = () => {
      const display = displayCanvasRef.current;
      if (!display) return;
      const ctx = display.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvasW, canvasH);
      ctx.drawImage(img, 0, 0, canvasW, canvasH);
      const mCtx = mask.getContext("2d");
      if (mCtx) mCtx.clearRect(0, 0, canvasW, canvasH); // 투명 배경
      imgLoadedRef.current = img;
    };
  }, [tab, imageUrl, canvasW, canvasH]);

  // 브러쉬 뷰 컨테이너에서 휠로 줌.
  useEffect(() => {
    if (tab !== "brush") return;
    const el = brushViewRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) zp.zoomIn();
      else zp.zoomOut();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [tab, zp.zoomIn, zp.zoomOut]);

  function getPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = displayCanvasRef.current!.getBoundingClientRect();
    const scaleX = canvasW / rect.width;
    const scaleY = canvasH / rect.height;
    return { x: (e.clientX - rect.left) * scaleX, y: (e.clientY - rect.top) * scaleY };
  }

  const paint = useCallback(
    (x: number, y: number) => {
      const display = displayCanvasRef.current;
      const mask = maskCanvasRef.current;
      const img = imgLoadedRef.current;
      if (!display || !mask) return;
      // 1. maskCanvas: 페인트 → 빨간 원 누적 / 지우개 → destination-out 으로 제거.
      const mCtx = mask.getContext("2d");
      if (mCtx) {
        if (eraseMode) {
          mCtx.globalCompositeOperation = "destination-out";
          mCtx.fillStyle = "rgba(0,0,0,1)";
        } else {
          mCtx.globalCompositeOperation = "source-over";
          mCtx.fillStyle = "red";
        }
        mCtx.beginPath();
        mCtx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
        mCtx.fill();
        mCtx.globalCompositeOperation = "source-over";
      }
      // 2. displayCanvas = 원본 이미지 + maskCanvas 50% 오버레이 — 매번 재합성해
      //    알파 누적 없이 일정한 반투명도를 유지한다.
      const dCtx = display.getContext("2d");
      if (dCtx) {
        dCtx.clearRect(0, 0, display.width, display.height);
        if (img) dCtx.drawImage(img, 0, 0, display.width, display.height);
        dCtx.globalAlpha = 0.5;
        dCtx.drawImage(mask, 0, 0);
        dCtx.globalAlpha = 1;
      }
    },
    [brushSize, eraseMode],
  );

  function clearBrush() {
    const display = displayCanvasRef.current;
    const mask = maskCanvasRef.current;
    const img = imgLoadedRef.current;
    if (display && img) {
      const ctx = display.getContext("2d");
      if (ctx) {
        ctx.clearRect(0, 0, canvasW, canvasH);
        ctx.drawImage(img, 0, 0, canvasW, canvasH);
      }
    }
    if (mask) {
      const mCtx = mask.getContext("2d");
      if (mCtx) mCtx.clearRect(0, 0, canvasW, canvasH);
    }
  }

  function handleBrushSubmit() {
    if (busy) return;
    const maskDataUrl = maskCanvasRef.current!.toDataURL("image/png");
    onBrushSubmit({ maskDataUrl, prompt: brushName.trim() || "선택 영역" });
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Layers size={14} /> 레이어 분리
        </span>
        <span className="text-xs text-text-muted/60">{parentGenerationId.slice(0, 6)}…</span>
        <button
          onClick={onCancel}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-4 overflow-y-auto p-4">
        {tab === "input" ? (
          <>
            {/* ① 이미지 미리보기 — 브러쉬 탭과 동일한 크기 */}
            <div
              className="flex items-center justify-center overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/14px_14px]"
              style={{ height: canvasH }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="원본 이미지"
                className="max-h-full max-w-full object-contain"
              />
            </div>

            {/* ② 탭 버튼 */}
            <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-sm">
              <button
                onClick={() => setTab("input")}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/20 px-2 text-text-primary"
              >
                <Tags size={13} /> 입력으로 분리
              </button>
              <button
                onClick={() => setTab("brush")}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded border border-transparent px-2 text-text-muted hover:text-text-primary"
              >
                <Paintbrush size={13} /> 브러쉬로 분리
              </button>
            </div>

            {/* ③ 안내 카드 */}
            <div className="rounded-lg bg-bg-card p-3">
              <p className="flex items-center gap-1 text-sm font-medium text-text-primary">
                <Sparkles size={13} /> 레이어 분리
              </p>
              <p className="mt-1 text-xs leading-relaxed text-text-muted">
                분리할 부위 이름을 입력하세요. AI 가 각 부위를 투명 배경 PNG 로 추출합니다.
              </p>
              <label className="mt-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-text-muted/70 select-none">
                <input
                  type="checkbox"
                  checked={autoRestore}
                  onChange={e => setAutoRestore(e.target.checked)}
                  className="accent-[color:var(--accent)]"
                />
                가려진 부분 AI 자동 복원
              </label>
              <p className="text-[10px] text-text-muted/50">권장: 3~5개 부위</p>
            </div>

            {/* ③ 부위 입력 영역 */}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-text-muted">분리할 부위</label>
              <div className="rounded-lg border border-border bg-bg-card focus-within:border-[color:var(--accent)]/60 transition-colors">
                <div className="flex flex-wrap gap-1.5 p-2">
                  {parts.map((p, i) => (
                    <span
                      key={`${p}-${i}`}
                      className="flex items-center gap-1 rounded-full bg-[color:var(--accent)]/20 px-2 py-0.5 text-[11px] text-text-primary"
                    >
                      {p}
                      <button
                        onClick={() => removePart(i)}
                        disabled={busy}
                        className="rounded-full text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                        title="제거"
                      >
                        <X size={11} />
                      </button>
                    </span>
                  ))}
                  <input
                    type="text"
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={onKeyDown}
                    onBlur={commitInput}
                    disabled={busy || parts.length >= MAX_PARTS}
                    placeholder={
                      parts.length >= MAX_PARTS
                        ? `최대 ${MAX_PARTS}개`
                        : "예: 머리띠, 얼굴, 몸통, 눈…"
                    }
                    className="h-6 min-w-[120px] flex-1 bg-transparent px-1 text-[12px] text-text-primary placeholder:text-text-muted/50 focus:outline-none disabled:cursor-not-allowed"
                  />
                </div>
                <div className="flex items-center border-t border-border px-2 py-1.5">
                  <div className="relative ml-auto">
                    <AiSuggestButton loading={aiLoading} onClick={handleAiSuggest} />
                    {aiSuggestions && (
                      <AiSuggestDropdown
                        suggestions={aiSuggestions}
                        width="w-[320px]"
                        onSelect={v => {
                          setParts(v.split(",").map(s => s.trim()).filter(Boolean).slice(0, MAX_PARTS));
                          setAiSuggestions(null);
                        }}
                        onClose={() => setAiSuggestions(null)}
                      />
                    )}
                  </div>
                </div>
              </div>
              {aiError && (
                <p className="text-[11px] text-[color:var(--danger)]">{aiError}</p>
              )}
              <p className="text-[10px] leading-tight text-text-muted/70">
                Enter 또는 쉼표(,)로 부위 추가 · {parts.length}/{MAX_PARTS}
              </p>
            </div>
          </>
        ) : (
          <>
            {/* 브러쉬 캔버스 — 줌/팬 뷰박스 */}
            <div
              ref={brushViewRef}
              className="relative overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/14px_14px]"
              style={{ height: canvasH }}
              onPointerDown={zp.onPanPointerDown}
              onPointerMove={zp.onPanPointerMove}
              onPointerUp={zp.onPanPointerUp}
            >
              <div
                style={{
                  position: "absolute",
                  top: "50%",
                  left: "50%",
                  transform: `translate(-50%, -50%) translate(${zp.pan.x}px, ${zp.pan.y}px) scale(${zp.zoom})`,
                  transformOrigin: "center",
                }}
              >
                <canvas
                  ref={displayCanvasRef}
                  width={canvasW}
                  height={canvasH}
                  onMouseDown={e => {
                    if (busy || zp.panMode) return;
                    isDrawingRef.current = true;
                    const { x, y } = getPos(e);
                    paint(x, y);
                  }}
                  onMouseMove={e => {
                    if (!isDrawingRef.current) return;
                    const { x, y } = getPos(e);
                    paint(x, y);
                  }}
                  onMouseUp={() => { isDrawingRef.current = false; }}
                  onMouseLeave={() => { isDrawingRef.current = false; }}
                  style={{ width: canvasW, height: canvasH, display: "block", cursor: zp.panMode ? "grab" : eraseMode ? "cell" : "crosshair" }}
                />
              </div>
              <ZoomPanControls zp={zp} />
            </div>

            {/* 탭 버튼 */}
            <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-sm">
              <button
                onClick={() => setTab("input")}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded border border-transparent px-2 text-text-muted hover:text-text-primary"
              >
                <Tags size={13} /> 입력으로 분리
              </button>
              <button
                onClick={() => setTab("brush")}
                className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded border border-[color:var(--accent)] bg-[color:var(--accent)]/20 px-2 text-text-primary"
              >
                <Paintbrush size={13} /> 브러쉬로 분리
              </button>
            </div>

            {/* 브러쉬 컨트롤 */}
            <div className="flex items-center gap-2 text-xs">
              <span className="shrink-0 text-text-muted">크기</span>
              <input
                type="range"
                min={4}
                max={80}
                value={brushSize}
                onChange={e => setBrushSize(Number(e.target.value))}
                className="flex-1 accent-[color:var(--accent)]"
              />
              <span className="w-10 text-right tabular-nums text-text-muted/80">{brushSize}px</span>
              <button
                onClick={() => setEraseMode(v => !v)}
                title={eraseMode ? "페인트 모드로 전환" : "지우개 모드로 전환"}
                className={`shrink-0 rounded-lg border px-2 py-1 ${
                  eraseMode
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border text-text-muted hover:text-text-primary"
                }`}
              >
                <Eraser size={13} />
              </button>
              <button
                onClick={clearBrush}
                className="shrink-0 rounded-lg border border-border px-3 py-1 text-text-muted hover:text-text-primary"
              >
                전체 지우기
              </button>
            </div>

            {/* 부위 이름 입력 */}
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-text-muted">부위 이름 (선택)</label>
              <input
                type="text"
                value={brushName}
                onChange={e => setBrushName(e.target.value)}
                placeholder="예: 머리, 검, 망토…"
                disabled={busy}
                className="h-8 rounded-lg border border-border bg-bg-card px-2 text-[12px] text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none disabled:cursor-not-allowed"
              />
              <p className="text-[10px] text-text-muted/50">결과 레이블과 AI 추출 힌트로 사용됩니다</p>
            </div>
          </>
        )}

        {/* 추출 결과 그리드 (양쪽 탭 공통) */}
        {results.length > 0 && (
          <div className="flex flex-col gap-2 pt-2">
            <p className="text-xs font-medium text-text-muted">추출 결과 ({results.length})</p>
            <div className="grid grid-cols-3 gap-2">
              {results.map(r => (
                <div key={r.id} className="flex flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={r.url}
                    alt={r.prompt}
                    className="w-full rounded border border-border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/14px_14px] object-contain"
                    style={{ aspectRatio: "1" }}
                  />
                  <p className="truncate text-center text-[10px] text-text-muted">{r.prompt}</p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
        <button
          onClick={onCancel}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        {tab === "input" ? (
          <button
            onClick={() => onSubmit({ parts, autoRestore })}
            disabled={parts.length === 0 || busy}
            className="flex h-9 flex-[2] items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 처리 중…
              </>
            ) : (
              `분리 실행 (${parts.length}개 부위)`
            )}
          </button>
        ) : (
          <button
            onClick={handleBrushSubmit}
            disabled={busy}
            className="flex h-9 flex-[2] items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          >
            {busy ? (
              <>
                <Loader2 size={14} className="animate-spin" /> 처리 중…
              </>
            ) : (
              "브러쉬 영역 추출"
            )}
          </button>
        )}
      </footer>
    </aside>
  );
}


