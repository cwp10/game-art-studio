"use client";

import { ArrowDown, ArrowRight, Download, Eraser, FileArchive, FileJson, Film, Layers, Pause, Play, RefreshCw, Save, SkipBack, SkipForward, X } from "lucide-react";
import { type DragEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getGeneration, uploadSpritesheet } from "@/lib/api/client";
import { directionLabels, type Directions } from "@/lib/mcp/spritesheet-classify";
import { detectSpriteGrid } from "@/lib/shared/detect-sprite-grid";

type Order = "row" | "col";

// make_spritesheet 가 generation.params 에 영속하는 메타(전부 선택 — 구버전 시트는 비어있음).
type SheetParams = {
  rows?: number;
  cols?: number;
  cellW?: number;
  cellH?: number;
  directions?: number;
  subjectType?: string;
  anchorStrategy?: string;
  seamlessLoop?: boolean;
  anchor?: { x: number; y: number };
  fps?: number;
};

type Props = {
  parentGenerationId: string;
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  maxDisplayPx?: number;
  sessionId?: string | null;
  onCancel: () => void;
  /** 보정본을 새 generation 으로 저장 후 호출 — ChatLayout 이 결과 카드 삽입. */
  onSaved?: (result: { generationId: string; width: number; height: number }) => void;
};

