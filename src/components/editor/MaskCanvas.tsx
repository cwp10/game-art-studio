"use client";

import { Brush, ChevronDown, Edit3, Eraser, Loader2, Maximize2, RotateCcw, Scissors, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { listGenerations } from "@/lib/api/client";
import type { Generation } from "@/types/db";
import { rectRatioPoint, useZoomPan, ZoomPanControls } from "./useZoomPan";

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
  /** 참조 이미지 목록을 불러올 세션. undefined 면 전체 갤러리에서 로드. */
  sessionId?: string | null;
  /**
   * 실행 — 한 번에 통합 적용. 셋 다 선택적이며 args 에 담긴 것만 순차 적용된다:
   *  - maskDataUrl+prompt: 인페인트 / resizeTarget: 정사각 리사이즈 / removeBg: 배경 제거
   */
  onSubmit: (args: {
    maskDataUrl: string | null;
    prompt: string;
    resizeTarget: number | null;
    removeBg: boolean;
    referenceGenerationId: string | null;
  }) => void;
  onCancel: () => void;
  /** 실행 중인 생성을 취소(abort). busy 일 때 취소 버튼이 이것을 호출. */
  onCancelGeneration?: () => void;
  /** 외부 generating 상태 — 실행 중이면 실행 버튼 disable. */
  busy?: boolean;
};

/** 리사이즈는 무조건 정사각형. label 은 표시용. */
const RESIZE_OPTIONS: { px: number; label: string }[] = [
  { px: 64, label: "64" },
  { px: 256, label: "256" },
  { px: 512, label: "512" },
  { px: 1024, label: "1K" },
  { px: 2048, label: "2K" },
  { px: 4096, label: "4K" },
  { px: 8192, label: "8K" },
];

