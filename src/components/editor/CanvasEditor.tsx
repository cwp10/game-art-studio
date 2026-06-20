"use client";

import {
  ArrowLeft,
  Eye,
  EyeOff,
  GripVertical,
  Loader2,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compositeScene, filterImage, listGenerations, uploadImage } from "@/lib/api/client";
import type { Generation } from "@/types/db";
import { useZoomPan } from "./useZoomPan";

/**
 * CanvasEditor — 전체전환(full-takeover) 통합 캔버스 에디터 (1단계).
 *
 * seedGenerationId 를 첫 레이어로 진입해 여러 generation 을 한 캔버스에 쌓고, 선택 레이어에
 * 자유 변형(모서리=균일크기 · 노브=회전 · 변=비균일 늘이기 · 드래그=이동)·필터를 준 뒤,
 * `합치기 ▸` 로 POST /api/composite(레이어별 transform+filters 포함)를 호출해 한 장으로 flatten 한다.
 * 결과는 onComposited 로 부모에 전달돼 chat 결과 카드가 된다. 상태는 휘발(닫으면 사라짐).
 *
 * 와이어프레임(_workspace/wireframe-canvas-editor.html)의 레이아웃·인터랙션 수학을 React 로 이식.
 */

// 출력 캔버스 규격 프리셋 (+ 커스텀 입력). w/h 0 = 첫 레이어 기준 자유.
const SIZE_PRESETS = [
  { label: "자유 (첫 레이어)", w: 0, h: 0 },
  { label: "정사각 512", w: 512, h: 512 },
  { label: "정사각 1024", w: 1024, h: 1024 },
  { label: "HD 1280×720", w: 1280, h: 720 },
  { label: "Full HD 1920×1080", w: 1920, h: 1080 },
  { label: "모바일 390×844", w: 390, h: 844 },
] as const;

type LayerFilters = {
  brightness: number; // % (100=중립)
  contrast: number; // % (100=중립)
  saturation: number; // % (100=중립)
  hue: number; // ° (0=중립)
  blur: number; // px (0=없음)
};

const FILTER_DEFAULT: LayerFilters = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  hue: 0,
  blur: 0,
};

type Layer = {
  id: string; // 내부 키 (불변 — generationId 가 교체돼도 슬롯 유지)
  generationId: string; // 실제 이미지
  x: number; // 중앙기준 px
  y: number; // 중앙기준 px
  scale: number; // 균일 배율 (모서리 핸들)
  stretchW: number; // 가로 늘이기 배수 (좌우 변 핸들, 기본 1)
  stretchH: number; // 세로 늘이기 배수 (상하 변 핸들, 기본 1)
  rotation: number; // 도(°)
  flipH: boolean; // 좌우반전
  opacity: number; // 0~100
  filters: LayerFilters;
  visible: boolean;
};

type CanvasSize = { w: number; h: number };

type Snapshot = {
  layers: Layer[];
  canvasSize: CanvasSize;
  selectedLayerId: string | null;
};

