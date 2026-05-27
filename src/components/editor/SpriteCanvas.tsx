"use client";

import { ArrowDown, ArrowRight, Download, Eraser, FileArchive, Pause, Play, RefreshCw, SkipBack, SkipForward, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

type Order = "row" | "col";

type Props = {
  parentGenerationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  maxDisplayPx?: number;
  onCancel: () => void;
};

export function SpriteCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  maxDisplayPx = 1200,
  onCancel,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  // 이미지 크기에서 GCD로 셀 크기를 역산해 rows/cols 자동 감지. 감지 실패 시 기본값 6×7.
  const detected = detectSpriteGrid(imageWidth, imageHeight);
  const [rows, setRows] = useState(detected?.rows ?? 6);
  const [cols, setCols] = useState(detected?.cols ?? 7);
  const [order, setOrder] = useState<Order>("row");
  const [fps, setFps] = useState(12);
  const [gifUrl, setGifUrl] = useState<string | null>(null);
  const [gifBusy, setGifBusy] = useState(false);
  const [gifError, setGifError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<null | "zip" | "gif">(null);
  const [playing, setPlaying] = useState(true);
  const [previewIdx, setPreviewIdx] = useState(0);
  const [offsets, setOffsets] = useState<{ x: number; y: number }[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  // 잔재 제거 두 관문: 크기(메인 대비 %)·여백(셀 짧은변 %). 클수록 강하게 제거.
  const [cleanSizePct, setCleanSizePct] = useState(10);
  const [cleanMarginPct, setCleanMarginPct] = useState(5);
  const [dragging, setDragging] = useState<{
    idx: number;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  // 드래그/선택(화살표 nudge) 중 리사이즈로 표시 크기가 재측정되면 진행 중인
  // 포인터 좌표 변환이 흔들린다. MaskCanvas 와 동일하게 조작 중엔 avail 을 고정.
  // useLayoutEffect 클로저에서 최신 상태에 접근하기 위해 ref 사용.
  const interactingRef = useRef(false);
  useEffect(() => {
    interactingRef.current = dragging !== null || selectedIdx !== null;
  }, [dragging, selectedIdx]);

  useLayoutEffect(() => {
    const sizer = sizerRef.current;
    if (!sizer) return;
    const measure = () => {
      // 셀 조작(드래그·선택 nudge) 중이면 좌표 mismatch 방지를 위해 재측정 건너뜀.
      if (interactingRef.current) return;
      const w = Math.max(200, sizer.clientWidth - 24);
      const h = Math.max(200, sizer.clientHeight - 320);
      setAvail({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(sizer);
    return () => ro.disconnect();
  }, []);

  // 가로폭 기준으로 등비 축소 — 가로로 긴 스프라이트시트에서 세로가 찌그러지지 않도록.
  const scale = avail
    ? Math.min(1, avail.w / imageWidth)
    : Math.min(1, maxDisplayPx / imageWidth);
  const displayW = Math.max(1, Math.round(imageWidth * scale));
  const displayH = Math.max(1, Math.round(imageHeight * scale));

  const imgRef = useRef<HTMLImageElement | null>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  useEffect(() => {
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

  const cellW = Math.floor(imageWidth / cols);
  const cellH = Math.floor(imageHeight / rows);
  const frameCount = rows * cols;
  // 드래그 여유 공간: 셀 최소 치수의 25%. 이 범위 안에서 드래그해도 콘텐츠가 잘리지 않음.
  const dragPad = Math.round(Math.min(cellW, cellH) * 0.25);

  const [frames, setFrames] = useState<HTMLCanvasElement[]>([]);
  useEffect(() => {
    const img = imgRef.current;
    if (!img || !imgLoaded) {
      setFrames([]);
      return;
    }
    const out: HTMLCanvasElement[] = [];
    // 셀을 dragPad 만큼 확장한 영역을 원본 시트에서 직접 크롭 → 패딩 밴드에 셀 경계를
    // 넘어 그려진 실제 픽셀(발/로브/이펙트)이 담긴다. 빈 패딩이 아니라서 미세조정 시
    // 셀 밖으로 빠진 콘텐츠를 다시 끌어올 수 있다. 1:1 매핑이라 음수 소스 좌표도 안전(밖은 투명).
    const padW = cellW + 2 * dragPad;
    const padH = cellH + 2 * dragPad;
    const push = (cx: number, cy: number) => {
      const c = document.createElement("canvas");
      c.width = padW;
      c.height = padH;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, cx * cellW - dragPad, cy * cellH - dragPad, padW, padH, 0, 0, padW, padH);
      // 밴드에 끌려온 이웃 셀 조각 제거 — 셀 내부 콘텐츠에 4-연결로 이어진 픽셀만 보존.
      // 캐릭터 자신의 오버플로(발/로브)는 본체와 연결돼 살아남고, 동떨어진 이웃 조각만 투명화.
      maskToCellComponent(ctx, padW, padH, dragPad, cellW, cellH);
      out.push(c);
    };
    if (order === "row") {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) push(c, r);
    } else {
      for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) push(c, r);
    }
    setFrames(out);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOffsets(Array.from({ length: out.length }, () => ({ x: 0, y: 0 })));
  }, [imgLoaded, rows, cols, order, cellW, cellH, dragPad]);

  // 프레임은 이미 dragPad 포함 패딩 캔버스(실제 픽셀)이므로 사용자 오프셋만 적용해
  // 재배치. 오프셋 0이면 원본 프레임 그대로 반환.
  const adjustedFrames = useMemo(() => {
    if (frames.length === 0 || offsets.length !== frames.length) return frames;
    return frames.map((frame, i) => {
      const off = offsets[i] ?? { x: 0, y: 0 };
      if (off.x === 0 && off.y === 0) return frame;
      const c = document.createElement("canvas");
      c.width = frame.width;
      c.height = frame.height;
      const ctx = c.getContext("2d");
      if (!ctx) return c;
      ctx.drawImage(frame, off.x, off.y);
      return c;
    });
  }, [frames, offsets]);

  // 내보내기 = 패딩 캔버스(cellW+2*dragPad × cellH+2*dragPad) 그대로.
  // 드래그로 원본 셀 경계 밖으로 빠진 픽셀도 잘리지 않음.
  const exportFrames = adjustedFrames;
  const exportW = cellW + 2 * dragPad;
  const exportH = cellH + 2 * dragPad;

  // GIF 는 항상 순방향 — AI 가 seamlessLoop 로 설계한 사이클을 그대로 재생
  const gifFrames = exportFrames;

  const thumbs = useMemo(
    () => adjustedFrames.map(f => f.toDataURL("image/png")),
    [adjustedFrames],
  );

  // 미리보기 재생 프레임 — adjustedFrames 우선, 없으면 frames.
  const previewFrames = adjustedFrames.length > 0 ? adjustedFrames : frames;

  // 프레임 수가 바뀌면 재생 인덱스를 범위 안으로 클램프.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreviewIdx(i => (previewFrames.length === 0 ? 0 : Math.min(i, previewFrames.length - 1)));
  }, [previewFrames.length]);

  // 재생 루프 — fps 에 맞춰 previewIdx 를 순방향으로 진행. setInterval cleanup 으로 정리.
  useEffect(() => {
    if (!playing || previewFrames.length <= 1) return;
    const delay = Math.max(20, Math.round(1000 / fps));
    const id = setInterval(() => {
      setPreviewIdx(i => (i + 1) % previewFrames.length);
    }, delay);
    return () => clearInterval(id);
  }, [playing, fps, previewFrames.length]);

  // 현재 프레임을 canvas 에 직접 그림 — 투명 알파 보존을 위해 clearRect 선행.
  useEffect(() => {
    const c = previewRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    if (c.width !== exportW || c.height !== exportH) {
      c.width = exportW;
      c.height = exportH;
    }
    ctx.clearRect(0, 0, c.width, c.height);
    const frame = previewFrames[previewIdx];
    if (frame) ctx.drawImage(frame, 0, 0);
  }, [previewFrames, previewIdx, exportW, exportH]);

  // 드래그 — window 이벤트로 썸네일 밖에서도 추적. 선택은 mouseDown 시점에 끝났음.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      setOffsets(prev =>
        prev.map((o, i) =>
          i === dragging.idx ? { x: dragging.origX + dx, y: dragging.origY + dy } : o,
        ),
      );
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  // 키보드 — selectedIdx 가 있을 때 화살표 키로 위치 미세 조정
  useEffect(() => {
    if (selectedIdx === null) return;
    const onKey = (e: KeyboardEvent) => {
      // 입력 필드 포커스 시 무시
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement)?.isContentEditable) return;
      let dx = 0, dy = 0;
      if (e.key === "ArrowLeft") dx = -1;
      else if (e.key === "ArrowRight") dx = 1;
      else if (e.key === "ArrowUp") dy = -1;
      else if (e.key === "ArrowDown") dy = 1;
      else if (e.key === "Escape") {
        setSelectedIdx(null);
        return;
      } else return;
      const step = e.shiftKey ? 10 : 1;
      e.preventDefault();
      setOffsets(prev =>
        prev.map((o, i) =>
          i === selectedIdx ? { x: o.x + dx * step, y: o.y + dy * step } : o,
        ),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx]);

  // 선택된 셀에서 인접 셀로부터 넘어온 작은 픽셀 덩어리(=잔재) 제거.
  // connected components 분석으로 가장 큰 덩어리의 10% 미만 크기인 컴포넌트만 알파 0.
  function cleanSelectedCell() {
    if (selectedIdx === null) return;
    const frame = frames[selectedIdx];
    if (!frame) return;
    const ctx = frame.getContext("2d");
    if (!ctx) return;
    const W = frame.width;
    const H = frame.height;
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const N = W * H;

    // alpha > 10 픽셀 마스크
    const mask = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (d[i * 4 + 3] > 10) mask[i] = 1;
    }

    // 4-connectivity flood fill 로 컴포넌트 라벨링 + 크기 집계
    const labels = new Int32Array(N);
    const sizes: number[] = [0];
    let next = 1;
    const stack: number[] = [];
    for (let start = 0; start < N; start++) {
      if (mask[start] === 0 || labels[start] !== 0) continue;
      labels[start] = next;
      let size = 0;
      stack.push(start);
      while (stack.length > 0) {
        const p = stack.pop()!;
        size++;
        const x = p % W;
        const y = (p - x) / W;
        if (x > 0 && mask[p - 1] === 1 && labels[p - 1] === 0) {
          labels[p - 1] = next;
          stack.push(p - 1);
        }
        if (x < W - 1 && mask[p + 1] === 1 && labels[p + 1] === 0) {
          labels[p + 1] = next;
          stack.push(p + 1);
        }
        if (y > 0 && mask[p - W] === 1 && labels[p - W] === 0) {
          labels[p - W] = next;
          stack.push(p - W);
        }
        if (y < H - 1 && mask[p + W] === 1 && labels[p + W] === 0) {
          labels[p + W] = next;
          stack.push(p + W);
        }
      }
      sizes.push(size);
      next++;
    }

    if (sizes.length <= 2) return; // 컴포넌트 1개 이하 → 잔재 없음

    // 가장 큰 컴포넌트 = 메인 콘텐츠
    let maxSize = 0;
    let mainLabel = 0;
    for (let l = 1; l < sizes.length; l++) {
      if (sizes[l] > maxSize) {
        maxSize = sizes[l];
        mainLabel = l;
      }
    }

    // 메인 컴포넌트의 bounding box + 5% margin
    // → 메인 영역 주변의 작은 디테일(불꽃 튀기 등)은 보존, 멀리 떨어진 침범 픽셀만 제거
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let i = 0; i < N; i++) {
      if (labels[i] !== mainLabel) continue;
      const x = i % W;
      const y = (i - x) / W;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const margin = Math.round(Math.min(W, H) * (cleanMarginPct / 100));
    const exMinX = Math.max(0, minX - margin);
    const exMinY = Math.max(0, minY - margin);
    const exMaxX = Math.min(W - 1, maxX + margin);
    const exMaxY = Math.min(H - 1, maxY + margin);

    // 각 컴포넌트의 centroid (중심점) — 컴포넌트가 메인 영역 안인지 밖인지 결정
    const cxSum = new Float64Array(sizes.length);
    const cySum = new Float64Array(sizes.length);
    for (let i = 0; i < N; i++) {
      const l = labels[i];
      if (l === 0) continue;
      const x = i % W;
      const y = (i - x) / W;
      cxSum[l] += x;
      cySum[l] += y;
    }

    // 작은 컴포넌트(메인의 cleanSizePct% 미만) 중 centroid 가 메인 bbox+margin 밖인 것만 제거
    const minKeep = Math.max(4, Math.floor(maxSize * (cleanSizePct / 100)));
    const remove = new Uint8Array(sizes.length);
    for (let l = 1; l < sizes.length; l++) {
      if (l === mainLabel || sizes[l] >= minKeep) continue;
      const cx = cxSum[l] / sizes[l];
      const cy = cySum[l] / sizes[l];
      if (cx < exMinX || cx > exMaxX || cy < exMinY || cy > exMaxY) {
        remove[l] = 1;
      }
    }

    let removed = 0;
    for (let i = 0; i < N; i++) {
      if (remove[labels[i]] === 1) {
        d[i * 4 + 3] = 0;
        removed++;
      }
    }
    if (removed === 0) return;

    ctx.putImageData(img, 0, 0);
    const clone = document.createElement("canvas");
    clone.width = W;
    clone.height = H;
    clone.getContext("2d")?.drawImage(frame, 0, 0);
    setFrames(prev => prev.map((f, i) => (i === selectedIdx ? clone : f)));
  }

  // bounding box 기반 자동 정렬 — bottom 기준으로 발 라인 통일
  function autoAlign() {
    if (frames.length === 0) return;
    const boxes = frames.map(frame => {
      const ctx = frame.getContext("2d");
      if (!ctx) return { maxY: frame.height };
      const { data, width, height } = ctx.getImageData(0, 0, frame.width, frame.height);
      let maxY = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const r = data[idx], g = data[idx + 1], b = data[idx + 2], a = data[idx + 3];
          const isBg = a < 10 || (r > 240 && g > 240 && b > 240);
          if (!isBg && y > maxY) maxY = y;
        }
      }
      return { maxY };
    });

    const maxBottom = Math.max(...boxes.map(b => b.maxY));
    setOffsets(boxes.map(box => ({ x: 0, y: maxBottom - box.maxY })));
  }

  function resetOffsets() {
    setOffsets(Array.from({ length: frames.length }, () => ({ x: 0, y: 0 })));
  }

  // GIF 빌드
  useEffect(() => {
    if (gifFrames.length === 0) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      setGifBusy(true);
      setGifError(null);
      try {
        const GIF = (await import("gif.js")).default;
        const gif = new GIF({
          workers: 2,
          workerScript: "/gif.worker.js",
          quality: 10,
          width: exportW,
          height: exportH,
          // GIF 은 1비트 투명만 지원 → 스프라이트에 거의 없는 마젠타를 키 색으로.
          // 검정(0x000000)을 키로 쓰면 어두운 스프라이트 내부가 투명 구멍이 된다.
          transparent: 0xff00ff as unknown as string,
        });
        const delay = Math.max(20, Math.round(1000 / fps));
        for (const f of gifFrames) gif.addFrame(toGifFrame(f), { delay });
        const blob: Blob = await new Promise((resolve, reject) => {
          gif.on("finished", (b: Blob) => resolve(b));
          gif.on("abort", () => reject(new Error("aborted")));
          gif.render();
        });
        if (cancelled) return;
        setGifUrl(prev => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      } catch (e) {
        if (!cancelled) setGifError((e as Error).message);
      } finally {
        if (!cancelled) setGifBusy(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [gifFrames, fps, exportW, exportH]);

  useEffect(() => () => { if (gifUrl) URL.revokeObjectURL(gifUrl); }, [gifUrl]);

  async function downloadZip() {
    if (exportFrames.length === 0 || downloading) return;
    setDownloading("zip");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const pad = String(exportFrames.length - 1).length;
      exportFrames.forEach((c, i) => {
        const dataUrl = c.toDataURL("image/png");
        const base64 = dataUrl.slice("data:image/png;base64,".length);
        zip.file(
          `${parentGenerationId}-${String(i).padStart(pad, "0")}.png`,
          base64,
          { base64: true },
        );
      });
      const blob = await zip.generateAsync({ type: "blob" });
      triggerDownload(blob, `${parentGenerationId}-frames.zip`);
    } finally {
      setDownloading(null);
    }
  }

  async function downloadGif() {
    if (!gifUrl || downloading) return;
    setDownloading("gif");
    try {
      const r = await fetch(gifUrl);
      const blob = await r.blob();
      triggerDownload(blob, `${parentGenerationId}.gif`);
    } finally {
      setDownloading(null);
    }
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <span className="font-medium text-text-primary">🎬 스프라이트 분할</span>
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
        <p className="text-xs text-text-muted">
          행·열을 지정해서 시트를 N×M 프레임으로 분할합니다. 클라이언트 처리 — DB 저장 없음.
        </p>

        <div
          className="relative mx-auto shrink-0 select-none rounded-lg border border-border bg-bg-card"
          style={{ width: displayW, height: displayH }}
        >
          <canvas ref={baseRef} className="absolute inset-0" width={displayW} height={displayH} />
          <GridOverlay rows={rows} cols={cols} w={displayW} h={displayH} />
        </div>

        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">행</span>
              <input
                type="number" min={1} max={16} value={rows}
                onChange={e => setRows(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <label className="flex items-center gap-1">
              <span className="w-6 text-text-muted">열</span>
              <input
                type="number" min={1} max={16} value={cols}
                onChange={e => setCols(clamp(Number(e.target.value), 1, 16))}
                className="h-7 w-14 rounded border border-border bg-bg-app px-1 text-center text-text-primary"
              />
            </label>
            <span className="text-text-muted/70">셀 {cellW}×{cellH} · 출력 {exportW}×{exportH} · {frameCount}프레임</span>
          </div>
          <div className="flex items-center gap-1">
            <span className="w-12 text-text-muted">순서</span>
            <button
              onClick={() => setOrder("row")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                order === "row"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowRight size={12} /> 가로
            </button>
            <button
              onClick={() => setOrder("col")}
              className={`flex h-7 flex-1 items-center justify-center gap-1 rounded border px-2 ${
                order === "col"
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-border text-text-muted hover:text-text-primary"
              }`}
            >
              <ArrowDown size={12} /> 세로
            </button>
          </div>
        </div>

        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">분할 결과 ({thumbs.length}프레임)</span>
            <div className="flex gap-1">
              <button
                onClick={autoAlign}
                disabled={frames.length === 0}
                className="flex h-6 items-center gap-1 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                title="발(bottom) 기준으로 자동 정렬"
              >
                <RefreshCw size={10} /> 자동 정렬
              </button>
              <button
                onClick={resetOffsets}
                disabled={frames.length === 0}
                className="h-6 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                title="위치 초기화"
              >
                초기화
              </button>
            </div>
          </div>
          <p className="text-[11px] text-text-muted/60">
            드래그 또는 클릭으로 셀 선택 후 화살표 키(Shift = 10px)로 미세 조정. 점선 사각형은 원본 셀 경계이며, 출력은 ±{dragPad}px 여유까지 포함합니다.
          </p>
          {selectedIdx !== null && (
            <div className="space-y-2 rounded border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/10 p-2">
              <div className="flex items-center gap-2">
                <span className="text-text-primary">셀 #{selectedIdx}</span>
                <span className="flex-1 text-text-muted/70">
                  메인 콘텐츠에서 떨어진 잔재를 제거합니다.
                </span>
                <button
                  onClick={cleanSelectedCell}
                  className="flex h-6 shrink-0 items-center gap-1 rounded border border-border bg-bg-card px-2 text-text-primary hover:bg-bg-app"
                  title={`메인의 ${cleanSizePct}% 미만 + bbox 여백 ${cleanMarginPct}% 밖 잔재 제거`}
                >
                  <Eraser size={10} /> 잔재 제거
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-text-muted" title="이 비율보다 작은 덩어리만 제거 대상. 클수록 더 큰 잔재까지 제거">
                  크기 &lt; {cleanSizePct}%
                </span>
                <input
                  type="range" min={1} max={50} value={cleanSizePct}
                  onChange={e => setCleanSizePct(Number(e.target.value))}
                  className="flex-1 accent-[color:var(--accent)]"
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="w-20 shrink-0 text-text-muted" title="캐릭터 bbox 둘레 보호 여백. 줄일수록 캐릭터 가까운 잔재까지 제거(자기 디테일도 지워질 위험↑)">
                  여백 {cleanMarginPct}%
                </span>
                <input
                  type="range" min={0} max={25} value={cleanMarginPct}
                  onChange={e => setCleanMarginPct(Number(e.target.value))}
                  className="flex-1 accent-[color:var(--accent)]"
                />
              </div>
            </div>
          )}
          {/* cols 에 맞춰 동적 열 수 + 셀 비율을 실제 cellW/cellH 로 유지 */}
          <div
            className="grid gap-1"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            {thumbs.map((src, i) => {
              const off = offsets[i] ?? { x: 0, y: 0 };
              // 패딩 캔버스(cellW+2*dragPad × cellH+2*dragPad) 에서
              // 원본 셀 경계는 dragPad/(padW) ~ (padW-dragPad)/padW 구간.
              const padW = cellW + 2 * dragPad;
              const padH = cellH + 2 * dragPad;
              const cropPctX = (dragPad / padW) * 100;
              const cropPctY = (dragPad / padH) * 100;
              const cropW = (cellW / padW) * 100;
              const cropH = (cellH / padH) * 100;
              return (
                <div
                  key={i}
                  className={`relative rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px] select-none ${
                    dragging?.idx === i
                      ? "cursor-grabbing ring-2 ring-[color:var(--accent)] border-[color:var(--accent)]"
                      : selectedIdx === i
                        ? "cursor-grab ring-2 ring-[color:var(--accent)] border-[color:var(--accent)]"
                        : "cursor-grab border-border"
                  }`}
                  style={{ aspectRatio: `${padW}/${padH}` }}
                  onMouseDown={e => {
                    e.preventDefault();
                    setSelectedIdx(i);
                    setDragging({ idx: i, startX: e.clientX, startY: e.clientY, origX: off.x, origY: off.y });
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`frame ${i}`}
                    className="absolute inset-0 h-full w-full object-fill"
                    draggable={false}
                  />
                  <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                  >
                    {/* 출력 경계 점선 사각형 */}
                    <rect
                      x={cropPctX} y={cropPctY}
                      width={cropW} height={cropH}
                      fill="none"
                      stroke="rgba(251,191,36,0.8)" strokeWidth="0.8"
                      strokeDasharray="3 2" vectorEffect="non-scaling-stroke"
                    />
                    {/* 중앙 십자선 */}
                    <line
                      x1="50" y1={cropPctY} x2="50" y2={cropPctY + cropH}
                      stroke="rgba(168,85,247,0.6)" strokeWidth="0.6"
                      strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                    />
                    <line
                      x1={cropPctX} y1="50" x2={cropPctX + cropW} y2="50"
                      stroke="rgba(168,85,247,0.6)" strokeWidth="0.6"
                      strokeDasharray="2 2" vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {/* offset 수치 표시 */}
                  {(off.x !== 0 || off.y !== 0) && (
                    <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/70 px-0.5 text-[9px] tabular-nums text-white/90">
                      {off.x > 0 ? "+" : ""}{off.x},{off.y > 0 ? "+" : ""}{off.y}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <span className="w-12 text-text-muted">FPS</span>
            <input
              type="range" min={1} max={30} value={fps}
              onChange={e => setFps(Number(e.target.value))}
              className="flex-1 accent-[color:var(--accent)]"
            />
            <span className="w-10 text-right tabular-nums text-text-muted/80">{fps}</span>
          </div>
          <div className="flex items-start gap-2">
            <span className="text-text-muted">미리보기</span>
            <div className="flex flex-1 flex-col gap-1">
              <div className="relative flex h-64 items-center justify-center overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]">
                {previewFrames.length > 0 ? (
                  <canvas ref={previewRef} className="block h-full w-auto" />
                ) : (
                  <span className="text-text-muted/60">대기</span>
                )}
                {previewFrames.length > 0 && (
                  <span className="pointer-events-none absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] tabular-nums text-white/90">
                    {previewIdx + 1} / {previewFrames.length}
                  </span>
                )}
              </div>
              <div className="flex items-center justify-center gap-1">
                <button
                  onClick={() => {
                    setPlaying(false);
                    setPreviewIdx(i => (i - 1 + previewFrames.length) % previewFrames.length);
                  }}
                  disabled={previewFrames.length === 0}
                  className="flex h-7 items-center justify-center rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title="이전 프레임"
                >
                  <SkipBack size={12} />
                </button>
                <button
                  onClick={() => setPlaying(p => !p)}
                  disabled={previewFrames.length <= 1}
                  className="flex h-7 items-center justify-center gap-1 rounded border border-border px-3 text-text-primary hover:bg-bg-app disabled:opacity-40"
                  title={playing ? "일시정지" : "재생"}
                >
                  {playing ? <Pause size={12} /> : <Play size={12} />}
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setPreviewIdx(i => (i + 1) % previewFrames.length);
                  }}
                  disabled={previewFrames.length === 0}
                  className="flex h-7 items-center justify-center rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title="다음 프레임"
                >
                  <SkipForward size={12} />
                </button>
              </div>
              {(gifBusy || gifError) && (
                <span className="text-center text-[11px] text-text-muted/60">
                  {gifBusy ? "GIF 생성 중…" : <span className="text-[color:var(--danger)]">{gifError}</span>}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        <button
          onClick={onCancel}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 닫기
        </button>
        <button
          onClick={downloadZip}
          disabled={adjustedFrames.length === 0 || !!downloading}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-card disabled:opacity-40"
        >
          <FileArchive size={14} /> {downloading === "zip" ? "..." : "프레임 zip"}
        </button>
        <button
          onClick={downloadGif}
          disabled={!gifUrl || !!downloading}
          className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          <Download size={14} /> {downloading === "gif" ? "..." : "GIF 저장"}
        </button>
      </footer>
    </aside>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

// 패딩 밴드의 이웃 셀 잔재 제거 — 셀 내부(중앙 영역) 콘텐츠에서 4-연결 flood fill 로
// 도달하는 픽셀만 남기고, 밴드에 동떨어진 이웃 조각은 알파 0. (in-place)
function maskToCellComponent(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  pad: number,
  cellW: number,
  cellH: number,
): void {
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  const N = W * H;
  const content = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (d[i * 4 + 3] > 10) content[i] = 1;

  const keep = new Uint8Array(N);
  const stack: number[] = [];
  // seed: 셀 내부 영역의 콘텐츠 픽셀
  for (let y = pad; y < pad + cellH; y++) {
    for (let x = pad; x < pad + cellW; x++) {
      const i = y * W + x;
      if (content[i] === 1 && keep[i] === 0) {
        keep[i] = 1;
        stack.push(i);
      }
    }
  }
  while (stack.length > 0) {
    const p = stack.pop()!;
    const x = p % W;
    if (x > 0 && content[p - 1] === 1 && keep[p - 1] === 0) { keep[p - 1] = 1; stack.push(p - 1); }
    if (x < W - 1 && content[p + 1] === 1 && keep[p + 1] === 0) { keep[p + 1] = 1; stack.push(p + 1); }
    if (p - W >= 0 && content[p - W] === 1 && keep[p - W] === 0) { keep[p - W] = 1; stack.push(p - W); }
    if (p + W < N && content[p + W] === 1 && keep[p + W] === 0) { keep[p + W] = 1; stack.push(p + W); }
  }

  let changed = false;
  for (let i = 0; i < N; i++) {
    if (content[i] === 1 && keep[i] === 0) {
      d[i * 4 + 3] = 0;
      changed = true;
    }
  }
  if (changed) ctx.putImageData(img, 0, 0);
}

// GIF 투명 처리용 — 알파 채널을 마젠타(0xff00ff) 1비트 키로 변환.
// 반투명 픽셀은 GIF 특성상 표현 불가하므로 임계값(128)으로 이진화한다.
function toGifFrame(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d");
  if (!ctx) return src;
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) {
      d[i] = 0xff;
      d[i + 1] = 0x00;
      d[i + 2] = 0xff;
      d[i + 3] = 255;
    } else {
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function triggerDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function GridOverlay({ rows, cols, w, h }: { rows: number; cols: number; w: number; h: number }) {
  const vLines = Array.from({ length: cols - 1 }, (_, i) => ((i + 1) * w) / cols);
  const hLines = Array.from({ length: rows - 1 }, (_, i) => ((i + 1) * h) / rows);
  return (
    <svg
      className="pointer-events-none absolute inset-0"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
    >
      {/* 레퍼런스 그리드 스타일: 얇은 실선, 스프라이트 위에서도 구분되도록 반투명 흰선 + 보라 이중 */}
      {vLines.map((x, i) => (
        <g key={`v${i}`}>
          <line x1={x} y1={0} x2={x} y2={h} stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
          <line x1={x} y1={0} x2={x} y2={h} stroke="rgba(168, 85, 247, 0.8)" strokeWidth={0.75} />
        </g>
      ))}
      {hLines.map((y, i) => (
        <g key={`h${i}`}>
          <line x1={0} y1={y} x2={w} y2={y} stroke="rgba(255,255,255,0.4)" strokeWidth={2} />
          <line x1={0} y1={y} x2={w} y2={y} stroke="rgba(168, 85, 247, 0.8)" strokeWidth={0.75} />
        </g>
      ))}
    </svg>
  );
}

// ─── 그리드 자동 감지 ────────────────────────────────────────────────────────

/**
 * 스프라이트 시트 이미지 크기에서 rows × cols 를 역산.
 *
 * make_spritesheet 는 cellW = cellH = Math.min(512, floor(2048 / max(rows,cols))) 로
 * 정사각 셀을 쓰므로, cellSize = gcd(width, height) 의 약수 중 가장 큰 적합한 값을 찾는다.
 *
 * 예) 2048×2048 → gcd=2048, 최대 유효 약수=512, cols=4, rows=4
 *     2044×1752 → gcd=292,  cols=7, rows=6
 *     1636×2045 → gcd=409,  cols=4, rows=5
 */
function detectSpriteGrid(
  width: number,
  height: number,
): { rows: number; cols: number } | null {
  if (!width || !height) return null;
  const g = gcd(width, height);
  // g 의 모든 약수를 구해 내림차순 정렬
  const divs: number[] = [];
  for (let d = 1; d * d <= g; d++) {
    if (g % d === 0) {
      divs.push(d);
      if (d !== g / d) divs.push(g / d);
    }
  }
  divs.sort((a, b) => b - a);
  for (const d of divs) {
    if (d < 64 || d > 512) continue; // 64 ~ 512 px 범위 셀만 유효
    const c = width / d;
    const r = height / d;
    if (c >= 1 && c <= 16 && r >= 1 && r <= 16 && Number.isInteger(c) && Number.isInteger(r)) {
      return { rows: r, cols: c };
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
