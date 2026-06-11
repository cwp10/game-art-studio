"use client";

import { Loader2, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type FilterArg = { id: string; prompt: string; param?: number };

// 순서: 서버 적용 순서와 동일
export const POST_FILTER_DEFS = [
  { id: "median",    label: "노이즈제거", prompt: "", sharp: true  }, // 토글 (맨앞)
  { id: "invert",    label: "반전",      prompt: "", sharp: true  }, // 토글
  { id: "flop",      label: "좌우반전",  prompt: "", sharp: true  }, // 토글
  { id: "flip",      label: "상하반전",  prompt: "", sharp: true  }, // 토글
  { id: "rotate",    label: "회전",      prompt: "", sharp: true  }, // 슬라이더
  { id: "pixelate",  label: "픽셀화",    prompt: "", sharp: true  }, // 슬라이더
  { id: "sharpen",   label: "샤프닝",    prompt: "", sharp: true  }, // 슬라이더
  { id: "blur",      label: "블러",      prompt: "", sharp: true  }, // 슬라이더
  { id: "gamma",     label: "감마",      prompt: "", sharp: true  }, // 슬라이더
  { id: "grayscale", label: "흑백",      prompt: "", sharp: true  }, // 슬라이더 (맨뒤)
  { id: "trim",      label: "여백제거",  prompt: "", sharp: true  }, // 푸터
  { id: "removeBg",  label: "배경제거",  prompt: "이 이미지의 배경을 투명하게 제거해줘.", sharp: false }, // 푸터
] as const;

// 슬라이더 필터: neutral 값이면 적용 안 함
const PARAM_SLIDERS: Record<string, { min: number; max: number; step: number; unit: string; neutral: number; defaultVal: number }> = {
  rotate:   { min: 0,   max: 360, step: 1,   unit: "°",  neutral: 0,   defaultVal: 0   },
  pixelate: { min: 1,   max: 32,  step: 1,   unit: "px", neutral: 1,   defaultVal: 1   },
  sharpen:  { min: 0,   max: 5,   step: 0.5, unit: "",   neutral: 0,   defaultVal: 0   },
  blur:     { min: 0,   max: 20,  step: 0.5, unit: "px", neutral: 0,   defaultVal: 0   },
  gamma:    { min: 0.5, max: 3,   step: 0.1, unit: "",   neutral: 1.0, defaultVal: 1.0 },
  grayscale:{ min: 0,   max: 100, step: 5,   unit: "%",  neutral: 0,   defaultVal: 0   },
};

type Props = {
  generationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  busy?: boolean;
  onCrop: (args: {
    srcX: number;
    srcY: number;
    srcW: number;
    srcH: number;
    targetW: number;
    targetH: number;
    opacity: number;
    filters: FilterArg[];
    aiScale: boolean;
  }) => Promise<void>;
  onCancel: () => void;
};

const CW = 560;
const CH = 380;
const PAD = 32;

function computeFrame(tW: number, tH: number) {
  const maxW = CW - PAD * 2;
  const maxH = CH - PAD * 2;
  const aspect = Math.max(tW, 1) / Math.max(tH, 1);
  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }
  return { x: (CW - w) / 2, y: (CH - h) / 2, w, h };
}