type Props = {
  seedGenerationId: string;
  sessionId: string | null;
  busy?: boolean;
  onClose: () => void;
  onComposited: (r: { generationId: string; width: number; height: number }) => void;
  onRemoveBg: (
    generationId: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  onUpscale: (
    generationId: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 부위 추출(오려내기) — generationId 에서 prompt 부위를 투명 PNG 로 분리. 결과를 새 레이어로. */
  onExtract: (
    generationId: string,
    prompt: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 영역 편집(generative fill) — generationId + 마스크(dataUrl) + prompt 로 칠한 영역 재생성. */
  onInpaint: (
    generationId: string,
    maskDataUrl: string,
    prompt: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
};

let layerSeq = 0;
const newLayerId = () => `L${++layerSeq}-${Math.random().toString(36).slice(2, 6)}`;

function makeLayer(generationId: string): Layer {
  return {
    id: newLayerId(),
    generationId,
    x: 0,
    y: 0,
    scale: 1.0,
    stretchW: 1.0,
    stretchH: 1.0,
    rotation: 0,
    flipH: false,
    opacity: 100,
    filters: { ...FILTER_DEFAULT },
    visible: true,
  };
}

/** 레이어 CSS transform — 백엔드 sharp 순서(stretch/scale → rotate → flip)와 동일 배치로 WYSIWYG 근사. */
/** 원본 공간에 타원(rx,ry) 스탬프 — 화면에선 정원(비균일 늘이기 보정). */
function stampEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
) {
  ctx.beginPath();
  ctx.ellipse(x, y, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
  ctx.fill();
}

/** File → "data:image/...;base64,..." dataUrl. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function layerTransform(l: Layer): string {
  const sx = l.scale * l.stretchW;
  const sy = l.scale * l.stretchH;
  // CSS transform 은 우→좌로 적용 → scale(맨 오른쪽)=먼저, rotate, flip(scaleX(-1))=나중.
  // 백엔드 sharp 순서(scale→rotate→flip)와 일치시킨다. flip 을 sx 에 접어 넣으면 rotate 보다
  // 먼저 적용돼, 회전+반전 동시 레이어에서 baked 결과와 기울기 방향이 어긋난다(pipeline 경고).
  const flip = l.flipH ? "scaleX(-1) " : "";
  return `translate(-50%, -50%) translate(${l.x}px, ${l.y}px) ${flip}rotate(${l.rotation}deg) scale(${sx}, ${sy})`;
}

/** 레이어 필터 → CSS filter 문자열(라이브 미리보기용). 확정은 composite 의 filters 로 굽는다. */
function cssFilter(f: LayerFilters): string {
  return `brightness(${f.brightness}%) contrast(${f.contrast}%) saturate(${f.saturation}%) hue-rotate(${f.hue}deg) blur(${f.blur}px)`;
}

export function CanvasEditor({
  seedGenerationId,
  sessionId,
  busy,
  onClose,
  onComposited,
  onRemoveBg,
  onUpscale,
  onExtract,
  onInpaint,
}: Props) {
  // 레이어 스택 — 배열 순서 = z-order(마지막이 최상단). seed 를 첫 레이어로 lazy init.
  const [layers, setLayers] = useState<Layer[]>(() => [makeLayer(seedGenerationId)]);
  // 열자마자 씬(첫) 레이어를 선택해 둔다 — 도구(변형·필터·분리·영역편집 등)가 바로 보이도록.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(() => layers[0]?.id ?? null);
  const [presetIdx, setPresetIdx] = useState(0);
  const [customSize, setCustomSize] = useState<CanvasSize>({ w: 1024, h: 1024 });
  const [assets, setAssets] = useState<Generation[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 에셋 피커 소스 탭 — 이 세션 / 갤러리(전체 세션). 갤러리는 lazy 로드.
  const [pickerTab, setPickerTab] = useState<"session" | "gallery">("session");
  const [galleryAssets, setGalleryAssets] = useState<Generation[]>([]);
  const [uploading, setUploading] = useState(false);
  // 캔버스 드롭(외부 이미지) 오버레이.
  const [dropOver, setDropOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 레이어 레일 드래그 정렬 중인 행 — 시각 피드백.
  const [draggingRowId, setDraggingRowId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  // 선택 레이어 단일 작업 진행 상태 — 배경제거/업스케일(AI) · 여백제거(sharp). 동시 실행 방지.
  const [layerOp, setLayerOp] = useState<null | "bg" | "upscale" | "trim">(null);
  // 분리(오려내기) — 부위명 입력 + 진행 상태. 추출 결과는 새 레이어로 추가.
  const [extractInput, setExtractInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  // 영역 편집(generative fill) — 활성 레이어 id(null=꺼짐) + 프롬프트/브러시/진행. 마스크는 소스 해상도 캔버스.
  const [inpaintLayerId, setInpaintLayerId] = useState<string | null>(null);
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [inpaintBrush, setInpaintBrush] = useState(40);
  const [inpaintBusy, setInpaintBusy] = useState(false);
  // 인페인트 대상 레이어의 원본 픽셀 크기 — 마스크 캔버스 해상도(선언적으로 박아 기본 300 버그 회피).
  const [inpaintNat, setInpaintNat] = useState<{ w: number; h: number } | null>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushDrawingRef = useRef(false);
  const brushLastRef = useRef<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const zp = useZoomPan();

  // undo/redo — 커밋 시점(드래그 끝/이산 동작)에만 스냅샷 push. pointermove 마다 push 금지.
  // 스택은 ref(렌더 무관)에 보관하되, 버튼 disabled 용 길이는 state 로 미러(render 중 ref 접근 금지).
  const undoStack = useRef<Snapshot[]>([]);
  const redoStack = useRef<Snapshot[]>([]);
  const [undoLen, setUndoLen] = useState(0);
  const [redoLen, setRedoLen] = useState(0);
  const syncStackLens = useCallback(() => {
    setUndoLen(undoStack.current.length);
    setRedoLen(redoStack.current.length);
  }, []);

  const selected = layers.find(l => l.id === selectedLayerId) ?? null;
  const preset = SIZE_PRESETS[presetIdx];
  // 출력 캔버스 px. 프리셋이 자유(0)면 커스텀 입력값 사용.
  const canvasSize: CanvasSize = useMemo(
    () => (preset.w && preset.h ? { w: preset.w, h: preset.h } : customSize),
    [preset.w, preset.h, customSize],
  );

  // 에셋 피커 로드 — composite 결과는 재합성 대상에서 제외(SceneComposer 와 동일).
  useEffect(() => {
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens => setAssets(gens.filter(g => g.kind !== "composite")))
      .catch(() => {});
  }, [sessionId]);

  // ── undo/redo ──────────────────────────────────────────────────────────────
  const snapshot = useCallback(
    (): Snapshot => ({ layers, canvasSize, selectedLayerId }),
    [layers, canvasSize, selectedLayerId],
  );

  // 변경 직전 상태를 undo 스택에 적재(redo 무효화). 드래그 끝/이산 동작에서 1회 호출.
  const pushUndo = useCallback(() => {
    undoStack.current.push(snapshot());
    redoStack.current = [];
    syncStackLens();
  }, [snapshot, syncStackLens]);

  const applySnap = useCallback((s: Snapshot) => {
    setLayers(s.layers);
    setSelectedLayerId(s.selectedLayerId);
    // canvasSize 는 preset/custom 으로 파생되므로 커스텀에 반영(프리셋 자유 모드에서만 시각 효과).
    setCustomSize(s.canvasSize);
  }, []);

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(snapshot());
    applySnap(prev);
    syncStackLens();
  }, [snapshot, applySnap, syncStackLens]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(snapshot());
    applySnap(next);
    syncStackLens();
  }, [snapshot, applySnap, syncStackLens]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  // ── 레이어 조작 ──────────────────────────────────────────────────────────────
  const patchLayer = useCallback((id: string, patch: Partial<Layer>) => {
    setLayers(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const addAsset = useCallback(
    (g: Generation) => {
      if (layers.some(l => l.generationId === g.id)) return;
      pushUndo();
      const layer = makeLayer(g.id);
      setLayers(prev => [...prev, layer]);
      setSelectedLayerId(layer.id);
      setPickerOpen(false);
    },
    [layers, pushUndo],
  );

  // 외부 이미지 파일 → 업로드 → 새 레이어. (파일 선택 · 캔버스 드롭 공용)
  const addUploadedFile = useCallback(
    async (file: File) => {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return;
      setUploading(true);
      setError(null);
      try {
        const dataUrl = await fileToDataUrl(file);
        const res = await uploadImage({ dataUrl, sessionId, filename: file.name });
        pushUndo();
        const layer = makeLayer(res.generationId);
        setLayers(prev => [...prev, layer]);
        setSelectedLayerId(layer.id);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading(false);
      }
    },
    [sessionId, pushUndo],
  );

  // 갤러리(전체 세션) 에셋 lazy 로드 — 탭 전환 시 1회. composite 결과 제외.
  useEffect(() => {
    if (pickerTab !== "gallery" || galleryAssets.length > 0) return;
    listGenerations({ limit: 100 })
      .then(gens => setGalleryAssets(gens.filter(g => g.kind !== "composite")))
      .catch(() => {});
  }, [pickerTab, galleryAssets.length]);

  const removeLayer = useCallback(
    (id: string) => {
      pushUndo();
      setLayers(prev => prev.filter(l => l.id !== id));
      setSelectedLayerId(sel => (sel === id ? null : sel));
    },
    [pushUndo],
  );

  const toggleVisible = useCallback(
    (id: string) => {
      pushUndo();
      setLayers(prev => prev.map(l => (l.id === id ? { ...l, visible: !l.visible } : l)));
    },
    [pushUndo],
  );

  const setOpacity = useCallback(
    (id: string, opacity: number) => patchLayer(id, { opacity }),
    [patchLayer],
  );

  // 선택 레이어 변형 리셋(↺) — 위치·배율·늘이기·회전·반전을 중립으로.
  const resetTransform = useCallback(
    (id: string) => {
      pushUndo();
      patchLayer(id, { x: 0, y: 0, scale: 1, stretchW: 1, stretchH: 1, rotation: 0, flipH: false });
    },
    [pushUndo, patchLayer],
  );

  const flipSelected = useCallback(
    (id: string) => {
      pushUndo();
      setLayers(prev => prev.map(l => (l.id === id ? { ...l, flipH: !l.flipH } : l)));
    },
    [pushUndo],
  );

  // ── 필터(라이브 = CSS, 확정 = composite filters) ──────────────────────────────
  const setFilter = useCallback(
    (id: string, key: keyof LayerFilters, value: number) => {
      setLayers(prev =>
        prev.map(l => (l.id === id ? { ...l, filters: { ...l.filters, [key]: value } } : l)),
      );
    },
    [],
  );

  const resetFilters = useCallback(
    (id: string) => {
      pushUndo();
      patchLayer(id, { filters: { ...FILTER_DEFAULT } });
    },
    [pushUndo, patchLayer],
  );

  // ── 선택 레이어 단일 작업(배경제거·업스케일·여백제거) — 반환 id 로 generationId 교체. 슬롯 id 유지. ──
  // 배경제거/업스케일은 AI(콜백, 채팅 경유), 여백제거는 결정적(sharp /api/filter). 모두 결과로 레이어 교체.
  const runLayerOp = useCallback(
    async (op: "bg" | "upscale" | "trim", id: string) => {
      const layer = layers.find(l => l.id === id);
      if (!layer || layerOp) return;
      setLayerOp(op);
      setError(null);
      try {
        const r =
          op === "bg"
            ? await onRemoveBg(layer.generationId)
            : op === "upscale"
              ? await onUpscale(layer.generationId)
              : await filterImage({ generationId: layer.generationId, filter: "trim" });
        if (r) {
          pushUndo();
          patchLayer(id, { generationId: r.generationId });
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLayerOp(null);
      }
    },
    [layers, layerOp, onRemoveBg, onUpscale, pushUndo, patchLayer],
  );

  // ── 분리(오려내기) — 선택 레이어에서 부위명(쉼표 구분)을 추출해 각각 새 레이어로 추가 ──────────
  // 텍스트 기반(extractObject, 마스크 없음) — 기존 레이어 분리 경로 재사용. 원본 레이어는 유지.
  const handleExtract = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || extracting) return;
    const parts = extractInput.split(",").map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) return;
    setExtracting(true);
    setError(null);
    try {
      let pushed = false;
      for (const part of parts) {
        const r = await onExtract(layer.generationId, part);
        if (r) {
          if (!pushed) {
            pushUndo();
            pushed = true;
          }
          const nl = makeLayer(r.generationId);
          setLayers(prev => [...prev, nl]);
          setSelectedLayerId(nl.id);
        }
      }
      setExtractInput("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, extracting, extractInput, onExtract, pushUndo]);

  // ── 영역 편집(generative fill) — 선택 레이어 위에 마스크를 칠하고 프롬프트로 재생성 ──────────
  // 소스 해상도 캔버스에 #ff0000 으로 칠하고, export 시 검정 배경 + 빨강 = 인페인트 영역(MaskCanvas 포맷).
  const exitInpaint = useCallback(() => {
    setInpaintLayerId(null);
    setInpaintPrompt("");
    setInpaintNat(null);
    const c = brushCanvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, []);
  const clearBrush = useCallback(() => {
    const c = brushCanvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, []);
  // 화면 포인터 → 레이어 원본 픽셀 좌표(점 단위 역변환 — 비트맵 회전 없이 정밀).
  // 레이어 중심은 회전과 무관하게 캔버스 bbox 중심과 일치 → 거기서 un-flip → un-rotate → un-scale.
  const screenToSource = useCallback(
    (canvas: HTMLCanvasElement, clientX: number, clientY: number, layer: Layer) => {
      const rect = canvas.getBoundingClientRect();
      const cx = (rect.left + rect.right) / 2;
      const cy = (rect.top + rect.bottom) / 2;
      let dx = clientX - cx;
      const dy = clientY - cy;
      if (layer.flipH) dx = -dx; // un-flip (flip 은 최외곽 → 화면 x 부호 반전)
      const t = (layer.rotation * Math.PI) / 180;
      const cos = Math.cos(t);
      const sin = Math.sin(t);
      const ux = dx * cos + dy * sin; // rotate by -t
      const uy = -dx * sin + dy * cos;
      const f = canvas.offsetWidth / (canvas.width || 1); // 표시(레이아웃)폭 / 원본폭
      const sxScreen = f * layer.scale * layer.stretchW * zp.zoom || 1;
      const syScreen = f * layer.scale * layer.stretchH * zp.zoom || 1;
      // 화면 브러시 반경(원) → 원본 공간 축별 반경(타원). 비균일 늘이기여도 화면에선 정원으로 보인다.
      return {
        x: ux / sxScreen + canvas.width / 2,
        y: uy / syScreen + canvas.height / 2,
        rx: inpaintBrush / sxScreen,
        ry: inpaintBrush / syScreen,
      };
    },
    [zp.zoom, inpaintBrush],
  );

  const onBrushDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, layer: Layer) => {
      const canvas = e.currentTarget;
      const ctx = canvas.getContext("2d");
      if (!ctx || !canvas.width) return;
      e.preventDefault();
      e.stopPropagation();
      brushDrawingRef.current = true;
      ctx.fillStyle = "#ff0000";
      const p = screenToSource(canvas, e.clientX, e.clientY, layer);
      stampEllipse(ctx, p.x, p.y, p.rx, p.ry);
      brushLastRef.current = { x: p.x, y: p.y };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    },
    [screenToSource],
  );
  const onBrushMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, layer: Layer) => {
      if (!brushDrawingRef.current) return;
      const ctx = e.currentTarget.getContext("2d");
      if (!ctx) return;
      const p = screenToSource(e.currentTarget, e.clientX, e.clientY, layer);
      const last = brushLastRef.current ?? { x: p.x, y: p.y };
      // last → 현재 점 사이를 타원으로 보간 스탬프(끊김 없이 균일 굵기).
      const dx = p.x - last.x;
      const dy = p.y - last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, Math.min(p.rx, p.ry) / 2);
      const n = Math.ceil(dist / step);
      for (let i = 1; i <= n; i++) {
        stampEllipse(ctx, last.x + (dx * i) / n, last.y + (dy * i) / n, p.rx, p.ry);
      }
      brushLastRef.current = { x: p.x, y: p.y };
    },
    [screenToSource],
  );
  const onBrushUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    brushDrawingRef.current = false;
    brushLastRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  const handleInpaintSubmit = useCallback(async () => {
    const layer = layers.find(l => l.id === inpaintLayerId);
    const canvas = brushCanvasRef.current;
    if (!layer || !canvas || inpaintBusy || !inpaintPrompt.trim()) return;
    // export: 소스 해상도 검정 배경 + 빨강 칠.
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.fillStyle = "#000000";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    const maskDataUrl = out.toDataURL("image/png");
    setInpaintBusy(true);
    setError(null);
    try {
      const r = await onInpaint(layer.generationId, maskDataUrl, inpaintPrompt.trim());
      if (r) {
        pushUndo();
        patchLayer(layer.id, { generationId: r.generationId });
        exitInpaint();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setInpaintBusy(false);
    }
  }, [layers, inpaintLayerId, inpaintBusy, inpaintPrompt, onInpaint, pushUndo, patchLayer, exitInpaint]);

  // ── 레이어 레일 드래그 정렬 → 배열 순서(z) 동기화 ────────────────────────────────
  const reorderDragRef = useRef<string | null>(null);
  const onRailGripDown = useCallback(
    (e: React.PointerEvent, id: string) => {
      e.preventDefault();
      e.stopPropagation();
      const grip = e.currentTarget as HTMLElement;
      const rail = grip.closest("[data-rail]");
      if (!rail) return;
      pushUndo();
      reorderDragRef.current = id;
      setDraggingRowId(id);
      // pointer capture — 행이 재정렬되며 커서 밑 요소가 바뀌어도 move 가 끊기지 않게.
      try {
        grip.setPointerCapture(e.pointerId);
      } catch {}
      const onMove = (ev: PointerEvent) => {
        const dragId = reorderDragRef.current;
        if (!dragId) return;
        const rows = [...rail.querySelectorAll<HTMLElement>("[data-lrow]")].filter(
          r => r.dataset.lid !== dragId,
        );
        // 커서 위(midpoint 기준)에 있는 첫 행. 그 행 "위"(화면)에 삽입.
        const afterEl = rows.find(r => {
          const b = r.getBoundingClientRect();
          return ev.clientY < b.top + b.height / 2;
        });
        const afterId = afterEl?.dataset.lid ?? null;
        // 레일은 위→아래로 z-역순 표시(맨 위 = 최상단). 배열은 마지막이 최상단이므로 역으로 매핑.
        setLayers(prev => {
          const moved = prev.find(l => l.id === dragId);
          if (!moved) return prev;
          const next = prev.filter(l => l.id !== dragId);
          if (afterId === null) {
            // 화면 맨 아래로 → 배열 맨 앞(최하단).
            return [moved, ...next];
          }
          const idx = next.findIndex(l => l.id === afterId);
          if (idx < 0) return prev;
          // afterId 행 "위"에 삽입(화면) = 배열에서 그 뒤(더 위 z).
          return [...next.slice(0, idx + 1), moved, ...next.slice(idx + 1)];
        });
      };
      const onUp = (ev: PointerEvent) => {
        reorderDragRef.current = null;
        setDraggingRowId(null);
        try {
          grip.releasePointerCapture(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pushUndo],
  );

  // ── 자유 변형 (선택 레이어 핸들) ───────────────────────────────────────────────
  // 핸들 종류: corner=균일 scale(중심 기준) · l/r/t/b=변별 늘이기(반대 변 앵커, 포토샵식) · rot=회전.
  // 스테이지 중심 기준 local 좌표(역회전 투영, client px). 변 늘이기는 그랩 시점 로컬 반치수(hw0/hh0)를
  // 기준으로 그랩 변만 이동시키고, 반대 변이 고정되도록 레이어 중심(x/y)도 함께 옮긴다(frame px = client/zoom).
  const stageRef = useRef<HTMLDivElement>(null);
  const tfDragRef = useRef<{
    type: "corner" | "l" | "r" | "t" | "b" | "rot";
    scale0: number;
    sw0: number;
    sh0: number;
    sum0: number; // corner 비율 기준
    hw0: number; // 그랩 시점 로컬 반폭 |llx0| (client px)
    hh0: number; // 그랩 시점 로컬 반높이 |lly0|
    x0: number; // 레이어 시작 x/y (frame px)
    y0: number;
    zoom: number;
    rot: number; // rad (양의 회전각)
    cx: number;
    cy: number;
  } | null>(null);

  const onHandleDown = useCallback(
    (e: React.PointerEvent, type: "corner" | "l" | "r" | "t" | "b" | "rot", layer: Layer) => {
      e.preventDefault();
      e.stopPropagation();
      const frame = stageRef.current?.querySelector<HTMLElement>("[data-canvas-frame]");
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      // 캔버스 프레임 중심(client). getBoundingClientRect 는 zoom/pan 반영됨.
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // 역회전 투영으로 local 좌표 산출 (client px). 그랩 변 핸들은 로컬 변 위치에 있으므로
      // |lx|≈반폭, |ly|≈반높이.
      const rot = (layer.rotation * Math.PI) / 180;
      const a = -rot;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const lx = dx * Math.cos(a) - dy * Math.sin(a);
      const ly = dx * Math.sin(a) + dy * Math.cos(a);
      tfDragRef.current = {
        type,
        scale0: layer.scale,
        sw0: layer.stretchW,
        sh0: layer.stretchH,
        sum0: Math.abs(lx) + Math.abs(ly) || 1,
        hw0: Math.abs(lx) || 1,
        hh0: Math.abs(ly) || 1,
        x0: layer.x,
        y0: layer.y,
        zoom: zp.zoom,
        rot,
        cx,
        cy,
      };
      pushUndo();
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {}

      const onMove = (ev: PointerEvent) => {
        const d = tfDragRef.current;
        if (!d) return;
        const ar = -d.rot;
        const ddx = ev.clientX - d.cx;
        const ddy = ev.clientY - d.cy;
        if (d.type === "rot") {
          // atan2 는 scale-invariant — zoom 보정 불필요. 상단 노브가 12시를 가리키게 +90°.
          const r = (Math.atan2(ddy, ddx) * 180) / Math.PI + 90;
          patchLayer(layer.id, { rotation: Math.round(r) });
          return;
        }
        const llx = ddx * Math.cos(ar) - ddy * Math.sin(ar);
        const lly = ddx * Math.sin(ar) + ddy * Math.cos(ar);
        if (d.type === "corner") {
          // 모서리 → 비율 유지 균일 scale(중심 기준).
          const f = (Math.abs(llx) + Math.abs(lly)) / d.sum0;
          patchLayer(layer.id, { scale: Math.max(0.1, d.scale0 * f) });
          return;
        }
        if (d.type === "l" || d.type === "r") {
          // 좌·우 변 → 반대 변 고정, 그랩 변만 이동. sign: 오른쪽=+1, 왼쪽=-1.
          const sign = d.type === "r" ? 1 : -1;
          const newW = Math.max(8, d.hw0 + sign * llx); // 그랩 변 위치(llx) ↔ 반대 변(-sign*hw0) 사이 폭
          const stretchW = Math.max(0.1, (d.sw0 * newW) / (2 * d.hw0));
          // 중심이 로컬 x 로 sign*(newW/2 - hw0) 만큼 이동(반대 변 고정). frame px 환산 후 회전.
          const shift = (sign * (newW / 2 - d.hw0)) / d.zoom;
          patchLayer(layer.id, {
            stretchW,
            x: d.x0 + shift * Math.cos(d.rot),
            y: d.y0 + shift * Math.sin(d.rot),
          });
        } else {
          // 상·하 변 → 반대 변 고정, 그랩 변만 이동. sign: 아래=+1, 위=-1.
          const sign = d.type === "b" ? 1 : -1;
          const newH = Math.max(8, d.hh0 + sign * lly);
          const stretchH = Math.max(0.1, (d.sh0 * newH) / (2 * d.hh0));
          const shift = (sign * (newH / 2 - d.hh0)) / d.zoom;
          patchLayer(layer.id, {
            stretchH,
            x: d.x0 - shift * Math.sin(d.rot),
            y: d.y0 + shift * Math.cos(d.rot),
          });
        }
      };
      const onUp = (ev: PointerEvent) => {
        tfDragRef.current = null;
        try {
          (e.currentTarget as Element).releasePointerCapture(ev.pointerId);
        } catch {}
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pushUndo, patchLayer, zp.zoom],
  );

  // 휠/트랙패드 줌 — 커서 위치 기준(zoomAtPoint). 네이티브 리스너 + passive:false 로 페이지 스크롤 차단.
  const { zoomAtPoint } = zp;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAtPoint(el, e.clientX, e.clientY, e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAtPoint]);

  // ── 레이어 본체 드래그 = 이동 (선택). client delta → canvas px 는 zoom 으로 역산. ──────
  const moveDragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onLayerBodyDown = useCallback(
    (e: React.PointerEvent, layer: Layer) => {
      e.preventDefault();
      e.stopPropagation();
      setSelectedLayerId(layer.id);
      pushUndo();
      moveDragRef.current = { sx: e.clientX, sy: e.clientY, ox: layer.x, oy: layer.y };
      const zoom = zp.zoom;
      const onMove = (ev: PointerEvent) => {
        const d = moveDragRef.current;
        if (!d) return;
        patchLayer(layer.id, {
          x: d.ox + (ev.clientX - d.sx) / zoom,
          y: d.oy + (ev.clientY - d.sy) / zoom,
        });
      };
      const onUp = () => {
        moveDragRef.current = null;
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [zp.zoom, pushUndo, patchLayer],
  );

  // ── 합치기 → /api/composite (레이어별 transform + filters 전부 포함) ───────────────
  const handleComposite = useCallback(async () => {
    if (layers.length === 0 || composing) return;
    setComposing(true);
    setError(null);
    try {
      const visibleLayers = layers.filter(l => l.visible);
      const result = await compositeScene({
        layers: visibleLayers.map(l => ({
          generationId: l.generationId,
          opacity: l.opacity,
          x: l.x,
          y: l.y,
          scale: l.scale,
          rotation: l.rotation,
          flipH: l.flipH,
          stretchW: l.stretchW,
          stretchH: l.stretchH,
          filters: {
            brightness: l.filters.brightness,
            saturation: l.filters.saturation,
            hue: l.filters.hue,
            contrast: l.filters.contrast,
            blur: l.filters.blur,
          },
        })),
        sessionId: sessionId ?? undefined,
        outputWidth: preset.w || customSize.w || undefined,
        outputHeight: preset.h || customSize.h || undefined,
      });
      onComposited(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComposing(false);
    }
  }, [layers, composing, sessionId, preset.w, preset.h, customSize, onComposited]);

  // 스테이지에 표시할 프레임 크기 — 출력 종횡비를 고정 영역에 contain-fit.
  const aspect = canvasSize.w && canvasSize.h ? canvasSize.w / canvasSize.h : 4 / 3;

  // 레일은 위→아래로 z-역순 표시(맨 위 = 최상단 = 배열 마지막).
  const railLayers = [...layers].reverse();

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg-card">
      {/* 상단바: 대화 복귀 + 세션 맥락 + undo/redo */}
      <header className="flex h-[50px] flex-none items-center gap-3 border-b border-border px-3.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-text-muted hover:bg-bg-panel hover:text-text-primary"
          title="작업 결과는 이 대화 타임라인에 기록됩니다"
        >
          <ArrowLeft size={14} /> 대화로 돌아가기
        </button>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium text-text-primary">캔버스 편집</span>
          <span className="text-[11px] text-text-muted">합친 결과는 이 대화에 기록됩니다</span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={undo}
            disabled={undoLen === 0}
            className="rounded p-1.5 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:opacity-30"
            title="실행 취소 (⌘Z)"
          >
            <Undo2 size={15} />
          </button>
          <button
            onClick={redo}
            disabled={redoLen === 0}
            className="rounded p-1.5 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:opacity-30"
            title="다시 실행 (⌘⇧Z)"
          >
            <Redo2 size={15} />
          </button>
        </div>
      </header>

      {/* 도구 스트립 — 출력 규격 + 레이어 추가 */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
        <span className="text-text-muted">출력</span>
        <select
          value={presetIdx}
          onChange={e => setPresetIdx(Number(e.target.value))}
          className="h-7 rounded-lg border border-border bg-bg-panel px-2 text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
        >
          {SIZE_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        {!preset.w && (
          <span className="flex items-center gap-1 text-text-muted">
            <input
              type="number"
              min={1}
              value={customSize.w}
              onChange={e => setCustomSize(s => ({ ...s, w: Math.max(1, Number(e.target.value)) }))}
              className="h-7 w-16 rounded-md border border-border bg-bg-panel px-1.5 text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
            />
            ×
            <input
              type="number"
              min={1}
              value={customSize.h}
              onChange={e => setCustomSize(s => ({ ...s, h: Math.max(1, Number(e.target.value)) }))}
              className="h-7 w-16 rounded-md border border-border bg-bg-panel px-1.5 text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
            />
          </span>
        )}
        <span className="ml-2 text-text-muted/60">
          {canvasSize.w}×{canvasSize.h}
        </span>
      </div>

      {/* 선택 레이어 도구 (상단 툴바) — 변형 · 생성형 액션 · 분리. 레이어 선택 시에만 표시. */}
      {selected && (
        <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-border px-3.5 py-2 text-xs">
          <button
            onClick={() => flipSelected(selected.id)}
            className={`rounded-md border px-2 py-1 text-[11px] ${
              selected.flipH
                ? "border-[color:var(--accent)] text-text-primary"
                : "border-border text-text-muted hover:text-text-primary"
            }`}
            title="좌우반전"
          >
            ↔ 반전
          </button>
          <button
            onClick={() => resetTransform(selected.id)}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
            title="위치·크기·회전 리셋"
          >
            <RotateCcw size={11} /> 리셋
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <button
            onClick={() => runLayerOp("bg", selected.id)}
            disabled={!!layerOp}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
            title="선택 레이어의 배경을 투명하게 (AI)"
          >
            <Sparkles size={11} /> 배경 제거
          </button>
          <button
            onClick={() => runLayerOp("upscale", selected.id)}
            disabled={!!layerOp}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
            title="선택 레이어를 고화질로 업스케일 (AI)"
          >
            <Sparkles size={11} /> 업스케일
          </button>
          <button
            onClick={() => runLayerOp("trim", selected.id)}
            disabled={!!layerOp}
            className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
            title="선택 레이어의 투명 여백을 잘라냄 (sharp)"
          >
            <Scissors size={11} /> 여백 제거
          </button>
          <button
            onClick={() => {
              setInpaintPrompt("");
              setInpaintNat(null);
              const im = new window.Image();
              im.onload = () => setInpaintNat({ w: im.naturalWidth, h: im.naturalHeight });
              im.src = `/api/images/${selected.generationId}`;
              setInpaintLayerId(selected.id);
            }}
            className="flex items-center gap-1 rounded-md border border-[color:var(--accent)]/45 px-2 py-1 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
            title="영역 편집 — 칠한 영역을 프롬프트로 다시 그림 (generative fill)"
          >
            <Wand2 size={11} /> 영역 편집
          </button>
          <span className="mx-1 h-4 w-px bg-border" />
          <input
            value={extractInput}
            onChange={e => setExtractInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") handleExtract();
            }}
            placeholder="분리할 부위 (예: 머리, 무기)"
            disabled={extracting}
            className="h-7 w-40 rounded-md border border-border bg-bg-panel px-2 text-[11px] text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none"
          />
          <button
            onClick={handleExtract}
            disabled={extracting || !extractInput.trim()}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[color:var(--accent)]/45 px-2 py-1 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10 disabled:opacity-40"
            title="부위를 AI로 추출해 새 레이어로 추가 (쉼표로 여러 부위)"
          >
            {extracting ? <Loader2 size={11} className="animate-spin" /> : <Scissors size={11} />} 분리
          </button>
        </div>
      )}

      {/* 본문: 스테이지 + 레이어 레일 */}
      <div className="flex min-h-0 flex-1">
        {/* 스테이지 */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div
            ref={stageRef}
            className="relative m-4 flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-[#0c0c0d]"
            onDragOver={e => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              if (!dropOver) setDropOver(true);
            }}
            onDragLeave={e => {
              // 자식으로 이동 시의 leave 무시 — 컨테이너 밖으로 나갈 때만 해제.
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setDropOver(false);
            }}
            onDrop={e => {
              if (!e.dataTransfer.types.includes("Files")) return;
              e.preventDefault();
              setDropOver(false);
              const f = [...e.dataTransfer.files].find(x => /^image\/(png|jpeg|webp)$/.test(x.type));
              if (f) addUploadedFile(f);
            }}
          >
            {dropOver && (
              <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-bg-app/70 backdrop-blur-sm">
                <div className="rounded-2xl border-2 border-dashed border-[color:var(--accent)] bg-bg-card px-7 py-5 text-center shadow-xl">
                  <div className="text-2xl">🖼</div>
                  <div className="mt-1.5 text-sm font-medium text-text-primary">여기에 드롭해 레이어 추가</div>
                  <div className="text-xs text-text-muted">PNG · JPEG · WebP</div>
                </div>
              </div>
            )}
            <div
              style={{
                transform: `translate(${zp.pan.x}px, ${zp.pan.y}px) scale(${zp.zoom})`,
                transformOrigin: "center",
              }}
            >
              {/* 출력 캔버스 — 설정 사이즈를 종횡비로 표시. wrap 은 핸들 오버레이의 좌표 기준. */}
              <div className="relative" style={{ width: "min(56vw, 640px)", aspectRatio: aspect }}>
                {/* 아트보드(클립) — 체커보드 = 투명 배경. overflow-hidden 으로 캔버스 밖 픽셀을 잘라
                    합성 출력(outputW/H 크롭)과 WYSIWYG. 핸들은 아래 오버레이(클립 밖)에서 렌더. */}
                <div
                  data-canvas-frame
                  className="checkerboard absolute inset-0 overflow-hidden outline outline-2 outline-white/80"
                  onPointerDown={() => setSelectedLayerId(null)}
                >
                  {layers.map(layer => (
                    <div
                      key={layer.id}
                      className={layer.id === selectedLayerId ? "cursor-move" : "cursor-pointer"}
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: layerTransform(layer),
                        opacity: layer.visible ? layer.opacity / 100 : 0,
                        pointerEvents: layer.visible ? "auto" : "none",
                      }}
                      onPointerDown={e => onLayerBodyDown(e, layer)}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/images/${layer.generationId}`}
                        alt={layer.generationId}
                        className="block max-w-[min(56vw,640px)]"
                        style={{ filter: cssFilter(layer.filters), pointerEvents: "none" }}
                        draggable={false}
                      />
                      {/* 영역 편집 인라인 마스크 — 레이어와 같은 transform 을 CSS 가 적용(표시),
                          포인터는 점-좌표 역변환으로 원본 픽셀에 칠한다(정밀). 내부 res = 원본. */}
                      {inpaintLayerId === layer.id && inpaintNat && (
                        <canvas
                          ref={brushCanvasRef}
                          width={inpaintNat.w}
                          height={inpaintNat.h}
                          className="absolute inset-0 h-full w-full cursor-crosshair opacity-50"
                          style={{ touchAction: "none" }}
                          onPointerDown={e => onBrushDown(e, layer)}
                          onPointerMove={e => onBrushMove(e, layer)}
                          onPointerUp={onBrushUp}
                        />
                      )}
                    </div>
                  ))}
                </div>

                {/* 선택 레이어 자유변형 핸들 — 클립 밖 오버레이라 캔버스 경계를 넘은 핸들도 잡힌다.
                    숨김 이미지로 레이어 박스 크기를 맞춰 핸들 위치 기준을 잡는다. */}
                {selected && !inpaintLayerId && (
                  <div className="pointer-events-none absolute inset-0">
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        top: "50%",
                        transform: layerTransform(selected),
                      }}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/images/${selected.generationId}`}
                        alt=""
                        aria-hidden
                        className="block max-w-[min(56vw,640px)]"
                        style={{ visibility: "hidden", pointerEvents: "none" }}
                        draggable={false}
                      />
                      <div className="pointer-events-none absolute inset-0 outline outline-[1.5px] [outline-style:dashed] outline-[color:var(--accent)]" />
                      {(["tl", "tr", "bl", "br"] as const).map(c => (
                        <div
                          key={c}
                          onPointerDown={e => onHandleDown(e, "corner", selected)}
                          className="pointer-events-auto absolute h-3 w-3 rounded-[2px] border-[1.5px] border-[color:var(--accent)] bg-white"
                          style={{
                            left: c.includes("l") ? -6 : undefined,
                            right: c.includes("r") ? -6 : undefined,
                            top: c.includes("t") ? -6 : undefined,
                            bottom: c.includes("b") ? -6 : undefined,
                            cursor: c === "tl" || c === "br" ? "nwse-resize" : "nesw-resize",
                          }}
                        />
                      ))}
                      {(["t", "b"] as const).map(v => (
                        <div
                          key={v}
                          onPointerDown={e => onHandleDown(e, v, selected)}
                          className="pointer-events-auto absolute h-3 w-3 -translate-x-1/2 rounded-[2px] border-[1.5px] border-[color:var(--accent)] bg-white"
                          style={{ left: "50%", top: v === "t" ? -6 : undefined, bottom: v === "b" ? -6 : undefined, cursor: "ns-resize" }}
                        />
                      ))}
                      {(["l", "r"] as const).map(h => (
                        <div
                          key={h}
                          onPointerDown={e => onHandleDown(e, h, selected)}
                          className="pointer-events-auto absolute h-3 w-3 -translate-y-1/2 rounded-[2px] border-[1.5px] border-[color:var(--accent)] bg-white"
                          style={{ top: "50%", left: h === "l" ? -6 : undefined, right: h === "r" ? -6 : undefined, cursor: "ew-resize" }}
                        />
                      ))}
                      <div
                        onPointerDown={e => onHandleDown(e, "rot", selected)}
                        className="pointer-events-auto absolute left-1/2 h-[13px] w-[13px] -translate-x-1/2 cursor-grab rounded-full border-[1.5px] border-[color:var(--accent)] bg-white"
                        style={{ top: -30 }}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
            {/* 범례 */}
            <div className="pointer-events-none absolute left-3.5 top-3 rounded-lg border border-border bg-black/55 px-2.5 py-1.5 text-[11px] text-text-muted">
              <b className="text-white">모서리</b> = <span className="text-[color:var(--accent)]">크기</span> ·{" "}
              <b className="text-white">변</b> = <span className="text-[color:var(--accent)]">늘이기</span> ·{" "}
              <b className="text-white">노브</b> = <span className="text-[color:var(--accent)]">회전</span>
            </div>
            {layerOp && (
              <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/50 text-xs text-text-primary">
                <Loader2 size={18} className="mr-2 animate-spin" />{" "}
                {layerOp === "bg" ? "배경 제거 중…" : layerOp === "upscale" ? "업스케일 중…" : "여백 제거 중…"}
              </div>
            )}
            {/* 줌 컨트롤(휠 줌과 동일 상태) — 모드 토글 없음. 편집은 항상 활성. */}
            <div className="absolute bottom-2 right-2 z-30 flex items-center gap-1 rounded-lg border border-border bg-bg-panel/90 p-1 text-xs shadow-lg backdrop-blur">
              <button
                onClick={zp.zoomOut}
                className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="줌 아웃"
              >
                <ZoomOut size={14} />
              </button>
              <button
                onClick={zp.resetView}
                className="w-11 tabular-nums text-text-muted hover:text-text-primary"
                title="100% 로 리셋"
              >
                {Math.round(zp.zoom * 100)}%
              </button>
              <button
                onClick={zp.zoomIn}
                className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
                title="줌 인"
              >
                <ZoomIn size={14} />
              </button>
            </div>
          </div>
        </div>

        {/* 레이어 레일 + 하단 필터 */}
        <aside className="flex w-[256px] flex-none flex-col border-l border-border bg-bg-panel">
          <div className="flex items-center border-b border-border px-3 py-2.5 text-xs font-semibold">
            <span>레이어 ({layers.length})</span>
            <button
              onClick={() => setPickerOpen(o => !o)}
              className="ml-auto flex items-center gap-1 rounded-md border border-[color:var(--accent)]/45 px-2 py-0.5 text-[11px] text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
            >
              <Plus size={11} /> 레이어
            </button>
          </div>

          {/* 에셋 피커 — 이 세션 / 갤러리(전체) / 외부 파일 업로드 */}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) addUploadedFile(f);
              if (e.target) e.target.value = "";
            }}
          />
          {pickerOpen && (
            <div className="border-b border-border p-2">
              <div className="mb-1.5 flex items-center gap-1 text-[11px] font-medium">
                <button
                  onClick={() => setPickerTab("session")}
                  className={`rounded px-1.5 py-0.5 ${pickerTab === "session" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                >
                  이 세션
                </button>
                <button
                  onClick={() => setPickerTab("gallery")}
                  className={`rounded px-1.5 py-0.5 ${pickerTab === "gallery" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                >
                  갤러리
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-text-muted hover:text-text-primary disabled:opacity-50"
                  title="외부 이미지 파일 업로드"
                >
                  {uploading ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />} 업로드
                </button>
                <button
                  onClick={() => setPickerOpen(false)}
                  className="ml-auto text-text-muted hover:text-text-primary"
                >
                  <X size={12} />
                </button>
              </div>
              {(() => {
                const list = pickerTab === "session" ? assets : galleryAssets;
                if (list.length === 0) {
                  return (
                    <p className="text-[11px] text-text-muted/50">
                      {pickerTab === "session" ? "이 세션에 에셋이 없습니다. 업로드하거나 갤러리에서 가져오세요." : "갤러리가 비어 있습니다."}
                    </p>
                  );
                }
                return (
                  <div className="grid max-h-48 grid-cols-4 gap-1.5 overflow-y-auto">
                    {list.map(g => {
                      const used = layers.some(l => l.generationId === g.id);
                      return (
                        <button
                          key={g.id}
                          onClick={() => addAsset(g)}
                          disabled={used}
                          title={g.prompt ?? g.id}
                          className={`overflow-hidden rounded border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/8px_8px] ${
                            used
                              ? "cursor-default border-[color:var(--accent)] opacity-35"
                              : "border-border hover:border-[color:var(--accent)]"
                          }`}
                          style={{ aspectRatio: "1" }}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={`/api/thumbnails/${g.id}`}
                            alt={g.prompt ?? g.id}
                            className="h-full w-full object-contain"
                          />
                        </button>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          )}

          {/* 레이어 목록 (z-역순: 맨 위 = 최상단) */}
          <div data-rail className="flex-1 overflow-auto p-2">
            {railLayers.map(layer => {
              const isSel = layer.id === selectedLayerId;
              return (
                <div
                  key={layer.id}
                  data-lrow
                  data-lid={layer.id}
                  onClick={() => setSelectedLayerId(layer.id)}
                  className={`mb-1.5 flex cursor-pointer flex-col gap-1.5 rounded-lg border bg-bg-card p-2 ${
                    isSel ? "border-[color:var(--accent)]" : "border-border"
                  } ${draggingRowId === layer.id ? "opacity-50" : ""}`}
                >
                  <div className="flex items-center gap-1.5">
                    <span
                      onPointerDown={e => onRailGripDown(e, layer.id)}
                      onClick={e => e.stopPropagation()}
                      className="cursor-grab touch-none text-text-muted active:cursor-grabbing"
                      title="드래그로 순서 변경"
                    >
                      <GripVertical size={13} />
                    </span>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        toggleVisible(layer.id);
                      }}
                      className="text-text-muted hover:text-text-primary"
                      title={layer.visible ? "숨기기" : "표시"}
                    >
                      {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/thumbnails/${layer.generationId}`}
                      alt={layer.generationId}
                      className="h-6 w-6 shrink-0 rounded border border-border object-cover bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/6px_6px]"
                    />
                    <span className="flex-1 truncate text-xs text-text-primary">
                      {layer.generationId.slice(0, 8)}
                    </span>
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        removeLayer(layer.id);
                      }}
                      className="rounded p-0.5 text-text-muted hover:text-[color:var(--danger)]"
                      title="삭제"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-text-muted">불투명</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={layer.opacity}
                      onPointerDown={e => e.stopPropagation()}
                      onChange={e => setOpacity(layer.id, Number(e.target.value))}
                      className="flex-1 accent-[color:var(--accent)]"
                    />
                    <span className="w-8 text-right text-[10px] tabular-nums text-text-muted">
                      {layer.opacity}%
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 선택 레이어 변형/배경제거 액션 + 필터 */}
          <div className="flex-none border-t border-border bg-bg-card p-3">
            {selected ? (
              <>
                <div className="mb-1 flex items-center text-[11px] font-semibold">
                  필터
                  <button
                    onClick={() => resetFilters(selected.id)}
                    className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] font-normal text-text-muted hover:border-[color:var(--accent)] hover:text-text-primary"
                  >
                    리셋
                  </button>
                </div>
                {(
                  [
                    ["밝기", "brightness", 0, 200, "%"],
                    ["대비", "contrast", 0, 200, "%"],
                    ["채도", "saturation", 0, 200, "%"],
                    ["색조", "hue", -180, 180, "°"],
                    ["흐림", "blur", 0, 10, "px"],
                  ] as const
                ).map(([label, key, min, max, unit]) => (
                  <div key={key} className="flex items-center gap-2">
                    <label className="w-8 text-[11px] text-text-muted">{label}</label>
                    <input
                      type="range"
                      min={min}
                      max={max}
                      value={selected.filters[key]}
                      onChange={e => setFilter(selected.id, key, Number(e.target.value))}
                      className="flex-1 accent-[color:var(--accent)]"
                    />
                    <b className="w-11 text-right font-mono text-[10px] font-medium text-text-muted">
                      {selected.filters[key]}
                      {unit}
                    </b>
                  </div>
                ))}
                <p className="mt-1.5 text-[10px] text-text-muted">
                  실시간 미리보기 · 합치기 시 sharp 로 확정
                </p>
              </>
            ) : (
              <p className="text-[11px] text-text-muted/60">레이어를 선택하면 필터가 표시됩니다.</p>
            )}
          </div>
        </aside>
      </div>

      {error && (
        <p className="flex-none px-4 pb-1 text-[11px] text-[color:var(--danger)]">{error}</p>
      )}

      {/* 푸터: 취소 / 합치기 */}
      <footer className="flex flex-none gap-2 border-t border-border px-4 py-3">
        <button
          onClick={onClose}
          className="h-10 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        <button
          onClick={handleComposite}
          disabled={layers.length === 0 || composing || busy}
          className="flex h-10 flex-[2] items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          {composing ? (
            <>
              <Loader2 size={14} className="animate-spin" /> 합치는 중…
            </>
          ) : (
            `합치기 ▸ (${layers.length}개 레이어 → 1장)`
          )}
        </button>
      </footer>

      {/* 영역 편집(generative fill) — 인라인. 메인 캔버스의 선택 레이어 위에 직접 브러시질하고,
          아래 플로팅 바에서 브러시·프롬프트·실행. (브러시 캔버스는 layers.map 안 레이어 div 에 있음) */}
      {inpaintLayerId && (
        <div className="pointer-events-none absolute inset-x-0 bottom-[88px] z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-[780px] flex-wrap items-center gap-2 rounded-xl border border-[color:var(--accent)]/50 bg-bg-card/95 px-3 py-2 shadow-2xl backdrop-blur">
            <Wand2 size={14} className="text-[color:var(--accent)]" />
            <span className="text-[11px] font-medium text-text-primary">영역 편집</span>
            <span className="text-[11px] text-text-muted">레이어 위에 다시 그릴 영역을 칠하세요</span>
            <span className="ml-1 text-[11px] text-text-muted">브러시</span>
            <input
              type="range"
              min={5}
              max={120}
              value={inpaintBrush}
              onChange={e => setInpaintBrush(Number(e.target.value))}
              className="w-24 accent-[color:var(--accent)]"
            />
            <button
              onClick={clearBrush}
              className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
            >
              지우기
            </button>
            <input
              value={inpaintPrompt}
              onChange={e => setInpaintPrompt(e.target.value)}
              placeholder="무엇을 그릴까요? (예: 빛나는 룬 문양)"
              disabled={inpaintBusy}
              className="h-7 w-40 min-w-0 flex-1 rounded-md border border-border bg-bg-panel px-2 text-xs text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none"
            />
            <button
              onClick={handleInpaintSubmit}
              disabled={inpaintBusy || !inpaintPrompt.trim()}
              className="flex h-7 items-center gap-1.5 rounded-lg bg-[color:var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-40"
            >
              {inpaintBusy ? (
                <>
                  <Loader2 size={13} className="animate-spin" /> 생성 중…
                </>
              ) : (
                "채우기 ▸"
              )}
            </button>
            <button onClick={exitInpaint} className="rounded p-1 text-text-muted hover:text-text-primary">
              <X size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
