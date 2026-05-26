"use client";

import { Download, Eraser, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * LayerCanvas — 원본 이미지를 4색 brush 로 칠해 부위별 레이어로 분리.
 *
 * 동작:
 *  - MaskCanvas 와 동일한 두 캔버스 stack (base 원본 / mask 마스크 layer).
 *  - 색 4종 (R/G/B/Y) brush + eraser. 각 stroke 에 color index 보유.
 *  - 표시 좌표로 stroke 누적, export 시 원본 해상도로 scale up.
 *  - 제출 시 각 색별로 (원본 × binary mask) 합성 PNG dataUrl N=4 생성. 색이 한 번도
 *    안 칠해진 레이어는 제외 (DB 빈 레이어 회피).
 *
 * 상태:
 *  - `phase === "draw"` — brush 동작 + 도구 toolbar.
 *  - `phase === "result"` — submit 성공 후 색별 결과 thumbnail + 다운로드.
 */

type Tool = "brush" | "eraser";
type ColorKey =
  | "red"
  | "green"
  | "blue"
  | "yellow"
  | "cyan"
  | "magenta"
  | "orange"
  | "purple";
const COLORS: Record<ColorKey, { hex: string; ko: string }> = {
  red: { hex: "#ef4444", ko: "빨강" },
  green: { hex: "#22c55e", ko: "초록" },
  blue: { hex: "#3b82f6", ko: "파랑" },
  yellow: { hex: "#eab308", ko: "노랑" },
  cyan: { hex: "#06b6d4", ko: "청록" },
  magenta: { hex: "#ec4899", ko: "자홍" },
  orange: { hex: "#f97316", ko: "주황" },
  purple: { hex: "#a855f7", ko: "보라" },
};
const COLOR_KEYS: ColorKey[] = [
  "red",
  "green",
  "blue",
  "yellow",
  "cyan",
  "magenta",
  "orange",
  "purple",
];

type Stroke = {
  tool: Tool;
  color: ColorKey;
  size: number;
  points: { x: number; y: number }[];
};

type LayerResult = { generationId: string; colorLabel: string; width: number; height: number };

type SubmitMode = "crop" | "inpaint";
type SubmitArgs = {
  mode: SubmitMode;
  /** crop: 원본 × binary mask 합성 PNG (alpha 보존).
   *  inpaint: codex 가 인식하는 binary mask PNG (red=복원할 영역, black=보존). */
  layers: Array<{ colorLabel: ColorKey; dataUrl: string }>;
};

type Props = {
  parentGenerationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  maxDisplayPx?: number;
  /** crop 모드는 결과 list 반환 (result phase 표시).
   *  inpaint 모드는 직렬 chat 호출이라 결과 카드가 chat 에 누적 — 빈 list 반환 후 즉시 닫힘. */
  onSubmit: (args: SubmitArgs) => Promise<LayerResult[]>;
  onCancel: () => void;
  /** 외부 generating 상태. */
  busy?: boolean;
};

export function LayerCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  maxDisplayPx = 1200,
  onSubmit,
  onCancel,
  busy = false,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [color, setColor] = useState<ColorKey>("red");
  const [brushSize, setBrushSize] = useState(40);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [mode, setMode] = useState<SubmitMode>("crop");
  const [phase, setPhase] = useState<"draw" | "result">("draw");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LayerResult[]>([]);
  const drawingRef = useRef<Stroke | null>(null);

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const w = Math.max(200, sizer.clientWidth - 24);
    const tb = toolbarRef.current?.getBoundingClientRect().height ?? 160;
    const reserved = tb + 36 + 20 + 36;
    const h = Math.max(200, sizer.clientHeight - reserved);
    setAvail({ w, h });
  }, []);

  const cap = avail ? Math.min(maxDisplayPx, avail.w, avail.h) : maxDisplayPx;
  const scale = Math.min(1, cap / Math.max(imageWidth, imageHeight));
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

  // 1-a. 원본 이미지 load
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => {
    // 의도적 reset — imageUrl 교체 시 race 방지. (MaskCanvas 와 동일 패턴.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImgLoaded(false);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      setImgLoaded(true);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // 1-b. base 캔버스 redraw
  useEffect(() => {
    const c = baseRef.current;
    const img = imgRef.current;
    if (!c || !img || !imgLoaded) return;
    c.width = displayW;
    c.height = displayH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.drawImage(img, 0, 0, displayW, displayH);
  }, [imgLoaded, displayW, displayH]);

  // 2. mask 캔버스 redraw — 모든 stroke 다시 그림
  useEffect(() => {
    const c = maskRef.current;
    if (!c) return;
    c.width = displayW;
    c.height = displayH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, displayW, displayH);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const s of [...strokes, ...(drawingRef.current ? [drawingRef.current] : [])]) {
      if (s.points.length === 0) continue;
      ctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      const hex = COLORS[s.color].hex;
      ctx.strokeStyle = hexToRgba(hex, 0.55);
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      ctx.stroke();
    }
  }, [strokes, displayW, displayH]);

  // ── pointer events ─────────────────────────────────────────────────────────
  const startStroke = useCallback(
    (x: number, y: number) => {
      drawingRef.current = { tool, color, size: brushSize, points: [{ x, y }] };
      setStrokes(s => [...s]);
    },
    [tool, color, brushSize],
  );

  const continueStroke = useCallback((x: number, y: number) => {
    const s = drawingRef.current;
    if (!s) return;
    const last = s.points[s.points.length - 1];
    if (Math.abs(last.x - x) < 1 && Math.abs(last.y - y) < 1) return;
    s.points.push({ x, y });
    setStrokes(prev => [...prev]);
  }, []);

  const endStroke = useCallback(() => {
    const s = drawingRef.current;
    drawingRef.current = null;
    if (s && s.points.length > 0) setStrokes(prev => [...prev, s]);
  }, []);

  function pointerPos(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ── export ────────────────────────────────────────────────────────────────
  // 색별 binary mask (원본 해상도, white=영역, transparent=그 외). 색 stroke 가 없거나
  // eraser 로 모두 지워졌으면 null.
  function buildColorMask(colorKey: ColorKey): HTMLCanvasElement | null {
    const colorStrokes = strokes.filter(s => s.color === colorKey);
    if (colorStrokes.length === 0) return null;
    const inv = 1 / scale;
    const maskC = document.createElement("canvas");
    maskC.width = imageWidth;
    maskC.height = imageHeight;
    const mctx = maskC.getContext("2d");
    if (!mctx) return null;
    mctx.lineCap = "round";
    mctx.lineJoin = "round";
    mctx.strokeStyle = "#ffffff";
    for (const s of colorStrokes) {
      mctx.globalCompositeOperation = s.tool === "eraser" ? "destination-out" : "source-over";
      mctx.lineWidth = s.size * inv;
      mctx.beginPath();
      mctx.moveTo(s.points[0].x * inv, s.points[0].y * inv);
      for (let i = 1; i < s.points.length; i++) mctx.lineTo(s.points[i].x * inv, s.points[i].y * inv);
      mctx.stroke();
    }
    if (!hasAnyPixel(mctx, imageWidth, imageHeight)) return null;
    return maskC;
  }

  // crop 모드: 색별로 원본 × binary mask 합성 PNG (alpha 보존).
  function exportCropLayers(): Array<{ colorLabel: ColorKey; dataUrl: string }> {
    const img = imgRef.current;
    if (!img) return [];
    const out: Array<{ colorLabel: ColorKey; dataUrl: string }> = [];
    for (const colorKey of COLOR_KEYS) {
      const maskC = buildColorMask(colorKey);
      if (!maskC) continue;
      const outC = document.createElement("canvas");
      outC.width = imageWidth;
      outC.height = imageHeight;
      const octx = outC.getContext("2d");
      if (!octx) continue;
      octx.drawImage(img, 0, 0, imageWidth, imageHeight);
      octx.globalCompositeOperation = "destination-in";
      octx.drawImage(maskC, 0, 0);
      out.push({ colorLabel: colorKey, dataUrl: outC.toDataURL("image/png") });
    }
    return out;
  }

  // inpaint 모드: 색별로 codex 가 인식하는 binary mask PNG (red=복원할 영역, black=보존).
  // 복원 영역 = "다른 색으로 칠해진 모든 곳" (= 그 부위를 가리는 다른 부위). 안 칠한 영역은
  // 검정 (보존) — 원본 그대로. 따라서 사용자가 모든 픽셀을 칠하지 않아도 부분 복원 가능.
  function exportInpaintMasks(): Array<{ colorLabel: ColorKey; dataUrl: string }> {
    const out: Array<{ colorLabel: ColorKey; dataUrl: string }> = [];
    for (const colorKey of COLOR_KEYS) {
      const selfMask = buildColorMask(colorKey);
      if (!selfMask) continue;
      // others = union of all other colors' masks
      const othersC = document.createElement("canvas");
      othersC.width = imageWidth;
      othersC.height = imageHeight;
      const octx = othersC.getContext("2d");
      if (!octx) continue;
      for (const other of COLOR_KEYS) {
        if (other === colorKey) continue;
        const m = buildColorMask(other);
        if (m) octx.drawImage(m, 0, 0);
      }
      if (!hasAnyPixel(octx, imageWidth, imageHeight)) continue; // 다른 색이 없으면 inpaint 불필요
      // final: red where others & not self, black elsewhere. 검정 base 위에 others = red 칠하고,
      // self 영역은 다시 검정으로 덮어씀 (겹친 영역은 보존이 우선).
      const finalC = document.createElement("canvas");
      finalC.width = imageWidth;
      finalC.height = imageHeight;
      const fctx = finalC.getContext("2d");
      if (!fctx) continue;
      fctx.fillStyle = "#000000";
      fctx.fillRect(0, 0, imageWidth, imageHeight);
      // others = red
      const redC = document.createElement("canvas");
      redC.width = imageWidth;
      redC.height = imageHeight;
      const rctx = redC.getContext("2d");
      if (!rctx) continue;
      rctx.fillStyle = "#ff0000";
      rctx.fillRect(0, 0, imageWidth, imageHeight);
      rctx.globalCompositeOperation = "destination-in";
      rctx.drawImage(othersC, 0, 0);
      // self 영역은 빼기
      rctx.globalCompositeOperation = "destination-out";
      rctx.drawImage(selfMask, 0, 0);
      fctx.drawImage(redC, 0, 0);
      out.push({ colorLabel: colorKey, dataUrl: finalC.toDataURL("image/png") });
    }
    return out;
  }

  const hasStrokes = strokes.length > 0;

  async function submit() {
    if (!hasStrokes || submitting || busy) return;
    setError(null);
    setSubmitting(true);
    try {
      const layers = mode === "crop" ? exportCropLayers() : exportInpaintMasks();
      if (layers.length === 0) {
        setError(
          mode === "crop"
            ? "칠해진 영역이 없습니다."
            : "AI 복원은 두 색 이상 칠해야 합니다 (가릴 다른 부위가 필요).",
        );
        return;
      }
      const res = await onSubmit({ mode, layers });
      // inpaint 모드는 chat 으로 결과 흐름 — result phase 진입 안 함.
      if (mode === "crop") {
        setResults(res);
        setPhase("result");
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function downloadResult(r: LayerResult) {
    const a = document.createElement("a");
    a.href = `/api/images/${r.generationId}`;
    a.download = `${r.generationId}.png`;
    a.click();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <span className="font-medium text-text-primary">🎨 레이어 분리</span>
        <span className="text-xs text-text-muted/60">
          {imageWidth}×{imageHeight} · parent {parentGenerationId.slice(0, 6)}…
        </span>
        <button
          onClick={onCancel}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div ref={sizerRef} className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {phase === "draw" ? (
          <>
            <p className="text-xs text-text-muted">
              부위별로 색을 바꿔가며 칠하세요. 색마다 별도 PNG 가 생성됩니다.
            </p>

            <div
              className="relative mx-auto shrink-0 select-none rounded-lg border border-border bg-bg-card"
              style={{ width: displayW, height: displayH }}
            >
              <canvas
                ref={baseRef}
                className="pointer-events-none absolute inset-0"
                width={displayW}
                height={displayH}
              />
              <canvas
                ref={maskRef}
                className="absolute inset-0 cursor-crosshair touch-none"
                width={displayW}
                height={displayH}
                onPointerDown={e => {
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {}
                  const { x, y } = pointerPos(e);
                  startStroke(x, y);
                }}
                onPointerMove={e => {
                  if (drawingRef.current == null) return;
                  const { x, y } = pointerPos(e);
                  continueStroke(x, y);
                }}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
              />
            </div>

            <div
              ref={toolbarRef}
              className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs"
            >
              <div className="flex gap-1">
                {COLOR_KEYS.map(k => {
                  const active = color === k && tool === "brush";
                  const c = COLORS[k];
                  const count = strokes.filter(s => s.color === k && s.tool === "brush").length;
                  return (
                    <button
                      key={k}
                      onClick={() => {
                        setColor(k);
                        setTool("brush");
                      }}
                      className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                        active ? "text-text-primary" : "text-text-muted hover:text-text-primary"
                      }`}
                      style={{
                        borderColor: active ? c.hex : undefined,
                        background: active ? `${c.hex}33` : undefined,
                      }}
                      title={`${c.ko} 레이어 (stroke ${count})`}
                    >
                      <span
                        className="inline-block size-3 rounded-full"
                        style={{ background: c.hex }}
                      />
                      <span className="hidden sm:inline">{c.ko}</span>
                    </button>
                  );
                })}
                <button
                  onClick={() => setTool("eraser")}
                  className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                    tool === "eraser"
                      ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                      : "border-border text-text-muted hover:text-text-primary"
                  }`}
                  title="현재 색의 stroke 지우기"
                >
                  <Eraser size={12} /> 지우개
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-12 text-text-muted">크기</span>
                <input
                  type="range"
                  min={4}
                  max={120}
                  value={brushSize}
                  onChange={e => setBrushSize(Number(e.target.value))}
                  className="flex-1 accent-[color:var(--accent)]"
                />
                <span className="w-10 text-right tabular-nums text-text-muted/80">{brushSize}px</span>
              </div>
              <div className="flex gap-1">
                <button
                  onClick={() => setStrokes(s => s.slice(0, -1))}
                  disabled={!hasStrokes}
                  className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border bg-bg-app px-2 text-text-primary hover:border-[color:var(--accent)]/60 hover:bg-[color:var(--accent)]/10 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <RotateCcw size={12} /> 실행취소
                </button>
                <button
                  onClick={() => setStrokes([])}
                  disabled={!hasStrokes}
                  className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border bg-bg-app px-2 text-text-primary hover:border-[color:var(--danger)]/60 hover:bg-[color:var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-30"
                >
                  <Trash2 size={12} /> 모두 지우기
                </button>
              </div>
              <div className="border-t border-border pt-2">
                <label className="flex items-start gap-2 text-text-muted">
                  <input
                    type="checkbox"
                    checked={mode === "inpaint"}
                    onChange={e => setMode(e.target.checked ? "inpaint" : "crop")}
                    className="mt-0.5 size-3.5 accent-[color:var(--accent)]"
                  />
                  <span className="flex-1 leading-tight">
                    <span className="text-text-primary">⚡ AI 복원</span> — 가려진 영역을
                    codex 가 자연스럽게 복원 (색별 1회씩 호출, 시간 N배·구독 한도 차감).
                  </span>
                </label>
              </div>
              {error && <p className="text-[11px] text-[color:var(--danger)]">{error}</p>}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              {results.length}개 레이어가 생성되었습니다. 각 레이어는 결과 카드처럼 세션에도 저장돼요.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {results.map(r => {
                const c = COLORS[r.colorLabel as ColorKey];
                return (
                  <div
                    key={r.generationId}
                    className="overflow-hidden rounded-lg border border-border bg-bg-card"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/images/${r.generationId}`}
                      alt={r.colorLabel}
                      className="block aspect-square w-full bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/16px_16px]"
                    />
                    <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{ background: c?.hex ?? "#888" }}
                      />
                      <span className="flex-1 text-text-muted">{c?.ko ?? r.colorLabel}</span>
                      <button
                        onClick={() => downloadResult(r)}
                        className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                        title="PNG 다운로드"
                      >
                        <Download size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        {phase === "draw" ? (
          <>
            <button
              onClick={onCancel}
              disabled={submitting}
              className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary disabled:opacity-40"
            >
              ✕ 취소
            </button>
            <button
              onClick={submit}
              disabled={!hasStrokes || submitting || busy}
              className="h-9 flex-[2] rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
            >
              {submitting
                ? mode === "inpaint"
                  ? "AI 복원 요청 중..."
                  : "분리 중..."
                : `✓ ${mode === "inpaint" ? "AI 복원" : "레이어 분리"} (${new Set(strokes.map(s => s.color)).size}색)`}
            </button>
          </>
        ) : (
          <button
            onClick={onCancel}
            className="h-9 flex-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white"
          >
            ✓ 완료
          </button>
        )}
      </footer>
    </aside>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────
function hexToRgba(hex: string, alpha: number): string {
  const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** mask 캔버스에 alpha > 0 픽셀이 하나라도 있는지. (전체 스캔 — 4MP 캔버스에 ~수십 ms) */
function hasAnyPixel(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}