export function SpriteCanvas({
  parentGenerationId,
  imageUrl,
  imageWidth,
  imageHeight,
  maxDisplayPx = 1200,
  sessionId,
  onCancel,
  onSaved,
}: Props) {
  const baseRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLCanvasElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState<{ w: number; h: number } | null>(null);
  // 이미지 크기에서 GCD로 셀 크기를 역산해 rows/cols 자동 감지. 감지 실패 시 기본값 6×7.
  // params(make_spritesheet 영속) 가 있으면 grid source-of-truth 로 그쪽을 우선(아래 fetch effect).
  const detected = detectSpriteGrid(imageWidth, imageHeight);
  const [rows, setRows] = useState(detected?.rows ?? 6);
  const [cols, setCols] = useState(detected?.cols ?? 7);
  const [order, setOrder] = useState<Order>("row");
  const [fps, setFps] = useState(12);
  // 백엔드가 영속한 생성 메타(rows/cols/cellW/cellH/directions/subjectType/anchor/seamlessLoop/fps).
  // 없으면 null → GCD 폴백(구버전 외부 업로드 시트).
  const [params, setParams] = useState<SheetParams | null>(null);
  // 방향 시트(rows=directions>1)면 특정 방향(행)만 재생; -1 = 전체. directions 없으면 항상 -1.
  const [dirRow, setDirRow] = useState(-1);
  const [onion, setOnion] = useState(false);
  // 행 전체 보정 모드 — 선택 셀이 속한 행의 모든 프레임에 같은 오프셋 일괄 적용(방향 시트용).
  const [rowMode, setRowMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);

  // 마운트 시 parentGenerationId 로 params fetch → 있으면 rows/cols/fps 를 그 값으로 동기화.
  // 사용자 수동 입력은 유지(이후 setRows/setCols 가능)하되 초기값만 params 우선.
  useEffect(() => {
    let cancelled = false;
    getGeneration(parentGenerationId).then(gen => {
      if (cancelled || !gen) return;
      const p = gen.params as SheetParams;
      if (typeof p?.rows === "number" && p.rows >= 1 && p.rows <= 16) setRows(p.rows);
      if (typeof p?.cols === "number" && p.cols >= 1 && p.cols <= 16) setCols(p.cols);
      if (typeof p?.fps === "number" && p.fps >= 1 && p.fps <= 30) setFps(p.fps);
      setParams(p ?? null);
    });
    return () => { cancelled = true; };
  }, [parentGenerationId]);
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

  // 프레임 순서 — displayPos → originalIdx 매핑. 수동 재배열 시 이 배열만 바뀐다.
  // frames 가 새로 분할되면(개수·rows·cols·order 변화) 항등 순서로 초기화(아래 frame-build effect).
  const [frameOrder, setFrameOrder] = useState<number[]>([]);
  // 순서 변경 모드 토글 — ON 이면 셀이 HTML5 draggable, 기존 mouse 미세조정은 비활성.
  const [reorderMode, setReorderMode] = useState(false);
  // 드래그 중인 display 인덱스(HTML5 drag API용) + 드롭 타깃 하이라이트.
  const dragFromIdxRef = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

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

  // 비정사각 셀 지원 — cellW/cellH 를 각각 독립 역산(정사각 가정 없음).
  const cellW = Math.floor(imageWidth / cols);
  const cellH = Math.floor(imageHeight / rows);
  const frameCount = rows * cols;
  // 드래그 여유 공간: 셀 최소 치수의 25%. 이 범위 안에서 드래그해도 콘텐츠가 잘리지 않음.
  const dragPad = Math.round(Math.min(cellW, cellH) * 0.25);

  // 방향 시트 판정 — params.directions>1 이면 rows=directions(백엔드 보장). 라벨은 게임 관례.
  // params 없으면(구버전) 행 인덱스로 폴백. order="row" 일 때만 행=방향 매핑이 유효.
  const directionCount =
    params && typeof params.directions === "number" && params.directions > 1
      ? params.directions
      : 0;
  const dirLabels = useMemo(() => {
    if (directionCount && [2, 4, 8].includes(directionCount)) {
      return directionLabels(directionCount as Directions);
    }
    // params 에 directions 가 없거나 비표준이면 행 인덱스 라벨.
    return directionCount ? Array.from({ length: rows }, (_, i) => `행 ${i + 1}`) : [];
  }, [directionCount, rows]);
  const isDirSheet = directionCount > 0 && order === "row";
  // 방향 시트가 아니거나 dirRow 가 행 범위를 벗어나면(분할 변경) 전체로 리셋.
  useEffect(() => {
    if (!isDirSheet || dirRow >= rows) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDirRow(-1);
    }
  }, [isDirSheet, rows, dirRow]);

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
    setOffsets(Array.from({ length: out.length }, () => ({ x: 0, y: 0 })));
    // 프레임이 새로 분할되면 순서도 항등으로 리셋 + 재배열 모드 해제.
    // (order row↔col 토글이나 rows/cols 변경처럼 length 가 같아도 매핑이 무효가 되므로
    //  여기서 처리 — frames.length effect 로는 그 경우를 못 잡는다.)
    setFrameOrder(Array.from({ length: out.length }, (_, i) => i));
    setReorderMode(false);
  }, [imgLoaded, rows, cols, order, cellW, cellH, dragPad]);

  // 프레임 선택 해제 — 클릭으로 개별 프레임을 애니메이션/내보내기에서 제외. frames 가 새로
  // 분할되면(개수 변화) 초기화. 인덱스는 원본 frames 배열 기준.
  const [excludedFrames, setExcludedFrames] = useState<Set<number>>(new Set());
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExcludedFrames(new Set());
  }, [frames.length]);

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

  // ZIP 내보내기용 — 표시 순서(frameOrder)대로 정렬 후 제외 프레임을 뺀 압축 배열.
  // gifFrames/previewFrames 는 playIndices(표시 순서·필터됨) 기반이라 자동 반영되므로 ZIP 만 여기서 정렬.
  const activeExportFrames = useMemo(() => {
    const ord =
      frameOrder.length === exportFrames.length
        ? frameOrder
        : exportFrames.map((_, i) => i);
    return ord.filter(origIdx => !excludedFrames.has(origIdx)).map(origIdx => exportFrames[origIdx]);
  }, [exportFrames, frameOrder, excludedFrames]);

  // 썸네일 = 표시 순서대로. frameOrder[displayPos] = origIdx. 초기화 전(길이 불일치)엔 원본 순서.
  const thumbs = useMemo(
    () => {
      if (frameOrder.length !== adjustedFrames.length) {
        return adjustedFrames.map(f => f.toDataURL("image/png"));
      }
      return frameOrder.map(origIdx => adjustedFrames[origIdx]?.toDataURL("image/png") ?? "");
    },
    [adjustedFrames, frameOrder],
  );

  // 재생/GIF 대상 origIdx — frameOrder(표시 순서)로 정렬 후 방향·제외 필터. 이게 순서의 단일 소스.
  // previewFrames/gifFrames 는 base[origIdx]/exportFrames[origIdx] 로 인덱싱하므로(둘 다 원본 순서)
  // 여기에만 frameOrder 를 적용하면 미리보기·GIF·ZIP 모두 자동으로 표시 순서를 따른다.
  // 방향(행) 선택 시 그 행의 프레임만. row-order 에서 행 r = [r*cols, r*cols+cols).
  const playIndices = useMemo(() => {
    const n = (adjustedFrames.length > 0 ? adjustedFrames : frames).length;
    const ord = frameOrder.length === n ? frameOrder : Array.from({ length: n }, (_, i) => i);
    return ord.filter(origIdx => {
      if (isDirSheet && dirRow >= 0 && !(origIdx >= dirRow * cols && origIdx < dirRow * cols + cols)) {
        return false;
      }
      return !excludedFrames.has(origIdx);
    });
  }, [adjustedFrames, frames, frameOrder, isDirSheet, dirRow, cols, excludedFrames]);

  // 미리보기 재생 프레임 — adjustedFrames 우선, 없으면 frames. 방향 필터 적용.
  const previewFrames = useMemo(() => {
    const base = adjustedFrames.length > 0 ? adjustedFrames : frames;
    return playIndices.map(i => base[i]).filter(Boolean) as HTMLCanvasElement[];
  }, [adjustedFrames, frames, playIndices]);

  // GIF 는 항상 순방향 — AI 가 seamlessLoop 로 설계한 사이클을 그대로 재생. 방향 선택 시 그 행만.
  const gifFrames = useMemo(
    () => playIndices.map(i => exportFrames[i]).filter(Boolean) as HTMLCanvasElement[],
    [playIndices, exportFrames],
  );

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
  // 어니언 스킨 ON: 같은 (방향 필터된) 시퀀스 내 이전/다음 프레임을 30% 반투명으로 깔아
  // 앵커 보정 정렬을 시각 보조. 현재 프레임은 항상 위에 100% 로.
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
    const n = previewFrames.length;
    if (n === 0) return;
    if (onion && n > 1) {
      ctx.globalAlpha = 0.3;
      const prev = previewFrames[(previewIdx - 1 + n) % n];
      const next = previewFrames[(previewIdx + 1) % n];
      if (prev) ctx.drawImage(prev, 0, 0);
      if (next) ctx.drawImage(next, 0, 0);
      ctx.globalAlpha = 1;
    }
    const frame = previewFrames[previewIdx];
    if (frame) ctx.drawImage(frame, 0, 0);
  }, [previewFrames, previewIdx, exportW, exportH, onion]);

  // 한 셀 인덱스가 속한 (보정 적용 대상) 인덱스들. rowMode=ON 이면 같은 행 전체, 아니면 자기 자신만.
  // row-order: 행 = floor(i/cols), 같은 행 = [r*cols, r*cols+cols). col-order: 행 = i%rows.
  const siblingsOf = useCallback(
    (idx: number): number[] => {
      if (!rowMode) return [idx];
      if (order === "row") {
        const r = Math.floor(idx / cols);
        return Array.from({ length: cols }, (_, c) => r * cols + c);
      }
      const r = idx % rows;
      return Array.from({ length: cols }, (_, c) => c * rows + r);
    },
    [rowMode, order, cols, rows],
  );

  // 드래그 — window 이벤트로 썸네일 밖에서도 추적. 선택은 mouseDown 시점에 끝났음.
  // rowMode 면 같은 행의 모든 프레임에 동일 오프셋 일괄 적용(방향 시트 행 보정).
  useEffect(() => {
    if (!dragging) return;
    const sibs = new Set(siblingsOf(dragging.idx));
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - dragging.startX;
      const dy = e.clientY - dragging.startY;
      setOffsets(prev =>
        prev.map((o, i) =>
          sibs.has(i) ? { x: dragging.origX + dx, y: dragging.origY + dy } : o,
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
  }, [dragging, siblingsOf]);

  // 키보드 — selectedIdx 가 있을 때 화살표 키로 위치 미세 조정. rowMode 면 같은 행 일괄.
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
      const sibs = new Set(siblingsOf(selectedIdx));
      setOffsets(prev =>
        prev.map((o, i) =>
          sibs.has(i) ? { x: o.x + dx * step, y: o.y + dy * step } : o,
        ),
      );
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIdx, siblingsOf]);

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
    setFrameOrder(Array.from({ length: frames.length }, (_, i) => i));
  }

  // 수동 재배열(HTML5 drag) — display 인덱스 기준. frameOrder 만 splice 로 재배치.
  function handleReorderDragStart(displayIdx: number, e: DragEvent) {
    dragFromIdxRef.current = displayIdx;
    // 일부 엔진은 setData 없으면 드래그가 시작되지 않음 — 호환성 보강(값 자체는 ref 로 추적).
    e.dataTransfer.setData("text/plain", String(displayIdx));
    e.dataTransfer.effectAllowed = "move";
  }

  function handleReorderDrop(dropIdx: number) {
    const fromIdx = dragFromIdxRef.current;
    if (fromIdx === null || fromIdx === dropIdx) {
      setDragOverIdx(null);
      return;
    }
    setFrameOrder(prev => {
      const next = [...prev];
      const [moved] = next.splice(fromIdx, 1);
      next.splice(dropIdx, 0, moved);
      return next;
    });
    dragFromIdxRef.current = null;
    setDragOverIdx(null);
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
    if (activeExportFrames.length === 0 || downloading) return;
    setDownloading("zip");
    try {
      const JSZip = (await import("jszip")).default;
      const zip = new JSZip();
      const pad = String(activeExportFrames.length - 1).length;
      activeExportFrames.forEach((c, i) => {
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

  // ⑧ 아틀라스 메타데이터(.json) — 엔진(Unity/Godot/Phaser)에서 바로 슬라이싱.
  // params 우선, 없으면(구버전) 현재 rows/cols/fps 로 최선. anchor 는 셀-로컬 피벗.
  function buildAtlasJson(): Record<string, unknown> {
    const directions =
      isDirSheet && dirLabels.length === rows
        ? dirLabels
        : directionCount && dirLabels.length
          ? dirLabels
          : undefined;
    return {
      image: `${parentGenerationId}.png`,
      cellWidth: cellW,
      cellHeight: cellH,
      rows,
      cols,
      subjectType: params?.subjectType ?? undefined,
      directions, // rows=방향일 때 행 순서 라벨, 아니면 생략
      framesPerDirection: directions ? cols : undefined,
      fps,
      loop: params?.seamlessLoop ?? true,
      anchor: params?.anchor ?? undefined, // 셀-로컬 피벗(발/엉덩이 라인)
    };
  }

  function downloadAtlasJson() {
    const json = JSON.stringify(buildAtlasJson(), null, 2);
    triggerDownload(new Blob([json], { type: "application/json" }), `${parentGenerationId}.json`);
  }

  // ⑤ 보정본 저장 — adjustedFrames 를 원본 시트 치수(cols*cellW × rows*cellH)로 재배치한
  // PNG 를 새 generation(kind='spritesheet')으로 저장. 원본 보존(비파괴). params 보존.
  async function saveCorrected() {
    if (frames.length === 0 || saving) return;
    setSaving(true);
    setSavedMsg(null);
    try {
      const sheetW = cols * cellW;
      const sheetH = rows * cellH;
      const c = document.createElement("canvas");
      c.width = sheetW;
      c.height = sheetH;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.clearRect(0, 0, sheetW, sheetH);
      // 각 패딩 프레임의 셀-원점(dragPad,dragPad)을 셀 위치(c*cellW,r*cellH)에 맞춰 그림.
      // 패딩 밴드는 이미 maskToCellComponent 로 이웃 잔재가 제거돼 자기 오버플로만 보존.
      // 표시 순서(frameOrder)대로 셀 위치에 재배치 — 수동 재배열을 시트에 영속화.
      const orderedFrames =
        frameOrder.length === adjustedFrames.length
          ? frameOrder.map(origIdx => adjustedFrames[origIdx])
          : adjustedFrames;
      orderedFrames.forEach((frame, displayPos) => {
        const { r, col } = framePos(displayPos, rows, cols, order);
        ctx.drawImage(frame, col * cellW - dragPad, r * cellH - dragPad);
      });
      const dataUrl = c.toDataURL("image/png");
      // params 에 보정 후 현재 fps 반영(나머지 grid/anchor/directions 는 그대로 보존).
      const savedParams = { ...(params ?? {}), rows, cols, cellW, cellH, fps };
      const res = await uploadSpritesheet({
        dataUrl,
        parentGenerationId,
        sessionId,
        params: savedParams,
      });
      setSavedMsg("보정본 저장됨");
      onSaved?.(res);
    } catch (e) {
      setSavedMsg(`저장 실패: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Film size={14} /> 스프라이트 분할
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
        <p className="text-xs text-text-muted">
          행·열을 지정해서 시트를 N×M 프레임으로 분할합니다. 다운로드는 클라이언트 처리,
          [보정본 저장]만 새 generation 으로 기록합니다(원본 보존).
        </p>

        <div
          className="checkerboard relative mx-auto shrink-0 select-none rounded-lg border border-border"
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
          {/* 방향 시트(rows=directions>1): 행=방향. 선택 시 미리보기/GIF 가 해당 행만 재생. */}
          {isDirSheet && (
            <div className="flex items-center gap-2">
              <span className="w-12 shrink-0 text-text-muted">방향</span>
              <select
                value={dirRow}
                onChange={e => { setDirRow(Number(e.target.value)); setPreviewIdx(0); }}
                className="h-7 flex-1 rounded border border-border bg-bg-app px-1 text-text-primary"
              >
                <option value={-1}>전체 ({rows}방향)</option>
                {dirLabels.map((label, i) => (
                  <option key={i} value={i}>{label}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <div className="shrink-0 space-y-2 rounded-lg border border-border bg-bg-card p-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-text-muted">
              분할 결과 ({excludedFrames.size > 0
                ? `${thumbs.length - excludedFrames.size}/${thumbs.length}`
                : thumbs.length}프레임)
            </span>
            <div className="flex gap-1">
              {/* 제외 프레임 있을 때만 — 전체 다시 포함. */}
              {excludedFrames.size > 0 && (
                <button
                  onClick={() => setExcludedFrames(new Set())}
                  disabled={frames.length === 0}
                  className="h-6 rounded border border-border px-2 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title="모두 포함"
                >
                  전체 선택
                </button>
              )}
              {/* 행 전체 보정 — 선택/드래그 시 같은 행 모든 프레임에 동일 오프셋 일괄(방향 시트). */}
              <button
                onClick={() => setRowMode(m => !m)}
                disabled={frames.length === 0}
                className={`h-6 rounded border px-2 disabled:opacity-40 ${
                  rowMode
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border text-text-muted hover:text-text-primary"
                }`}
                title="행 전체 보정: 한 행의 모든 프레임에 같은 오프셋 일괄 적용"
              >
                행 보정
              </button>
              {/* 순서 변경 — ON 이면 셀을 드래그해 프레임 순서 재배열(미리보기·GIF·ZIP·보정본에 반영). */}
              {/* 토글 시 선택 해제 — 재배열 모드에선 화살표 nudge 가 잔존 선택 셀에 새지 않도록. */}
              <button
                onClick={() => { setReorderMode(m => !m); setSelectedIdx(null); }}
                disabled={frames.length === 0}
                className={`h-6 rounded border px-2 disabled:opacity-40 ${
                  reorderMode
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                    : "border-border text-text-muted hover:text-text-primary"
                }`}
                title="프레임 순서 변경: 드래그로 프레임 순서 재배열"
              >
                순서 변경
              </button>
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
            {rowMode && <span className="text-[color:var(--accent)]"> 행 보정 ON — 조정이 같은 행 전체에 적용됩니다.</span>}
            {reorderMode && <span className="text-[color:var(--accent)]"> 순서 변경 ON — 셀을 드래그해 프레임 순서를 재배열하세요.</span>}
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
            {thumbs.map((src, displayIdx) => {
              // displayIdx = 화면 표시 위치, origIdx = 원본 frames 배열 인덱스(offsets/selected/excluded 기준).
              const origIdx = frameOrder[displayIdx] ?? displayIdx;
              const off = offsets[origIdx] ?? { x: 0, y: 0 };
              const isDragOver = reorderMode && dragOverIdx === displayIdx;
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
                  key={displayIdx}
                  draggable={reorderMode}
                  onDragStart={reorderMode ? (e) => handleReorderDragStart(displayIdx, e) : undefined}
                  onDragOver={reorderMode ? (e) => { e.preventDefault(); setDragOverIdx(displayIdx); } : undefined}
                  onDragLeave={reorderMode ? () => setDragOverIdx(null) : undefined}
                  onDrop={reorderMode ? (e) => { e.preventDefault(); handleReorderDrop(displayIdx); } : undefined}
                  onMouseDown={reorderMode ? undefined : (e) => {
                    e.preventDefault();
                    setSelectedIdx(origIdx);
                    setDragging({ idx: origIdx, startX: e.clientX, startY: e.clientY, origX: off.x, origY: off.y });
                  }}
                  className={`group relative rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px] select-none ${
                    isDragOver
                      ? "ring-2 ring-[color:var(--accent)] border-[color:var(--accent)] opacity-70"
                      : dragging?.idx === origIdx
                        ? "cursor-grabbing ring-2 ring-[color:var(--accent)] border-[color:var(--accent)]"
                        : selectedIdx === origIdx
                          ? "cursor-grab ring-2 ring-[color:var(--accent)] border-[color:var(--accent)]"
                          : reorderMode
                            ? "cursor-grab border-[color:var(--accent)]/40 hover:border-[color:var(--accent)]"
                            : "cursor-grab border-border"
                  }`}
                  style={{ aspectRatio: `${padW}/${padH}` }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={src}
                    alt={`frame ${origIdx}`}
                    className={`absolute inset-0 h-full w-full object-fill ${excludedFrames.has(origIdx) ? "opacity-30" : ""}`}
                    draggable={false}
                  />
                  {/* 제외된 프레임 — 어둡게 덮고 ✕ 표시. */}
                  {excludedFrames.has(origIdx) && (
                    <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded bg-black/60">
                      <span className="text-lg font-bold text-white/80">✕</span>
                    </div>
                  )}
                  {/* 순서 변경 모드 — 현재 표시 순번(1-based) 좌상단 배지. */}
                  {reorderMode && (
                    <span className="pointer-events-none absolute left-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] tabular-nums text-white/90">
                      {displayIdx + 1}
                    </span>
                  )}
                  {/* 호버 시 토글 버튼(우상단) — 제외/포함. 드래그 시작 방지. 순서 변경 모드에선 숨김. */}
                  {!reorderMode && (
                  <button
                    className="absolute right-0.5 top-0.5 z-10 flex h-4 w-4 items-center justify-center rounded-full border border-white/30 bg-black/50 text-[9px] text-white opacity-0 transition-opacity hover:bg-red-500/80 group-hover:opacity-100"
                    title={excludedFrames.has(origIdx) ? "포함" : "제외"}
                    onMouseDown={e => {
                      e.stopPropagation();
                      e.preventDefault();
                      setExcludedFrames(prev => {
                        const next = new Set(prev);
                        if (next.has(origIdx)) next.delete(origIdx);
                        else next.add(origIdx);
                        return next;
                      });
                    }}
                  >
                    {excludedFrames.has(origIdx) ? "+" : "×"}
                  </button>
                  )}
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
                {/* ⑪ 어니언 스킨 — 인접 프레임 30% 반투명 오버레이로 앵커 보정 정렬 보조. */}
                <button
                  onClick={() => setOnion(o => !o)}
                  disabled={previewFrames.length <= 1}
                  className={`flex h-7 items-center justify-center gap-1 rounded border px-2 disabled:opacity-40 ${
                    onion
                      ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                      : "border-border text-text-muted hover:text-text-primary"
                  }`}
                  title="어니언 스킨: 이전/다음 프레임을 반투명으로 겹쳐 보기"
                >
                  <Layers size={12} /> 어니언
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

      <footer className="mx-auto flex w-full max-w-[880px] flex-col gap-2 border-t border-border p-3">
        {/* ⑤ 보정본 저장 — 현재 오프셋 반영한 전체 시트를 새 generation 으로(원본 보존). */}
        <div className="flex items-center gap-2">
          <button
            onClick={saveCorrected}
            disabled={frames.length === 0 || saving}
            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          >
            <Save size={14} /> {saving ? "저장 중…" : "보정본 저장"}
          </button>
          {savedMsg && (
            <span className={`text-xs ${savedMsg.startsWith("저장 실패") ? "text-[color:var(--danger)]" : "text-text-muted"}`}>
              {savedMsg}
            </span>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={onCancel}
            className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
          >
            ✕ 닫기
          </button>
          <button
            onClick={downloadAtlasJson}
            disabled={frames.length === 0}
            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-card disabled:opacity-40"
            title="셀·그리드·방향·앵커 메타데이터 .json (엔진 슬라이싱용)"
          >
            <FileJson size={14} /> .json
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
            className="flex h-9 flex-1 items-center justify-center gap-1 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-card disabled:opacity-40"
          >
            <Download size={14} /> {downloading === "gif" ? "..." : "GIF"}
          </button>
        </div>
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

// 프레임 빌드 순서(order)에 맞춘 인덱스 → (행 r, 열 col) 역산. push 루프와 정확히 대응.
//   row-order: r*cols + col / col-order: col*rows + r.
function framePos(i: number, rows: number, cols: number, order: Order): { r: number; col: number } {
  if (order === "row") return { r: Math.floor(i / cols), col: i % cols };
  return { r: i % rows, col: Math.floor(i / rows) };
}
