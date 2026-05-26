"use client";

import { Brush, Eraser, RotateCcw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * MaskCanvas — 인페인트 마스크를 그리는 작은 캔버스 + 컨트롤.
 *
 * 동작:
 *  - 두 캔버스 layer 를 stack: bottom 은 원본 이미지(읽기 전용), top 은 마스크(drawing).
 *  - brush/eraser 두 도구. drag 로 stroke 누적, stroke 단위로 undo 가능.
 *  - 화면 표시 크기는 600px 까지 다운스케일 — drawing 좌표는 표시 좌표.
 *  - 제출 시 원본 해상도(imageWidth×imageHeight) 의 binary PNG 로 re-render:
 *      칠한 영역 = #ff0000, 나머지 = #000000 (alpha=255). codex 가 RED 영역으로 인식.
 *
 * Props 의 onSubmit 으로 마스크 dataUrl 과 prompt 를 부모에 넘김 — 업로드/chat 호출은 부모가 처리.
 */

type Tool = "brush" | "eraser";
type Stroke = {
  tool: Tool;
  size: number;
  // 화면 좌표 (캔버스 px). 마스크 export 시점에 원본 해상도로 scale up.
  points: { x: number; y: number }[];
};

type Props = {
  /** 원본 이미지의 generationId — 마스크 generation 의 parent 로 사용. */
  parentGenerationId: string;
  /** 원본 이미지 URL — preview 용. */
  imageUrl: string;
  /** 원본 해상도. 마스크 export 시 이 크기로 스케일 업. */
  imageWidth: number;
  imageHeight: number;
  /** 캔버스 한 변의 최대 px. 패널이 더 좁으면 부모 폭에 자동 맞춤. 기본 1200. */
  maxDisplayPx?: number;
  /** 사용자가 prompt 와 마스크를 확정. dataUrl 은 `image/png` base64. */
  onSubmit: (args: { maskDataUrl: string; prompt: string }) => void;
  onCancel: () => void;
  /** 외부 generating 상태 — 인페인트 중이면 실행 버튼 disable. */
  busy?: boolean;
};

export function MaskCanvas({
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
  // 캔버스 컨테이너 (외곽 div) 의 사용 가능한 폭을 mount 시 측정해 캔버스 최대 폭으로 사용.
  // 패널이 좁으면 더 작게, 넓으면 maxDisplayPx 까지. strokes 좌표 정합성을 위해 1회만 측정.
  const sizerRef = useRef<HTMLDivElement>(null);
  const [availW, setAvailW] = useState<number | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(40);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [prompt, setPrompt] = useState("");
  const drawingRef = useRef<Stroke | null>(null);

  useLayoutEffect(() => {
    const el = sizerRef.current;
    if (!el) return;
    // 패딩·border 고려: 24px 정도 여유.
    const w = Math.max(200, el.clientWidth - 24);
    setAvailW(w);
  }, []);

  // 화면 표시 크기 (캔버스 size = display size). max(availW, maxDisplayPx) 안에서 등비 축소.
  const cap = availW != null ? Math.min(maxDisplayPx, availW) : maxDisplayPx;
  const scale = Math.min(1, cap / Math.max(imageWidth, imageHeight));
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

  // 1. 원본 이미지를 bottom 캔버스에 한 번만 그림
  useEffect(() => {
    const c = baseRef.current;
    if (!c) return;
    c.width = displayW;
    c.height = displayH;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      ctx.clearRect(0, 0, displayW, displayH);
      ctx.drawImage(img, 0, 0, displayW, displayH);
    };
    img.src = imageUrl;
  }, [imageUrl, displayW, displayH]);

  // 2. strokes 가 변할 때마다 마스크 layer 를 통째로 다시 그림 (단순 + 안전)
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
      ctx.strokeStyle = "rgba(255, 0, 0, 0.55)";
      ctx.lineWidth = s.size;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      // eraser 의 경우 stroke 색은 무관, source-out 이라 alpha 만 영향.
      ctx.stroke();
    }
  }, [strokes, displayW, displayH]);

  // ── pointer events ─────────────────────────────────────────────────────────
  const startStroke = useCallback(
    (x: number, y: number) => {
      drawingRef.current = { tool, size: brushSize, points: [{ x, y }] };
      // 즉시 1점이라도 보이도록 re-render trigger
      setStrokes(s => [...s]);
    },
    [tool, brushSize],
  );

  const continueStroke = useCallback((x: number, y: number) => {
    const s = drawingRef.current;
    if (!s) return;
    const last = s.points[s.points.length - 1];
    // 미세 지터 제거: 1px 이하 이동은 무시
    if (Math.abs(last.x - x) < 1 && Math.abs(last.y - y) < 1) return;
    s.points.push({ x, y });
    setStrokes(prev => [...prev]); // force re-render
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

  // ── export & submit ────────────────────────────────────────────────────────
  function exportMaskDataUrl(): string {
    // 원본 해상도로 다시 그림. binary: 칠한 영역=#ff0000, 나머지=#000000, alpha=255
    const out = document.createElement("canvas");
    out.width = imageWidth;
    out.height = imageHeight;
    const ctx = out.getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, imageWidth, imageHeight);
    ctx.fillStyle = "#ff0000";
    ctx.strokeStyle = "#ff0000";
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const inv = 1 / scale;
    for (const s of strokes) {
      if (s.points.length === 0) continue;
      if (s.tool === "eraser") {
        // eraser 는 검정으로 다시 칠하기 (destination-out 대신 단순 색 칠해 binary 유지)
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "#000000";
      } else {
        ctx.globalCompositeOperation = "source-over";
        ctx.strokeStyle = "#ff0000";
      }
      ctx.lineWidth = s.size * inv;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x * inv, s.points[0].y * inv);
      for (let i = 1; i < s.points.length; i++)
        ctx.lineTo(s.points[i].x * inv, s.points[i].y * inv);
      ctx.stroke();
    }
    return out.toDataURL("image/png");
  }

  const hasStrokes = strokes.length > 0;

  function submit() {
    if (!hasStrokes || !prompt.trim() || busy) return;
    onSubmit({ maskDataUrl: exportMaskDataUrl(), prompt: prompt.trim() });
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <span className="font-medium text-text-primary">✏ 인페인트</span>
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
        <p className="text-xs text-text-muted">다시 그릴 영역을 brush 로 칠하세요.</p>

        {/* 캔버스 영역 */}
        <div
          className="relative mx-auto select-none rounded-lg border border-border bg-bg-card"
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
              e.currentTarget.setPointerCapture(e.pointerId);
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

        {/* 도구 toolbar */}
        <div className="space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex gap-1">
            <button
              onClick={() => setTool("brush")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                tool === "brush"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
            >
              <Brush size={12} /> 브러시
            </button>
            <button
              onClick={() => setTool("eraser")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                tool === "eraser"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
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
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-30"
              title="마지막 stroke 취소 (Cmd+Z 미구현)"
            >
              <RotateCcw size={12} /> 실행취소
            </button>
            <button
              onClick={() => setStrokes([])}
              disabled={!hasStrokes}
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-30"
              title="모든 마스크 지우기"
            >
              <Trash2 size={12} /> 지우기
            </button>
          </div>
        </div>

        {/* prompt */}
        <div className="space-y-1">
          <label className="text-xs text-text-muted">무엇으로 바꿀까요?</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="예: 더 큰 검, 보라색 마법 크리스탈, 황금 코인…"
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
          />
        </div>
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        <button
          onClick={onCancel}
          disabled={busy}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary disabled:opacity-40"
        >
          ✕ 취소
        </button>
        <button
          onClick={submit}
          disabled={!hasStrokes || !prompt.trim() || busy}
          className="h-9 flex-[2] rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          title={!hasStrokes ? "마스크가 비어있음" : !prompt.trim() ? "프롬프트 입력 필요" : ""}
        >
          {busy ? "실행 중..." : "✓ 인페인트 실행"}
        </button>
      </footer>
    </aside>
  );
}
