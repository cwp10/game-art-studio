"use client";

import { ChevronDown, ChevronUp, Download, Eraser, Layers, Loader2, RotateCcw, Scissors, Sparkles, Trash2, X, Zap } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { suggestLayerParts } from "@/lib/api/client";
import { fitBox, rectRatioPoint, useZoomPan, ZoomPanControls } from "./useZoomPan";

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

type LayerResult = {
  generationId: string;
  colorLabel: string;
  name?: string;
  width: number;
  height: number;
};

type SubmitMode = "crop" | "inpaint";
type SubmitArgs = {
  mode: SubmitMode;
  /** crop: 원본 × binary mask 합성 PNG (alpha 보존).
   *  inpaint: codex 가 인식하는 binary mask PNG (red=복원할 영역, black=보존).
   *  name: 사용자가 입력한 부위명 (없으면 색 ko fallback). */
  layers: Array<{ colorLabel: ColorKey; name: string; dataUrl: string }>;
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
  // 색별 사용자 부위 라벨. 비어있으면 export 시 ko fallback.
  const [labels, setLabels] = useState<Record<ColorKey, string>>(
    () => Object.fromEntries(COLOR_KEYS.map(k => [k, ""])) as Record<ColorKey, string>,
  );
  // z-order: index 0 = 가장 앞(위) 레이어. 뒤로 갈수록 아래. inpaint 복원 마스크는
  // 각 색 L 보다 앞에 있는 색들만 "가린다" 고 보고 그 union ∖ self 를 복원 영역으로 삼는다.
  const [zOrder, setZOrder] = useState<ColorKey[]>([]);
  const [mode, setMode] = useState<SubmitMode>("crop");
  // crop 모드 전용 — 비투명 bbox 로 크롭해 분리 영역 크기로 저장. 켜면 원위치 정보를
  // 잃어 result phase 의 재합성 미리보기를 생략한다 (제출 시점 값 보존).
  const [trimToContent, setTrimToContent] = useState(false);
  const [trimmedResult, setTrimmedResult] = useState(false);
  const [phase, setPhase] = useState<"draw" | "result">("draw");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<LayerResult[]>([]);
  const drawingRef = useRef<Stroke | null>(null);
  const recompRef = useRef<HTMLCanvasElement>(null);
  // AI 부위 추천 — 라벨 이름 chip 제안 (생성 prompt 기반, 이미지 vision 아님).
  const [partsSuggesting, setPartsSuggesting] = useState(false);
  const [suggestedParts, setSuggestedParts] = useState<string[]>([]);

  const hasStrokes = strokes.length > 0;
  // 실제 brush stroke 가 있는 색만 — 라벨 입력·z-order 대상.
  const paintedColors = COLOR_KEYS.filter(k =>
    strokes.some(s => s.color === k && s.tool === "brush"),
  );

  // 유효 z-stack (위=앞 순서). zOrder 는 사용자가 reorder 로 명시한 순서 힌트일 뿐이며,
  // 실제 표시·마스크 순서는 paintedColors 를 zOrder 위치로 정렬해 파생한다 (sync 효과 불필요).
  // zOrder 에 없는 새로 칠한 색은 COLOR_KEYS 순서대로 맨 뒤(아래)에 붙는다.
  const orderedColors = [...paintedColors].sort((a, b) => {
    const ra = zOrder.indexOf(a);
    const rb = zOrder.indexOf(b);
    return (ra === -1 ? Number.MAX_SAFE_INTEGER : ra) - (rb === -1 ? Number.MAX_SAFE_INTEGER : rb);
  });

  // 결과 뷰용 z-order 정렬: orderedColors[0]=앞(위) 순서를 그대로 따른다 (없는 색은 뒤로).
  const zRank = (cl: string) => {
    const r = orderedColors.indexOf(cl as ColorKey);
    return r === -1 ? Number.MAX_SAFE_INTEGER : r;
  };
  const orderedResults = [...results].sort((a, b) => zRank(a.colorLabel) - zRank(b.colorLabel));

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const w = Math.max(200, sizer.clientWidth - 24);
    const tb = toolbarRef.current?.getBoundingClientRect().height ?? 160;
    const reserved = tb + 36 + 20 + 36;
    const h = Math.max(200, sizer.clientHeight - reserved);
    setAvail(prev => (prev?.w === w && prev?.h === h ? prev : { w, h }));
  }, []);

  // 16:10 뷰박스 + contain-fit. fitScale 은 export(buildColorMask) 의 scale 로 재사용.
  const zp = useZoomPan();
  useEffect(() => {
    const el = maskRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (e.deltaY < 0) zp.zoomIn();
      else zp.zoomOut();
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [zp.zoomIn, zp.zoomOut]);
  const { viewW, viewH, fitScale, displayW, displayH } = fitBox(
    avail?.w ?? maxDisplayPx,
    avail?.h ?? maxDisplayPx,
    imageWidth,
    imageHeight,
  );
  const scale = fitScale;

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

  // 3. 재합성 미리보기 — result phase 에서 모든 crop 레이어 PNG 를 순서대로 alpha 합성.
  //    각 레이어가 원본 위치를 보존하므로 단순 겹쳐 그리면 원본 복원 여부를 육안 확인 가능.
  useEffect(() => {
    if (phase !== "result" || results.length === 0 || trimmedResult) return;
    const c = recompRef.current;
    if (!c) return;
    c.width = imageWidth;
    c.height = imageHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, imageWidth, imageHeight);
    // 뒤(아래) 레이어부터 그려 앞(위) 레이어가 위에 오도록 — z-order 합성.
    const backToFront = [...orderedResults].reverse();
    let cancelled = false;
    (async () => {
      for (const r of backToFront) {
        const img = await loadImage(`/api/images/${r.generationId}`);
        if (cancelled || !img) continue;
        ctx.drawImage(img, 0, 0, imageWidth, imageHeight);
      }
    })();
    return () => {
      cancelled = true;
    };
    // orderedResults 는 results+zOrder 파생 — 둘만 의존성으로 두면 충분.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, results, zOrder, imageWidth, imageHeight, trimmedResult]);

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

  // rect-ratio 매핑: getBoundingClientRect 가 zoom/pan transform 을 반영 → 비율 역산으로
  // 어떤 줌·팬에서도 정확한 display-px 좌표. (export 의 1/scale 역산은 그대로.)
  const pointerPos = rectRatioPoint;

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

  // 색의 effective name — 사용자 라벨 trim, 없으면 ko fallback.
  function nameOf(colorKey: ColorKey): string {
    return labels[colorKey].trim() || COLORS[colorKey].ko;
  }

  // AI 부위 추천 — generation prompt 기반 라벨 chip 가져오기.
  async function fetchSuggestedParts() {
    if (partsSuggesting) return;
    setPartsSuggesting(true);
    try {
      setSuggestedParts(await suggestLayerParts(parentGenerationId));
    } finally {
      setPartsSuggesting(false);
    }
  }

  // chip 클릭 → 라벨 채울 대상 색 결정. 우선순위: 칠해진 + 선택된 색 → 칠해진 색 중 라벨 빈 첫 색.
  // 채울 대상이 없으면 무시.
  function applyPartLabel(text: string) {
    const target =
      paintedColors.includes(color) ? color : paintedColors.find(k => !labels[k].trim());
    if (!target) return;
    setLabels(prev => ({ ...prev, [target]: text }));
  }

  // crop 모드: 색별로 원본 × binary mask 합성 PNG (alpha 보존).
  function exportCropLayers(): Array<{ colorLabel: ColorKey; name: string; dataUrl: string }> {
    const img = imgRef.current;
    if (!img) return [];
    const out: Array<{ colorLabel: ColorKey; name: string; dataUrl: string }> = [];
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
      if (trimToContent) {
        const box = contentBBox(octx, imageWidth, imageHeight);
        if (!box) continue; // 비투명 픽셀 없음 — 스킵
        const cropC = document.createElement("canvas");
        cropC.width = box.w;
        cropC.height = box.h;
        const cctx = cropC.getContext("2d");
        if (!cctx) continue;
        cctx.drawImage(outC, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
        out.push({ colorLabel: colorKey, name: nameOf(colorKey), dataUrl: cropC.toDataURL("image/png") });
      } else {
        out.push({ colorLabel: colorKey, name: nameOf(colorKey), dataUrl: outC.toDataURL("image/png") });
      }
    }
    return out;
  }

  // inpaint 모드: 색별로 codex 가 인식하는 binary mask PNG (red=복원할 영역, black=보존).
  // 복원 영역 = "L 보다 앞(위)에 있는 레이어들이 칠한 곳" (= L 을 가리는 부위) ∖ self.
  // 뒤(아래) 레이어는 L 을 가리지 않으므로 제외. 맨 앞 레이어는 가리는 것이 없어 inpaint 스킵.
  // 안 칠한 영역은 검정 (보존) — 원본 그대로. 부분 복원 가능.
  function exportInpaintMasks(): Array<{ colorLabel: ColorKey; name: string; dataUrl: string }> {
    const out: Array<{ colorLabel: ColorKey; name: string; dataUrl: string }> = [];
    for (const colorKey of orderedColors) {
      const selfMask = buildColorMask(colorKey);
      if (!selfMask) continue;
      // others = union of colors that are in front of (above) colorKey in z-stack.
      const idx = orderedColors.indexOf(colorKey);
      const frontColors = orderedColors.slice(0, idx);
      const othersC = document.createElement("canvas");
      othersC.width = imageWidth;
      othersC.height = imageHeight;
      const octx = othersC.getContext("2d");
      if (!octx) continue;
      for (const front of frontColors) {
        const m = buildColorMask(front);
        if (m) octx.drawImage(m, 0, 0);
      }
      if (!hasAnyPixel(octx, imageWidth, imageHeight)) continue; // 앞 레이어가 없으면 inpaint 불필요
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
      out.push({ colorLabel: colorKey, name: nameOf(colorKey), dataUrl: finalC.toDataURL("image/png") });
    }
    return out;
  }

  // z-stack 표시 인덱스 i 의 색을 dir(-1 앞/위, +1 뒤/아래)로 한 칸 이동.
  function moveLayer(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= orderedColors.length) return;
    const next = [...orderedColors];
    [next[i], next[j]] = [next[j], next[i]];
    setZOrder(next);
  }

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
        setTrimmedResult(trimToContent); // 제출 시점 값 보존 — result 렌더가 참조.
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
    const base = (r.name ?? COLORS[r.colorLabel as ColorKey]?.ko ?? r.colorLabel)
      .trim()
      .replace(/[\\/:*?"<>|\s]+/g, "_");
    a.download = `${base || r.colorLabel}.png`;
    a.click();
  }

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Layers size={14} /> 레이어 분리
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
        {phase === "draw" ? (
          <>
            <p className="text-xs text-text-muted">
              부위별로 색을 바꿔가며 칠하세요. 색마다 별도 PNG 가 생성됩니다.
            </p>

            {/* 16:10 뷰박스 — contain-fit + 줌/팬. overflow-hidden 으로 줌 넘침 클립. */}
            <div
              className="relative mx-auto shrink-0 select-none overflow-hidden rounded-lg border border-border bg-bg-app"
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
                  className="pointer-events-none absolute inset-0 bg-bg-card"
                  width={displayW}
                  height={displayH}
                />
                <canvas
                  ref={maskRef}
                  className={`absolute inset-0 touch-none ${zp.panMode ? "cursor-grab active:cursor-grabbing" : "cursor-crosshair"}`}
                  width={displayW}
                  height={displayH}
                  onPointerDown={e => {
                    if (zp.panMode) {
                      zp.onPanPointerDown(e);
                      return;
                    }
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
              {/* 줌/팬 컨트롤 — 뷰박스 우하단, transform 밖이라 줌에 안 딸려감. */}
              <ZoomPanControls zp={zp} />
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
              {/* 칠해진 색에만 부위명 입력 + z-order — inpaint 복원·crop 결과 라벨에 반영.
                  행 순서 = z-stack (위=앞). 위에 있을수록 앞 레이어. */}
              {orderedColors.length > 0 && (
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={fetchSuggestedParts}
                      disabled={partsSuggesting}
                      className="flex h-6 items-center gap-1 rounded border border-border bg-bg-app px-2 text-[11px] text-text-muted hover:border-[color:var(--accent)]/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      title="생성 프롬프트 기반 부위명 추천"
                    >
                      {partsSuggesting ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Sparkles size={12} />
                      )}
                      부위 추천
                    </button>
                    {suggestedParts.length > 0 && (
                      <div className="flex flex-1 flex-wrap gap-1">
                        {suggestedParts.map((p, i) => (
                          <button
                            key={`${p}-${i}`}
                            onClick={() => applyPartLabel(p)}
                            className="rounded-full border border-border bg-bg-app px-2 py-0.5 text-[10px] text-text-muted hover:border-[color:var(--accent)]/60 hover:text-text-primary"
                            title="선택한 색 라벨에 채우기"
                          >
                            {p}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <p className="text-[10px] leading-tight text-text-muted/70">
                    위에 있을수록 앞 레이어 — 뒤 레이어의 가려진 부분을 복원합니다.
                  </p>
                  {orderedColors.map((k, i) => (
                    <div key={k} className="flex items-center gap-1.5">
                      <span
                        className="inline-block size-3 shrink-0 rounded-full"
                        style={{ background: COLORS[k].hex }}
                      />
                      <input
                        type="text"
                        value={labels[k]}
                        onChange={e => setLabels(prev => ({ ...prev, [k]: e.target.value }))}
                        placeholder={`${COLORS[k].ko} 부위명 (예: 머리띠)`}
                        className="h-6 flex-1 rounded border border-border bg-bg-app px-2 text-[11px] text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none"
                      />
                      <button
                        onClick={() => moveLayer(i, -1)}
                        disabled={i === 0}
                        className="rounded border border-border p-0.5 text-text-muted hover:border-[color:var(--accent)]/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-25"
                        title="앞으로 (위)"
                      >
                        <ChevronUp size={12} />
                      </button>
                      <button
                        onClick={() => moveLayer(i, 1)}
                        disabled={i === orderedColors.length - 1}
                        className="rounded border border-border p-0.5 text-text-muted hover:border-[color:var(--accent)]/60 hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-25"
                        title="뒤로 (아래)"
                      >
                        <ChevronDown size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
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
              <div className="space-y-2 border-t border-border pt-2">
                <div className="flex items-start gap-2 text-text-muted">
                  <button
                    onClick={() => setMode(mode === "inpaint" ? "crop" : "inpaint")}
                    className={`flex h-7 shrink-0 items-center gap-1 rounded-lg border px-3 ${
                      mode === "inpaint"
                        ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                        : "border-border text-text-muted hover:text-text-primary"
                    }`}
                  >
                    <Zap size={12} /> AI 복원 {mode === "inpaint" ? "ON" : "OFF"}
                  </button>
                  <span className="flex-1 leading-tight">
                    가려진 영역을 codex 가 자연스럽게 복원 (색별 1회씩 호출, 시간 N배·구독 한도 차감).
                  </span>
                </div>
                <div className="flex items-start gap-2 text-text-muted">
                  <button
                    onClick={() => setTrimToContent(v => !v)}
                    disabled={mode !== "crop"}
                    className={`flex h-7 shrink-0 items-center gap-1 rounded-lg border px-3 disabled:cursor-not-allowed disabled:opacity-40 ${
                      mode === "crop" && trimToContent
                        ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                        : "border-border text-text-muted hover:text-text-primary"
                    }`}
                    title={mode !== "crop" ? "crop(레이어 분리) 모드 전용" : ""}
                  >
                    <Scissors size={12} /> 여백 잘라내기 {mode === "crop" && trimToContent ? "ON" : "OFF"}
                  </button>
                  <span className="flex-1 leading-tight">
                    분리 영역 크기로 저장.{mode !== "crop" && " (crop 모드 전용)"}
                  </span>
                </div>
              </div>
              {error && <p className="text-[11px] text-[color:var(--danger)]">{error}</p>}
            </div>
          </>
        ) : (
          <>
            <p className="text-xs text-text-muted">
              {results.length}개 레이어가 생성되었습니다. 각 레이어는 결과 카드처럼 세션에도 저장돼요.
            </p>

            {/* 재합성 미리보기 — 모든 레이어를 겹쳐 원본 복원 여부 확인.
                여백을 잘라내 저장한 경우 원위치 정보가 없어 미리보기를 생략한다. */}
            {trimmedResult ? (
              <p className="shrink-0 rounded-lg border border-border bg-bg-card p-2 text-[11px] leading-tight text-text-muted">
                여백을 잘라내 저장해 재합성 미리보기는 생략됩니다.
              </p>
            ) : (
              <div className="shrink-0">
                <p className="mb-1 text-[11px] font-medium text-text-muted">재합성 미리보기</p>
                <canvas
                  ref={recompRef}
                  className="mx-auto block w-full max-w-[280px] rounded-lg border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/16px_16px]"
                  style={{ aspectRatio: `${imageWidth} / ${imageHeight}` }}
                />
              </div>
            )}

            {/* exploded 레이어 스택 — 각 레이어를 이름과 함께 세로로 분리 표시. */}
            <div className="space-y-2">
              <p className="text-[11px] font-medium text-text-muted">레이어 ({results.length}) · 위=앞</p>
              {orderedResults.map((r, i) => {
                const c = COLORS[r.colorLabel as ColorKey];
                const name = r.name?.trim() || c?.ko || r.colorLabel;
                return (
                  <div
                    key={r.generationId}
                    className="flex items-center gap-2 rounded-lg border border-border bg-bg-card p-2"
                    style={{ marginLeft: i * 8 }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/images/${r.generationId}`}
                      alt={name}
                      className="size-14 shrink-0 rounded bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px] object-contain"
                    />
                    <span
                      className="inline-block size-3 shrink-0 rounded-full"
                      style={{ background: c?.hex ?? "#888" }}
                    />
                    <span className="flex-1 truncate text-xs text-text-primary" title={name}>
                      {name}
                    </span>
                    <button
                      onClick={() => downloadResult(r)}
                      className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                      title="PNG 다운로드"
                    >
                      <Download size={12} />
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
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

/** src 를 로드해 HTMLImageElement 반환 (실패 시 null). 재합성 미리보기용. */
function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** mask 캔버스에 alpha > 0 픽셀이 하나라도 있는지. (전체 스캔 — 4MP 캔버스에 ~수십 ms) */
function hasAnyPixel(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true;
  }
  return false;
}

/** alpha > 0 픽셀의 bounding box (x/y/w/h). 비투명 픽셀이 없으면 null. */
function contentBBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number } | null {
  const data = ctx.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