export function ImageToolsPanel({
  generationId,
  imageUrl,
  imageWidth,
  imageHeight,
  busy,
  onCrop,
  onCancel,
}: Props) {
  const [targetW, setTargetW] = useState(imageWidth);
  const [targetH, setTargetH] = useState(imageHeight);
  const [opacity, setOpacity] = useState(100);
  const initialOpacityRef = useRef(100);

  // 패널 열릴 때 원본 이미지의 실제 평균 알파값으로 초기화
  useEffect(() => {
    fetch(`/api/images/${generationId}/opacity`)
      .then(r => r.json())
      .then((d: { opacity: number }) => {
        initialOpacityRef.current = d.opacity;
        setOpacity(d.opacity);
      })
      .catch(() => {
        initialOpacityRef.current = 100;
        setOpacity(100);
      });
  }, [generationId]);
  const [selectedFilters, setSelectedFilters] = useState<Set<string>>(new Set());
  const [aiScale, setAiScale] = useState(false);
  const [isCropping, setIsCropping] = useState(false);

  const toggleFilter = useCallback((id: string) => {
    setSelectedFilters(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const selectedFiltersRef = useRef(selectedFilters);

  const [filterParams, setFilterParams] = useState<Record<string, number>>(() =>
    Object.fromEntries(Object.entries(PARAM_SLIDERS).map(([id, c]) => [id, c.neutral]))
  );
  const filterParamsRef = useRef(filterParams);
  const pixelCanvasRef = useRef<{ canvas: HTMLCanvasElement; pw: number; ph: number; img: HTMLImageElement } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef(computeFrame(imageWidth, imageHeight));
  const offsetRef = useRef({ x: 0, y: 0 });
  const scaleRef = useRef(1);
  const opacityRef = useRef(opacity);
  const draggingRef = useRef(false);
  const lastPosRef = useRef({ x: 0, y: 0 });
  const patternRef = useRef<CanvasPattern | null>(null);

  const frame = useMemo(() => computeFrame(targetW, targetH), [targetW, targetH]);

  // Stable draw — reads only from refs + stable props
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const fr = frameRef.current;
    const { x: ox, y: oy } = offsetRef.current;
    const s = scaleRef.current;

    // Checkerboard pattern (lazy-init per canvas context)
    if (!patternRef.current) {
      const pc = document.createElement("canvas");
      pc.width = 14;
      pc.height = 14;
      const pCtx = pc.getContext("2d")!;
      pCtx.fillStyle = "#1a1a1a";
      pCtx.fillRect(0, 0, 14, 14);
      pCtx.fillStyle = "#3a3a3a";
      pCtx.fillRect(0, 0, 7, 7);
      pCtx.fillRect(7, 7, 7, 7);
      patternRef.current = ctx.createPattern(pc, "repeat");
    }

    ctx.clearRect(0, 0, CW, CH);

    // Background
    ctx.fillStyle = "#111";
    ctx.fillRect(0, 0, CW, CH);

    // 프레임 내부 체커보드 (이미지 투명 영역 / 빈 letterbox 표시)
    if (patternRef.current) {
      ctx.fillStyle = patternRef.current;
      ctx.fillRect(fr.x, fr.y, fr.w, fr.h);
    }

    // Image — CSS 필터 + transform + 투명도 실시간 미리보기
    if (img) {
      ctx.save();
      const sel = selectedFiltersRef.current;
      const p = filterParamsRef.current;
      const dw = imageWidth * s;
      const dh = imageHeight * s;

      // CSS 필터 조합 (슬라이더는 neutral 이 아닐 때만)
      const cssF: string[] = [];
      if (sel.has("invert")) cssF.push("invert(1)");
      if (sel.has("median")) cssF.push("blur(0.5px)"); // Canvas API에 median 없음 — 근사 미리보기
      if ((p.grayscale ?? 0) > 0)             cssF.push(`grayscale(${p.grayscale}%)`);
      if ((p.blur ?? 0) > 0)                  cssF.push(`blur(${p.blur}px)`);
      if ((p.sharpen ?? 0) > 0)               cssF.push(`contrast(${1 + (p.sharpen ?? 0) * 0.2}) saturate(1.1)`);
      if (Math.abs((p.gamma ?? 1) - 1) > 0.05) cssF.push(`brightness(${p.gamma})`);
      if (cssF.length) ctx.filter = cssF.join(" ");
      ctx.globalAlpha = opacityRef.current / 100;

      // 픽셀화 소스 생성 (neutral=1 이면 skip) — 오프스크린 캔버스 재사용
      let src: HTMLCanvasElement | HTMLImageElement = img;
      const pixelBlock = Math.round(p.pixelate ?? 1);
      if (pixelBlock > 1) {
        const pw = Math.max(1, Math.round(dw / pixelBlock));
        const ph = Math.max(1, Math.round(dh / pixelBlock));
        const cached = pixelCanvasRef.current;
        if (!cached || cached.pw !== pw || cached.ph !== ph || cached.img !== img) {
          const pc = document.createElement("canvas");
          pc.width = pw; pc.height = ph;
          pc.getContext("2d")!.drawImage(img, 0, 0, pw, ph);
          pixelCanvasRef.current = { canvas: pc, pw, ph, img };
        }
        src = pixelCanvasRef.current!.canvas;
      }

      // 중심 기준 transform
      ctx.translate(ox + dw / 2, oy + dh / 2);
      if (sel.has("flop")) ctx.scale(-1, 1);
      if (sel.has("flip")) ctx.scale(1, -1);
      const angle = p.rotate ?? 0;
      if (angle !== 0) ctx.rotate((angle * Math.PI) / 180);

      if (sel.has("pixelate")) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
        ctx.imageSmoothingEnabled = true;
      } else {
        ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
      }

      ctx.globalAlpha = 1;
      ctx.filter = "none";
      ctx.restore();
    }

    // Dark overlay outside frame (4 rects)
    ctx.fillStyle = "rgba(0,0,0,0.62)";
    ctx.fillRect(0, 0, CW, fr.y);
    ctx.fillRect(0, fr.y + fr.h, CW, CH - fr.y - fr.h);
    ctx.fillRect(0, fr.y, fr.x, fr.h);
    ctx.fillRect(fr.x + fr.w, fr.y, CW - fr.x - fr.w, fr.h);

    // Rule-of-thirds grid
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(fr.x + (fr.w * i) / 3, fr.y);
      ctx.lineTo(fr.x + (fr.w * i) / 3, fr.y + fr.h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(fr.x, fr.y + (fr.h * i) / 3);
      ctx.lineTo(fr.x + fr.w, fr.y + (fr.h * i) / 3);
      ctx.stroke();
    }

    // Frame border
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(fr.x, fr.y, fr.w, fr.h);

    // Corner handles
    const hs = 8;
    ctx.fillStyle = "#fff";
    for (const [cx, cy] of [
      [fr.x, fr.y],
      [fr.x + fr.w, fr.y],
      [fr.x, fr.y + fr.h],
      [fr.x + fr.w, fr.y + fr.h],
    ] as [number, number][]) {
      ctx.fillRect(cx - hs / 2, cy - hs / 2, hs, hs);
    }

    // Size label inside frame
    const label = `${Math.round(targetW)} × ${Math.round(targetH)}`;
    ctx.font = "11px monospace";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.fillText(label, fr.x + 6, fr.y + 14);
  }, [imageWidth, imageHeight, targetW, targetH]);

  // Init transform: 캔버스 위치/스케일 + 투명도 + 필터 슬라이더 초기화
  const initTransform = useCallback(() => {
    setOpacity(initialOpacityRef.current);
    setSelectedFilters(new Set());
    setFilterParams(Object.fromEntries(Object.entries(PARAM_SLIDERS).map(([id, c]) => [id, c.neutral])));
    frameRef.current = frame;
    const s = Math.min(frame.w / imageWidth, frame.h / imageHeight);
    scaleRef.current = s;
    offsetRef.current = {
      x: frame.x + (frame.w - imageWidth * s) / 2,
      y: frame.y + (frame.h - imageHeight * s) / 2,
    };
    draw();
  }, [frame, imageWidth, imageHeight, draw]);

  // Re-init when frame changes (targetW/targetH)
  useEffect(() => {
    initTransform();
  }, [initTransform]);

  // opacity / selectedFilters 변경 시 ref 업데이트 + 즉시 재렌더
  useEffect(() => { opacityRef.current = opacity; draw(); }, [opacity, draw]);
  useEffect(() => { selectedFiltersRef.current = selectedFilters; draw(); }, [selectedFilters, draw]);
  useEffect(() => { filterParamsRef.current = filterParams; draw(); }, [filterParams, draw]);

  // Load image once
  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imgRef.current = img;
      draw();
    };
    img.src = imageUrl;
  }, [imageUrl, draw]);

  // Map client coords → canvas internal coords
  const toCanvas = useCallback((clientX: number, clientY: number) => {
    const r = canvasRef.current?.getBoundingClientRect();
    if (!r) return { x: clientX, y: clientY };
    return {
      x: ((clientX - r.left) * CW) / r.width,
      y: ((clientY - r.top) * CH) / r.height,
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    draggingRef.current = true;
    lastPosRef.current = toCanvas(e.clientX, e.clientY);
    e.preventDefault();
  }, [toCanvas]);

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!draggingRef.current) return;
    const pos = toCanvas(e.clientX, e.clientY);
    const dx = pos.x - lastPosRef.current.x;
    const dy = pos.y - lastPosRef.current.y;
    lastPosRef.current = pos;
    offsetRef.current = { x: offsetRef.current.x + dx, y: offsetRef.current.y + dy };
    draw();
  }, [toCanvas, draw]);

  const onMouseUp = useCallback(() => { draggingRef.current = false; }, []);

  // Wheel zoom (native event for passive:false)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const cx = ((e.clientX - r.left) * CW) / r.width;
      const cy = ((e.clientY - r.top) * CH) / r.height;
      const factor = e.deltaY < 0 ? 1.1 : 0.9;
      const oldS = scaleRef.current;
      const newS = Math.max(0.02, Math.min(100, oldS * factor));
      const ratio = newS / oldS;
      offsetRef.current = {
        x: cx - (cx - offsetRef.current.x) * ratio,
        y: cy - (cy - offsetRef.current.y) * ratio,
      };
      scaleRef.current = newS;
      draw();
    };
    canvas.addEventListener("wheel", handler, { passive: false });
    return () => canvas.removeEventListener("wheel", handler);
  }, [draw]);

  const handleSubmit = useCallback(async () => {
    if (isCropping || busy) return;
    const fr = frameRef.current;
    const s = scaleRef.current;
    const { x: ox, y: oy } = offsetRef.current;
    // 프레임이 이미지 경계를 벗어나는 경우(축소 등) 이미지 범위로 clamp
    const rawX = (fr.x - ox) / s;
    const rawY = (fr.y - oy) / s;
    const rawW = fr.w / s;
    const rawH = fr.h / s;
    const x1 = Math.max(0, rawX);
    const y1 = Math.max(0, rawY);
    const x2 = Math.min(imageWidth, rawX + rawW);
    const y2 = Math.min(imageHeight, rawY + rawH);
    const srcX = x1;
    const srcY = y1;
    const srcW = Math.max(1, x2 - x1);
    const srcH = Math.max(1, y2 - y1);
    setIsCropping(true);
    try {
      const filters: FilterArg[] = POST_FILTER_DEFS
        .filter(f => {
          if (selectedFilters.has(f.id)) return true;
          if (f.id in PARAM_SLIDERS) {
            const cfg = PARAM_SLIDERS[f.id];
            return Math.abs((filterParams[f.id] ?? cfg.neutral) - cfg.neutral) > 0.01;
          }
          return false;
        })
        .map(f => ({ id: f.id, prompt: f.prompt, param: filterParams[f.id] }));
      await onCrop({ srcX, srcY, srcW, srcH, targetW, targetH, opacity, filters, aiScale });
    } finally {
      setIsCropping(false);
    }
  }, [isCropping, busy, targetW, targetH, opacity, selectedFilters, filterParams, aiScale, onCrop]);

  const disabled = isCropping || !!busy;

  return (
    <aside className="flex h-full flex-col bg-bg-card text-sm text-text-primary shadow-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="font-medium">이미지 도구</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-text-muted">{generationId.slice(0, 8)}</span>
          <button
            onClick={onCancel}
            className="rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary"
          >
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {/* 너비 × 높이 + 초기화 */}
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-text-muted">
            너비
            <input
              type="number"
              min={1}
              value={targetW}
              onChange={e => setTargetW(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-border bg-bg-card px-2 py-1 text-xs text-text-primary"
            />
          </label>
          <span className="text-text-muted">×</span>
          <label className="flex items-center gap-1 text-xs text-text-muted">
            높이
            <input
              type="number"
              min={1}
              value={targetH}
              onChange={e => setTargetH(Math.max(1, Number(e.target.value)))}
              className="w-20 rounded border border-border bg-bg-card px-2 py-1 text-xs text-text-primary"
            />
          </label>
          <button
            onClick={initTransform}
            className="ml-auto flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-muted hover:bg-bg-panel hover:text-text-primary"
            title="이미지를 프레임 중앙으로 초기화"
          >
            <RefreshCw size={12} />
            초기화
          </button>
        </div>

        {/* Crop canvas */}
        <div className="overflow-hidden rounded-lg border border-border">
          <canvas
            ref={canvasRef}
            width={CW}
            height={CH}
            className="block w-full cursor-grab select-none active:cursor-grabbing"
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
        </div>

        {/* 드래그·휠 힌트 */}
        <p className="text-center text-xs text-text-muted/60">드래그로 이동 · 휠로 확대/축소</p>

        {/* 토글 버튼 (슬라이더 없는 필터) */}
        <div className="flex flex-wrap gap-1.5">
          {POST_FILTER_DEFS
            .filter(f => !(f.id in PARAM_SLIDERS) && f.id !== "trim" && f.id !== "removeBg")
            .map(f => (
              <button
                key={f.id}
                onClick={() => toggleFilter(f.id)}
                className={`rounded border px-2 py-1 text-xs transition-colors ${selectedFilters.has(f.id) ? "border-accent bg-accent text-white" : "border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"}`}
              >
                {f.label}
              </button>
            ))}
        </div>

        {/* 슬라이더 필터 (항상 표시) */}
        {POST_FILTER_DEFS
          .filter(f => f.id in PARAM_SLIDERS)
          .map(f => {
            const cfg = PARAM_SLIDERS[f.id];
            const val = filterParams[f.id] ?? cfg.neutral;
            const active = Math.abs(val - cfg.neutral) > 0.01;
            return (
              <div key={f.id} className="flex items-center gap-2">
                <span className={`w-14 shrink-0 text-xs ${active ? "text-accent font-medium" : "text-text-muted"}`}>
                  {f.label}
                </span>
                <input
                  type="range"
                  min={cfg.min}
                  max={cfg.max}
                  step={cfg.step}
                  value={val}
                  onChange={e => setFilterParams(prev => ({ ...prev, [f.id]: Number(e.target.value) }))}
                  className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-accent"
                />
                <span className={`w-12 text-right text-xs tabular-nums ${active ? "text-accent" : "text-text-muted"}`}>
                  {val}{cfg.unit}
                </span>
              </div>
            );
          })}

        {/* 투명도 슬라이더 */}
        <div className="flex items-center gap-3">
          <span className="w-12 shrink-0 text-xs text-text-muted">투명도</span>
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            onChange={e => setOpacity(Number(e.target.value))}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-accent"
          />
          <span className="w-9 text-right text-xs tabular-nums text-text-muted">{opacity}%</span>
        </div>
      </div>

      {/* Footer */}
      <div className="flex gap-2 border-t border-border p-3">
        <button
          onClick={() => toggleFilter("trim")}
          className={`rounded border px-3 py-2 text-sm transition-colors ${selectedFilters.has("trim") ? "border-accent bg-accent text-white" : "border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"}`}
        >
          여백제거
        </button>
        <button
          onClick={() => toggleFilter("removeBg")}
          className={`rounded border px-3 py-2 text-sm transition-colors ${selectedFilters.has("removeBg") ? "border-accent bg-accent text-white" : "border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"}`}
        >
          배경제거
        </button>
        <button
          onClick={() => setAiScale(v => !v)}
          title="업스케일 시 AI로 고품질 생성 (다운스케일은 sharp)"
          className={`rounded border px-3 py-2 text-sm transition-colors ${aiScale ? "border-accent bg-accent text-white" : "border-border text-text-muted hover:bg-bg-panel hover:text-text-primary"}`}
        >
          AI 스케일
        </button>
        <button
          disabled={disabled}
          onClick={handleSubmit}
          className="flex flex-1 items-center justify-center gap-2 rounded bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent/80 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isCropping ? <Loader2 size={14} className="animate-spin" /> : null}
          실행
        </button>
        <button
          onClick={onCancel}
          className="rounded border border-border px-4 py-2 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
        >
          닫기
        </button>
      </div>
    </aside>
  );
}