export function MaskCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  maxDisplayPx = 1200,
  sessionId,
  onSubmit,
  onCancel,
  onCancelGeneration,
  busy = false,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  // 뷰박스(transform 미적용) — 커서 앵커 줌의 기준 컨테이너.
  const viewBoxRef = useRef<HTMLDivElement>(null);
  // 캔버스 컨테이너의 사용 가능한 폭·높이를 mount 시 측정.
  // toolbar / prompt 의 실제 height 를 ref 로 직접 측정해서 캔버스 최대 height 정확히 결정.
  // strokes 좌표 정합성을 위해 1회만 측정 (사용자가 그리는 도중 창 리사이즈는 edge case).
  const sizerRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  // 뷰박스 아래 모든 콘텐츠(toolbar+prompt+참조+리사이즈)를 한 번에 측정 — reserved 정확도 보장.
  const belowRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  const [tool, setTool] = useState<Tool>("brush");
  const [brushSize, setBrushSize] = useState(40);
  const [resizeOpen, setResizeOpen] = useState(false);
  // 실행에 통합 적용될 옵션: 리사이즈 타깃(정사각 px, null=원본 유지) + 배경 제거 토글.
  const [resizeTarget, setResizeTarget] = useState<number | null>(null);
  const [removeBg, setRemoveBg] = useState(false);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [prompt, setPrompt] = useState("");
  // 참조 이미지 — 선택 시 인페인트 attachment 에 함께 전달.
  const [refScope, setRefScope] = useState<"session" | "gallery">("session");
  const [sessionRefs, setSessionRefs] = useState<Generation[] | null>(null);
  const [galleryRefs, setGalleryRefs] = useState<Generation[] | null>(null);
  const [refId, setRefId] = useState<string | null>(null);
  const drawingRef = useRef<Stroke | null>(null);
  // 리사이즈 시 stroke 좌표 정합성을 위해 스트로크가 시작된 후엔 avail 을 고정.
  // useLayoutEffect 의 클로저에서 최신 strokes.length 에 접근하기 위해 ref 사용.
  const strokesLenRef = useRef(0);
  useEffect(() => { strokesLenRef.current = strokes.length; }, [strokes]);

  // 세션 참조 이미지 목록 — 최초 1회 로드 (sessionId 없으면 전체 갤러리에서)
  useEffect(() => {
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens => setSessionRefs(gens.filter(g => g.id !== parentGenerationId && g.kind !== "mask")))
      .catch(() => setSessionRefs([]));
  }, [sessionId, parentGenerationId]);

  // 갤러리 참조 이미지 목록 — "gallery" 탭 전환 시 1회 로드
  useEffect(() => {
    if (refScope !== "gallery" || galleryRefs !== null) return;
    listGenerations({ limit: 120 })
      .then(gens => setGalleryRefs(gens.filter(g => g.id !== parentGenerationId && g.kind !== "mask")))
      .catch(() => setGalleryRefs([]));
  }, [refScope, galleryRefs, parentGenerationId]);

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;

    const measure = () => {
      // 스트로크가 하나라도 있으면 캔버스 크기를 고정 — 리사이즈로 인한 좌표 mismatch 방지.
      if (strokesLenRef.current > 0 || drawingRef.current) return;
      // 폭: 패딩 고려 24px 빼기. (p-3 좌우 합)
      const w = Math.max(200, sizer.clientWidth - 24);
      // 높이: LayerCanvas 와 동일한 640px 기준 공식 (16:10 제약 제거).
      // 폭(w)이 아닌 640px 을 기준으로 비율 계산 → 높이 일치.
      const h = imageWidth >= imageHeight
        ? Math.round((640 * imageHeight) / imageWidth)
        : 640;
      setAvail(prev => (prev?.w === w && prev?.h === h ? prev : { w, h }));
    };

    measure();
    // ResizeObserver 로 오버레이 오픈 직후 layout settle + 이후 창 리사이즈 대응.
    const ro = new ResizeObserver(measure);
    ro.observe(sizer);
    return () => ro.disconnect();
  }, []);

  // 휠 줌: 뷰박스 위에서 스크롤로 커서 위치 기준 줌인/줌아웃. non-passive 리스너를 직접 등록.
  const zp = useZoomPan();
  useEffect(() => {
    const el = viewBoxRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      zp.zoomAtPoint(el, e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zp.zoomAtPoint]);
  // fitBox 의 16:10 비율 제한 없이 직접 계산 — LayerCanvas 와 높이 일치.
  const viewW = avail?.w ?? maxDisplayPx;
  const viewH = avail?.h ?? Math.round((640 * imageHeight) / imageWidth);
  const fitScale = Math.min(viewW / imageWidth, viewH / imageHeight);
  const displayW = Math.max(1, Math.round(imageWidth * fitScale));
  const displayH = Math.max(1, Math.round(imageHeight * fitScale));
  const scale = fitScale;

  // 1-a. 원본 이미지 load — imageUrl 변경 시만. (displayW/H 변경에 따른 redraw 와 분리해
  //       race 회피: 이전엔 displayW 가 useLayoutEffect 의 setAvail 로 바뀔 때마다 새 Image
  //       를 생성해서 첫 img.onload 가 두 번째 캔버스 size 변경 이후 발화 → blank 캔버스.)
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => {
    // 의도적: 새 imageUrl 로 교체될 때 이전 loaded=true 상태가 새 onload 전까지 visible 하면
    // 두 번째 redraw effect 가 stale img 로 발화 → race. 의도적 reset 이므로 lint disable.
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

  // 1-b. 캔버스 크기 또는 이미지 load 변경 시 redraw.
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

  // rect-ratio 매핑: getBoundingClientRect 가 zoom/pan transform 을 반영하므로 비율 역산으로
  // 어떤 줌·팬에서도 정확한 display-px 좌표를 얻는다. (export 의 1/scale 역산은 그대로.)
  const pointerPos = rectRatioPoint;

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
  // 인페인트는 마스크+프롬프트가 둘 다 있어야 적용. 리사이즈/배경제거는 단독으로도 실행 가능.
  const canInpaint = hasStrokes && prompt.trim().length > 0;
  const canRun = canInpaint || resizeTarget !== null || removeBg;

  function submit() {
    if (!canRun || busy) return;
    onSubmit({
      maskDataUrl: canInpaint ? exportMaskDataUrl() : null,
      prompt: canInpaint ? prompt.trim() : "",
      resizeTarget,
      removeBg,
      referenceGenerationId: refId,
    });
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Edit3 size={14} /> 인페인트
        </span>
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

      <div ref={sizerRef} className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-3 overflow-y-auto p-3">
        <p className="text-xs text-text-muted">다시 그릴 영역을 brush 로 칠하세요.</p>

        {/* 16:10 뷰박스 — 이미지를 contain-fit + 줌/팬. overflow-hidden 으로 줌 넘침 클립. */}
        <div
          ref={viewBoxRef}
          className="relative mx-auto shrink-0 select-none overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/14px_14px]"
          style={{ width: viewW, height: viewH }}
        >
          {/* 캔버스 스택 — 뷰박스 중앙에 두고 translate+scale 로 줌/팬. */}
          <div
            className="absolute"
            style={{
              width: displayW,
              height: displayH,
              left: "50%",
              top: "50%",
              transform: `translate(-50%, -50%) translate(${zp.pan.x}px, ${zp.pan.y}px) scale(${zp.zoom})`,
              transformOrigin: "center",
            }}
          >
            <canvas
              ref={baseRef}
              className="pointer-events-none absolute inset-0"
              width={displayW}
              height={displayH}
            />
            <canvas
              ref={maskRef}
              className={`absolute inset-0 touch-none ${zp.panMode ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
              width={displayW}
              height={displayH}
              onPointerDown={e => {
                // 이동 모드면 팬으로 소비하고 그리기 스킵.
                if (zp.panMode) {
                  zp.onPanPointerDown(e);
                  return;
                }
                // setPointerCapture 는 inactive pointer (합성 PointerEvent / 일부 brower edge case) 에서
                // NotFoundError throw. capture 실패해도 stroke 자체는 진행하도록 silent skip.
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {}
                const { x, y } = pointerPos(e);
                startStroke(x, y);
              }}
              onPointerMove={e => {
                if (zp.panMode) {
                  zp.onPanPointerMove(e);
                  return;
                }
                if (drawingRef.current == null) return;
                const { x, y } = pointerPos(e);
                continueStroke(x, y);
              }}
              onPointerUp={e => {
                if (zp.panMode) {
                  zp.onPanPointerUp(e);
                  return;
                }
                endStroke();
              }}
              onPointerCancel={e => {
                if (zp.panMode) {
                  zp.onPanPointerUp(e);
                  return;
                }
                endStroke();
              }}
            />
          </div>
          {/* 실행 중 오버레이 — 멈춘 게 아니라 생성 중임을 명확히 표시. transform 밖(뷰박스 기준). */}
          {busy && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/55 text-white">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-xs">생성 중…</span>
            </div>
          )}
          {/* 줌/팬 컨트롤 — 뷰박스 우하단, transform 밖이라 줌에 안 딸려감. */}
          <ZoomPanControls zp={zp} />
        </div>

        {/* 뷰박스 아래 콘텐츠 전체 — belowRef 로 한 번에 높이 측정 */}
        <div ref={belowRef} className="flex flex-col gap-3">

        {/* 도구 toolbar */}
        <div
          ref={toolbarRef}
          className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs"
        >
          <div className="flex gap-1 rounded-lg border border-border bg-bg-panel p-1">
            <button
              onClick={() => setTool("brush")}
              className={`flex h-8 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                tool === "brush"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              <Brush size={12} /> 브러시
            </button>
            <button
              onClick={() => setTool("eraser")}
              className={`flex h-8 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                tool === "eraser"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
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
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border bg-bg-app px-2 text-text-primary hover:border-[color:var(--accent)]/60 hover:bg-[color:var(--accent)]/10 disabled:cursor-not-allowed disabled:opacity-30"
              title="마지막 stroke 취소"
            >
              <RotateCcw size={12} /> 실행취소
            </button>
            <button
              onClick={() => {
                if (!hasStrokes || busy) return;
                onSubmit({
                  maskDataUrl: exportMaskDataUrl(),
                  prompt: "seamless background matching the surrounding area — same colors, textures, and lighting, as if the object was never there",
                  resizeTarget: null,
                  removeBg: false,
                  referenceGenerationId: null,
                });
              }}
              disabled={!hasStrokes || busy}
              className="flex h-7 flex-1 items-center justify-center gap-1 rounded border border-border bg-bg-app px-2 text-text-primary hover:border-[color:var(--danger)]/60 hover:bg-[color:var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-30"
              title="마스크 영역을 지우고 배경으로 채워 재생성"
            >
              <Trash2 size={12} /> 지우기
            </button>
          </div>
        </div>

        {/* prompt */}
        <div ref={promptRef} className="shrink-0 space-y-1">
          <label className="text-xs text-text-muted">무엇으로 바꿀까요? (마스크를 칠하면 인페인트)</label>
          <textarea
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            placeholder="예: 더 큰 검, 보라색 마법 크리스탈, 황금 코인…"
            rows={3}
            // textarea 가 flex-col 안에서 squeeze 되어 height 가 1줄로 줄어드는 것 방지.
            className="block min-h-[78px] w-full shrink-0 resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
          />
        </div>

        {/* 참조 이미지 — 선택사항 */}
        <div className="shrink-0 space-y-1">
          <div className="flex items-center justify-between">
            <label className="text-xs text-text-muted">참조 이미지 (선택)</label>
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
          {(refScope === "session" ? sessionRefs : galleryRefs) === null ? (
            <p className="text-[11px] text-text-muted/60">불러오는 중…</p>
          ) : (refScope === "session" ? sessionRefs! : galleryRefs!).length === 0 ? (
            <p className="text-[11px] text-text-muted/60">이미지 없음</p>
          ) : (
            <div className="grid grid-cols-5 gap-1">
              {(refScope === "session" ? sessionRefs! : galleryRefs!).map(g => {
                const sel = refId === g.id;
                return (
                  <button
                    key={g.id}
                    onClick={() => setRefId(sel ? null : g.id)}
                    className={`relative aspect-square overflow-hidden rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px] ${
                      sel
                        ? "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]"
                        : "border-border hover:border-[color:var(--accent)]/50"
                    }`}
                    title={g.prompt ?? g.id}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/api/images/${g.id}`} alt="" className="h-full w-full object-contain" />
                    {sel && (
                      <span className="absolute right-0.5 top-0.5 rounded-full bg-[color:var(--accent)] px-1 text-[9px] font-bold text-white">✓</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
          {refId && (
            <p className="text-[11px] text-[color:var(--accent)]/80">참조 이미지 선택됨 — 프롬프트와 함께 인페인트에 사용됩니다.</p>
          )}
        </div>

        {/* 실행 시 함께 적용 — 리사이즈(긴 변 기준) 선택 + 배경 제거 토글. 프롬프트 아래·실행 버튼 근처. */}
        <div className="flex shrink-0 flex-wrap items-center gap-2 text-xs">
          <span className="tabular-nums text-text-muted/70">
            현재 {imageWidth}×{imageHeight}
          </span>
          <div className="relative">
            <button
              onClick={() => setResizeOpen(o => !o)}
              disabled={busy}
              className="flex h-8 items-center gap-1 rounded-lg border border-border px-3 text-text-muted hover:text-text-primary disabled:opacity-40"
              title="실행 시 정사각형으로 리사이즈"
            >
              <Maximize2 size={12} /> 긴 변: {resizeTarget ? RESIZE_OPTIONS.find(o => o.px === resizeTarget)?.label : "원본"} <ChevronDown size={10} />
            </button>
            {resizeOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-1 flex min-w-[88px] flex-col gap-0.5 rounded-lg border border-border bg-bg-panel p-1 shadow-lg">
                <button
                  onClick={() => { setResizeTarget(null); setResizeOpen(false); }}
                  className="rounded px-2 py-1.5 text-left text-text-muted hover:bg-bg-card hover:text-text-primary"
                >
                  원본
                </button>
                {RESIZE_OPTIONS.map(o => (
                  <button
                    key={o.px}
                    onClick={() => { setResizeTarget(o.px); setResizeOpen(false); }}
                    className="rounded px-2 py-1.5 text-left text-text-muted hover:bg-bg-card hover:text-text-primary"
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => setRemoveBg(v => !v)}
            disabled={busy}
            className={`flex h-8 items-center gap-1 rounded-lg border px-3 disabled:opacity-40 ${
              removeBg
                ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                : "border-border text-text-muted hover:text-text-primary"
            }`}
            title="실행 시 배경 제거 적용"
          >
            <Scissors size={12} /> 배경 제거 {removeBg ? "ON" : "OFF"}
          </button>
        </div>

        </div>{/* /belowRef */}
      </div>

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
        {/* 실행 중에는 생성 취소(abort), 평소에는 패널 닫기. */}
        <button
          onClick={busy ? (onCancelGeneration ?? onCancel) : onCancel}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:border-[color:var(--danger)]/60 hover:text-text-primary"
        >
          {busy ? "■ 생성 취소" : "✕ 취소"}
        </button>
        <button
          onClick={submit}
          disabled={!canRun || busy}
          className="flex h-9 flex-[2] items-center justify-center gap-2 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          title={!canRun ? "마스크+프롬프트, 리사이즈, 배경제거 중 하나는 설정해야 함" : ""}
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> 실행 중…
            </>
          ) : (
            "✓ 실행"
          )}
        </button>
      </footer>
    </aside>
  );
}
