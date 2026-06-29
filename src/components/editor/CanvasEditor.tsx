"use client";

import {
  ArrowLeft,
  Brush,
  ChevronDown,
  ChevronUp,
  Eraser,
  Eye,
  EyeOff,
  GripVertical,
  Image as ImageIcon,
  Lasso,
  Loader2,
  Palette,
  Plus,
  Redo2,
  RotateCcw,
  Scissors,
  Sparkles,
  Tags,
  Trash2,
  Undo2,
  Upload,
  Wand2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AiSuggestButton, AiSuggestDropdown, type AiSuggestion } from "@/components/editor/AiSuggestControls";
import { useIsCodex } from "@/lib/context/orchestrator-context";
import {
  clearCanvasEdit,
  compositeScene,
  compositeSceneAI,
  filterImage,
  getCanvasEdit,
  jsonFetch,
  listGenerations,
  saveCanvasEdit,
  uploadImage,
} from "@/lib/api/client";
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
  naturalW: number; // 이미지 원본 픽셀 너비 (0=아직 미로드)
  naturalH: number; // 이미지 원본 픽셀 높이 (0=아직 미로드)
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
  onGeneratingChange?: (generating: boolean) => void;
  onClose: () => void;
  onComposited: (r: { generationId: string; width: number; height: number }) => void;
  onRemoveBg: (
    generationId: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  onUpscale: (
    generationId: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 부위 추출(텍스트 기반) — generationId 에서 prompt 부위를 투명 PNG 로 분리. autoRestore=가려진 부위 복원. 결과를 새 레이어로. */
  onExtract: (
    generationId: string,
    prompt: string,
    autoRestore: boolean,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 부위 추출(브러시 기반) — 칠한 마스크 영역을 prompt 이름의 투명 PNG 로 분리. 결과를 새 레이어로. */
  onExtractBrush: (
    generationId: string,
    maskDataUrl: string,
    prompt: string,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 영역 편집(generative fill) — generationId + 마스크(dataUrl) + prompt(+선택 참조)로 칠한 영역 재생성. */
  onInpaint: (
    generationId: string,
    maskDataUrl: string,
    prompt: string,
    referenceGenerationId?: string | null,
  ) => Promise<{ generationId: string; width: number; height: number } | null>;
  /** 색 변경 / 화풍 변환 — 선택 레이어 generationId 와 초기 모드를 부모로 전달해 ReskinPanel 오픈. */
  onReskin?: (generationId: string, initialMode: "color" | "style") => void;
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
    naturalW: 0,
    naturalH: 0,
  };
}

/**
 * "건드리지 않은 시드 단일 레이어"인지 — 자동 저장 게이트.
 * 진입 직후(시드 1장, 변형·필터 무, generationId=시드) 상태는 저장하지 않아, 편집하지 않은 이미지에
 * 저장본/복원 칩이 생기는 것을 막는다. 출력 규격(canvasSize)은 자동으로 원본에 맞춰지므로 판단에서 제외.
 */
function isPristineSeedLayer(l: Layer, seedId: string): boolean {
  return (
    l.generationId === seedId &&
    l.x === 0 && l.y === 0 &&
    l.scale === 1 && l.stretchW === 1 && l.stretchH === 1 &&
    l.rotation === 0 && !l.flipH && l.opacity === 100 && l.visible &&
    l.filters.brightness === 100 && l.filters.contrast === 100 &&
    l.filters.saturation === 100 && l.filters.hue === 0 && l.filters.blur === 0
  );
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

/** Sobel 엣지 강도 맵 — 자석 올가미가 스냅할 경계선(휘도 gradient magnitude). 원본 픽셀 1:1.
 *  알파 프리멀티플라이: luma * (alpha/255) → 투명 경계도 강한 엣지로 검출. */
function sobelGradient(imageData: ImageData): Float32Array {
  const { data, width, height } = imageData;
  const grad = new Float32Array(width * height);
  // alpha-premultiplied luma — 투명 픽셀은 0, 불투명 경계에서 큰 gradient 발생.
  const val = (i: number) => {
    const a = data[i + 3] / 255;
    return (0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) * a;
  };
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const px = (dx: number, dy: number) => val(((y + dy) * width + (x + dx)) * 4);
      const gx = -px(-1, -1) + px(1, -1) - 2 * px(-1, 0) + 2 * px(1, 0) - px(-1, 1) + px(1, 1);
      const gy = -px(-1, -1) - 2 * px(0, -1) - px(1, -1) + px(-1, 1) + 2 * px(0, 1) + px(1, 1);
      grad[y * width + x] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return grad;
}

/** 오브젝트 지우기 고정 프롬프트 — 칠한 영역을 주변 배경으로 메워 오브젝트를 없앤다(은퇴한 MaskCanvas 와 동일 문구). */
const OBJECT_REMOVE_PROMPT =
  "seamless background matching the surrounding area — same colors, textures, and lighting, as if the object was never there";

export function CanvasEditor({
  seedGenerationId,
  sessionId,
  busy,
  onGeneratingChange,
  onClose,
  onComposited,
  onRemoveBg,
  onUpscale,
  onExtract,
  onExtractBrush,
  onInpaint,
  onReskin,
}: Props) {
  // 레이어 스택 — 배열 순서 = z-order(마지막이 최상단). seed 를 첫 레이어로 lazy init.
  const [layers, setLayers] = useState<Layer[]>(() => [makeLayer(seedGenerationId)]);
  // 열자마자 씬(첫) 레이어를 선택해 둔다 — 도구(변형·필터·분리·영역편집 등)가 바로 보이도록.
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(() => layers[0]?.id ?? null);
  const [presetIdx, setPresetIdx] = useState(0);
  const [customSize, setCustomSize] = useState<CanvasSize>({ w: 1024, h: 1024 });
  // 영속화 — 진입 시 저장본을 불러와 "이전 편집 이어서" 칩으로 제시(자동 적용 X). dismiss 시 칩 숨김.
  const [restorable, setRestorable] = useState<Snapshot | null>(null);
  const [restoreDismissed, setRestoreDismissed] = useState(false);
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
  const [composingAI, setComposingAI] = useState(false);
  // 선택 레이어 단일 작업 진행 상태 — 배경제거/업스케일(AI) · 여백제거(sharp). 동시 실행 방지.
  const [layerOp, setLayerOp] = useState<null | "bg" | "upscale" | "trim">(null);
  // 분리(오려내기) — 부위명 입력 + 진행 상태. 추출 결과는 새 레이어로 추가.
  const [extractInput, setExtractInput] = useState("");
  const [extracting, setExtracting] = useState(false);
  // 영역 편집 서브모드 — brush(칠하기) / lasso(올가미).
  const [inpaintMode, setInpaintMode] = useState<"brush" | "lasso">("brush");
  // 레이어 분리 서브모드 — text(부위명 기반) / brush(칠한 마스크 기반) / lasso(올가미 폴리곤).
  // brush·lasso 모두 brushCanvasRef(원본 해상도·레이어 transform 공유)에 빨강으로 칠해 handleExtractBrush 로 마스크화.
  const [extractMode, setExtractMode] = useState<"text" | "brush" | "lasso">("text");
  // 올가미 타입 — free(자유 드래그)/poly(클릭 다각형)/magnetic(엣지 스냅). 포토샵식 3종.
  const [lassoType, setLassoType] = useState<"free" | "poly" | "magnetic">("free");
  // 올가미 — LOCAL 좌표(프리줌 CSS 픽셀, lx/ly: data-canvas-frame 기준)를 단일 SSOT 로 누적.
  // 줌에 무관하게 이미지 위치를 보존(client 좌표는 zoom·rect 변동에 어긋남). 오버레이 그리기·마스크 커밋 모두 여기서 파생.
  const lassoDrawingRef = useRef(false);
  const lassoOverlayRef = useRef<HTMLCanvasElement>(null); // 화면 공간 경로 시각화
  const lassoClientPtsRef = useRef<{ lx: number; ly: number }[]>([]); // LOCAL 좌표 정점
  const lassoRubberBandRef = useRef<{ lx: number; ly: number } | null>(null); // poly/magnetic 고무줄 끝점
  const lassoEdgeGradRef = useRef<Float32Array | null>(null); // magnetic: Sobel gradient
  const lassoMagPrevSnapRef = useRef<{ lx: number; ly: number } | null>(null); // magnetic: 직전 스냅 위치(자동 앵커는 여기 찍힘)
  const lassoMagAccDistRef = useRef(0); // magnetic: 마우스 이동 누적 거리 (Frequency 간격 앵커 배치용)
  const lassoMagLastClientRef = useRef<{ x: number; y: number } | null>(null); // magnetic: 직전 pointer 위치
  const lassoEdgeSizeRef = useRef<{ w: number; h: number } | null>(null); // magnetic: edge 이미지 크기
  const lassoCommittedRef = useRef(false); // 마스크 커밋 완료 — 파란 선택 영역 오버레이 유지 플래그
  // --- 신규 추가 ---
  const lassoImagePtsRef = useRef<{ x: number; y: number }[]>([]); // 커밋된 원본 픽셀 좌표(SSOT)
  // poly/magnetic "완료" 버튼 가드 — ref 는 렌더를 안 깨우므로 정점 수를 state 로 미러(brushUndoCount 패턴).
  const [lassoPtCount, setLassoPtCount] = useState(0);
  // --- 신규 추가 ---
  const [lassoMoveOffset, setLassoMoveOffset] = useState<{ dx: number; dy: number } | null>(null);
  const [lassoDraggingMove, setLassoDraggingMove] = useState(false);
  const [lassoAiCutout, setLassoAiCutout] = useState(false);
  const [lassoAiRestore, setLassoAiRestore] = useState(false);
  // 텍스트 추출 시 가려진 부위 복원 여부(기본 on). off 면 [no-restore] → 보이는 픽셀만 추출.
  const [extractAutoRestore, setExtractAutoRestore] = useState(true);
  const isCodex = useIsCodex();
  // 부위명 AI 제안 — /api/layer-suggest. 하단 바라 드롭다운은 위로 연다(placement="bottom").
  const [extractAiLoading, setExtractAiLoading] = useState(false);
  const [extractAiSuggestions, setExtractAiSuggestions] = useState<AiSuggestion[] | null>(null);
  // 활성 도구 — 상단 메뉴 클릭 시 하단 바를 띄우는 단일 상태(즉시 실행하지 않음). 대상은 선택 레이어.
  const [tool, setTool] = useState<null | "inpaint" | "extract" | "bg" | "upscale" | "trim">(null);
  const [inpaintPrompt, setInpaintPrompt] = useState("");
  const [inpaintBrush, setInpaintBrush] = useState(40);
  const [inpaintBusy, setInpaintBusy] = useState(false);
  // 인페인트 대상 레이어의 원본 픽셀 크기 — 마스크 캔버스 해상도(선언적으로 박아 기본 300 버그 회피).
  const [inpaintNat, setInpaintNat] = useState<{ w: number; h: number } | null>(null);
  const brushCanvasRef = useRef<HTMLCanvasElement>(null);
  const brushDrawingRef = useRef(false);
  const brushLastRef = useRef<{ x: number; y: number } | null>(null);
  // 브러시 도구 — 칠하기/지우개. 지우개는 stamp 시 destination-out 으로 칠한 빨강을 깎아낸다.
  const [brushTool, setBrushTool] = useState<"brush" | "eraser">("brush");
  // 마스크에 한 번이라도 칠했는지 — "오브젝트 지우기"(고정 프롬프트) 버튼 활성 가드.
  const [brushPainted, setBrushPainted] = useState(false);
  // 스트로크 단위 undo — 브러시 down 직전 마스크 캔버스 ImageData 스냅샷을 적재(상한 30).
  const brushUndoRef = useRef<ImageData[]>([]);
  const [brushUndoCount, setBrushUndoCount] = useState(0);
  // 참조 이미지(MaskCanvas 이식) — 선택 시 인페인트 attachment 둘째로 전달. 하단 바 팝오버로 고름.
  const [refOpen, setRefOpen] = useState(false);
  const [refScope, setRefScope] = useState<"session" | "gallery">("session");
  const [sessionRefs, setSessionRefs] = useState<Generation[] | null>(null);
  const [galleryRefs, setGalleryRefs] = useState<Generation[] | null>(null);
  const [refId, setRefId] = useState<string | null>(null);
  // 선택 레이어 이미지의 변형 전 표시 크기(px) — 핸들 박스를 scale 밖에서 일정 크기로 그리기 위해.
  const [selBox, setSelBox] = useState<{ w: number; h: number } | null>(null);
  // 드래그 중 스냅 가이드(세로/가로 선) 표시. vEdge/hEdge 는 가장자리 스냅 시 방향.
  const [snapGuides, setSnapGuides] = useState<{
    v: boolean; h: boolean;
    vEdge?: "left" | "right"; hEdge?: "top" | "bottom";
  } | null>(null);
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
        return;
      }
      // 텍스트 입력 포커스 중에는 화살표/WASD 를 패스스루한다.
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const STEP = 20;
      if (e.key === "ArrowLeft"  || e.key === "a" || e.key === "A") { e.preventDefault(); zp.movePan( STEP, 0); }
      if (e.key === "ArrowRight" || e.key === "d" || e.key === "D") { e.preventDefault(); zp.movePan(-STEP, 0); }
      if (e.key === "ArrowUp"    || e.key === "w" || e.key === "W") { e.preventDefault(); zp.movePan(0,  STEP); }
      if (e.key === "ArrowDown"  || e.key === "s" || e.key === "S") { e.preventDefault(); zp.movePan(0, -STEP); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, zp.movePan]);

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

  // 참조 이미지 목록(MaskCanvas 이식) — 영역 편집 도구가 열렸을 때만, 캐시 유지(재로딩 X).
  // mask noise 와 현재 선택 레이어 자신은 제외(자기 참조 의미 없음).
  const selectedGenId = selected?.generationId ?? null;
  useEffect(() => {
    if (tool !== "inpaint" || sessionRefs !== null) return;
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens => setSessionRefs(gens.filter(g => g.kind !== "mask" && g.id !== selectedGenId)))
      .catch(() => setSessionRefs([]));
  }, [tool, sessionRefs, sessionId, selectedGenId]);
  useEffect(() => {
    if (tool !== "inpaint" || refScope !== "gallery" || galleryRefs !== null) return;
    listGenerations({ limit: 120 })
      .then(gens => setGalleryRefs(gens.filter(g => g.kind !== "mask" && g.id !== selectedGenId)))
      .catch(() => setGalleryRefs([]));
  }, [tool, refScope, galleryRefs, selectedGenId]);

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
        const r = await onExtract(layer.generationId, part, extractAutoRestore);
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
  }, [layers, selectedLayerId, extracting, extractInput, extractAutoRestore, onExtract, pushUndo]);

  // 부위명 AI 제안 — /api/layer-suggest. 선택 시 부위명을 쉼표로 이어 붙인다.
  const handleExtractAiSuggest = useCallback(async () => {
    if (extractAiLoading) return;
    setExtractAiLoading(true);
    try {
      const layer = layers.find(l => l.id === selectedLayerId);
      const res = await jsonFetch("/api/layer-suggest", "POST", {
        question: "게임 캐릭터/오브젝트 스프라이트의 분리할 부위를 제안해주세요",
        generationId: layer?.generationId,
      });
      const data = (await res.json()) as { suggestions?: AiSuggestion[] };
      setExtractAiSuggestions(data.suggestions ?? []);
    } catch {
      setExtractAiSuggestions([]);
    } finally {
      setExtractAiLoading(false);
    }
  }, [extractAiLoading, layers, selectedLayerId]);

  // 올가미가 활성인 조건 — 영역 편집(inpaint) + 레이어 분리(extract) 양쪽에서 공유.
  const isLassoActive = (tool === "inpaint" && inpaintMode === "lasso") || (tool === "extract" && extractMode === "lasso");

  // 올가미 상태 초기화(취소) — 오버레이 클리어 + 정점/고무줄 비우기. closeTool/clearBrush 가 호출하므로
  // TDZ 회피를 위해 이른 위치에 둔다(refs·setLassoPtCount 외 의존 없음).
  const clearLassoState = useCallback(() => {
    lassoClientPtsRef.current = [];
    lassoRubberBandRef.current = null;
    lassoDrawingRef.current = false;
    lassoCommittedRef.current = false;
    lassoMagPrevSnapRef.current = null;
    lassoMagAccDistRef.current = 0;
    lassoMagLastClientRef.current = null;
    lassoImagePtsRef.current = [];      // ← 추가
    setLassoPtCount(0);
    setLassoMoveOffset(null);           // ← 추가
    setLassoDraggingMove(false);        // ← 추가
    const overlay = lassoOverlayRef.current;
    overlay?.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
  }, []);

  // ── 영역 편집(generative fill) — 선택 레이어 위에 마스크를 칠하고 프롬프트로 재생성 ──────────
  // 소스 해상도 캔버스에 #ff0000 으로 칠하고, export 시 검정 배경 + 빨강 = 인페인트 영역(MaskCanvas 포맷).
  const closeTool = useCallback(() => {
    setTool(null);
    setInpaintPrompt("");
    setInpaintNat(null);
    setExtractInput("");
    setExtractMode("text");
    setLassoType("free");
    setExtractAiSuggestions(null);
    setBrushTool("brush");
    setBrushPainted(false);
    setRefId(null);
    setRefOpen(false);
    brushUndoRef.current = [];
    setBrushUndoCount(0);
    clearLassoState();
    const c = brushCanvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
  }, [clearLassoState]);
  // 상단 메뉴 클릭 → 즉시 실행하지 않고 하단 바를 띄운다. inpaint·extract 는 마스크 브러시용 원본 크기 로드.
  const openTool = useCallback(
    (kind: "inpaint" | "extract" | "bg" | "upscale" | "trim", layer: Layer) => {
      setTool(kind);
      setInpaintPrompt("");
      setExtractInput("");
      setExtractMode("text");
      setExtractAiSuggestions(null);
      setInpaintNat(null);
      if (kind === "inpaint" || kind === "extract") {
        const im = new window.Image();
        im.onload = () => setInpaintNat({ w: im.naturalWidth, h: im.naturalHeight });
        im.src = `/api/images/${layer.generationId}`;
      }
    },
    [],
  );
  // 진입 시 출력 규격 기본값을 시드(첫 레이어) 원본 이미지 크기로 — 포토샵 라운드트립 없이 원본 그대로 편집.
  // 프리셋은 0("자유")이라 customSize 가 곧 출력 규격. setState 는 onload(비동기) 안이라 set-state-in-effect 무관.
  const sizeInitRef = useRef(false);
  useEffect(() => {
    if (sizeInitRef.current) return;
    sizeInitRef.current = true;
    const im = new window.Image();
    im.onload = () => setCustomSize({ w: im.naturalWidth, h: im.naturalHeight });
    im.src = `/api/images/${seedGenerationId}`;
  }, [seedGenerationId]);

  // ── 편집 상태 영속화 (자동 저장 / 수동 복원) ──────────────────────────────────
  // 진입 시 시드별 저장본을 불러와 "이전 편집 이어서" 칩으로 제시(자동 적용 X). async setState 라 무관.
  useEffect(() => {
    let alive = true;
    getCanvasEdit(seedGenerationId)
      .then(s => {
        if (alive && s) setRestorable(s as unknown as Snapshot);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [seedGenerationId]);

  // "이전 편집 이어서" — 저장본을 현재 캔버스에 적용(applySnap + 프리셋 자유로 출력 규격 복원).
  const applyRestore = useCallback(() => {
    if (!restorable) return;
    applySnap(restorable);
    setPresetIdx(0);
    setRestoreDismissed(true);
  }, [restorable, applySnap]);

  // "처음부터" — 저장본 폐기(진입 상태=깨끗한 시드 그대로 유지). 칩도 닫는다.
  const discardRestore = useCallback(() => {
    setRestoreDismissed(true);
    void clearCanvasEdit(seedGenerationId);
  }, [seedGenerationId]);

  // 자동 저장(디바운스) — 건드리지 않은 시드 단일 기본 상태는 저장 안 함(편집한 경우에만 저장본 생성).
  const isDefaultCanvas = layers.length === 1 && isPristineSeedLayer(layers[0], seedGenerationId);
  const pendingSaveRef = useRef<Snapshot | null>(null);
  useEffect(() => {
    if (isDefaultCanvas) {
      pendingSaveRef.current = null;
      return;
    }
    const state: Snapshot = { layers, canvasSize, selectedLayerId };
    pendingSaveRef.current = state;
    const t = setTimeout(() => {
      pendingSaveRef.current = null;
      void saveCanvasEdit(seedGenerationId, state);
    }, 800);
    return () => clearTimeout(t);
  }, [layers, canvasSize, selectedLayerId, isDefaultCanvas, seedGenerationId]);
  // 닫기(언마운트) 시 디바운스 대기 중인 저장을 즉시 flush — 마지막 편집 손실 방지.
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current) void saveCanvasEdit(seedGenerationId, pendingSaveRef.current);
    };
  }, [seedGenerationId]);

  const clearBrush = useCallback(() => {
    const c = brushCanvasRef.current;
    c?.getContext("2d")?.clearRect(0, 0, c.width, c.height);
    brushUndoRef.current = [];
    setBrushUndoCount(0);
    setBrushPainted(false);
    clearLassoState();
  }, [clearLassoState]);
  // 스트로크 단위 되돌리기 — 마지막 스냅샷 복원(없으면 빈 캔버스).
  const undoBrushStroke = useCallback(() => {
    const c = brushCanvasRef.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const snap = brushUndoRef.current.pop();
    if (snap) ctx.putImageData(snap, 0, 0);
    else ctx.clearRect(0, 0, c.width, c.height);
    setBrushUndoCount(brushUndoRef.current.length);
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
      // 스트로크 시작 전 현재 마스크를 스냅샷으로 적재 — 되돌리기 단위(상한 30, 메모리 보호).
      brushUndoRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
      if (brushUndoRef.current.length > 30) brushUndoRef.current.shift();
      setBrushUndoCount(brushUndoRef.current.length);
      setBrushPainted(true);
      brushDrawingRef.current = true;
      // 지우개=destination-out(칠한 빨강의 alpha 만 깎음), 브러시=source-over. fillStyle 은 빨강 유지.
      ctx.globalCompositeOperation = brushTool === "eraser" ? "destination-out" : "source-over";
      ctx.fillStyle = "#ff0000";
      const p = screenToSource(canvas, e.clientX, e.clientY, layer);
      stampEllipse(ctx, p.x, p.y, p.rx, p.ry);
      brushLastRef.current = { x: p.x, y: p.y };
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {}
    },
    [screenToSource, brushTool],
  );
  const onBrushMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>, layer: Layer) => {
      if (!brushDrawingRef.current) return;
      const ctx = e.currentTarget.getContext("2d");
      if (!ctx) return;
      ctx.globalCompositeOperation = brushTool === "eraser" ? "destination-out" : "source-over";
      ctx.fillStyle = "#ff0000";
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
    [screenToSource, brushTool],
  );
  const onBrushUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    brushDrawingRef.current = false;
    brushLastRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  // ── 올가미(lasso) — 포토샵식 자유/다각형/자석 3종 ───────────────────────────────
  // 화면 클라이언트 좌표(cx/cy)를 SSOT 로 누적해 별도 오버레이 캔버스(화면 공간)에 흰선+검정 점선으로
  // 시각화하고, 닫을 때 brushCanvasRef(원본 해상도)에 screenToSource 로 역투영해 빨강 폴리곤을 채운다 →
  // brushPainted=true → handleExtractBrush(검정 배경 + 빨강 마스크)가 그대로 동작한다.

  // clientXY → LOCAL 좌표(프리줌 CSS 픽셀, lx/ly). overlay rect 기준이라 줌이 바뀌어도 같은 이미지 위치를 가리킨다.
  const clientToLocal = useCallback(
    (clientX: number, clientY: number): { lx: number; ly: number } => {
      const canvas = lassoOverlayRef.current;
      if (!canvas) return { lx: 0, ly: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        lx: (clientX - rect.left) / zp.zoom,
        ly: (clientY - rect.top) / zp.zoom,
      };
    },
    [zp.zoom],
  );

  // LOCAL 좌표(lx/ly) → 오버레이 캔버스 픽셀. canvas.width = frame.offsetWidth * zoom 이므로 local * zoom.
  const clientToOverlay = useCallback(
    (lx: number, ly: number): { x: number; y: number } => ({
      x: lx * zp.zoom,
      y: ly * zp.zoom,
    }),
    [zp.zoom],
  );

  // image pixel → clientXY — screenToSource 의 정확한 역변환(자석 스냅 결과를 화면에 다시 그릴 때).
  // 중심(ccx/ccy)·배율(f*scale*stretch*zoom)·회전(+t)·flip 을 screenToSource 와 거울처럼 맞춘다.
  const imageToClient = useCallback(
    (imgX: number, imgY: number, layer: Layer): { cx: number; cy: number } => {
      const canvas = brushCanvasRef.current;
      if (!canvas) return { cx: 0, cy: 0 };
      const rect = canvas.getBoundingClientRect();
      const ccx = (rect.left + rect.right) / 2;
      const ccy = (rect.top + rect.bottom) / 2;
      const f = canvas.offsetWidth / (canvas.width || 1);
      const sxScreen = f * layer.scale * layer.stretchW * zp.zoom || 1;
      const syScreen = f * layer.scale * layer.stretchH * zp.zoom || 1;
      const ux = (imgX - canvas.width / 2) * sxScreen;
      const uy = (imgY - canvas.height / 2) * syScreen;
      const t = (layer.rotation * Math.PI) / 180;
      const cos = Math.cos(t), sin = Math.sin(t);
      let dx = ux * cos - uy * sin;
      const dy = ux * sin + uy * cos;
      if (layer.flipH) dx = -dx;
      return { cx: dx + ccx, cy: dy + ccy };
    },
    [zp.zoom],
  );

  // 오버레이 경로 그리기 — 흰선 base + 검정 점선(포토샵 marching-ants 느낌). extraPt=고무줄/포인터 끝.
  const redrawLassoOverlay = useCallback(
    (extraPt?: { lx: number; ly: number }, closedFill?: boolean, moveOff?: { dx: number; dy: number }) => {
      const canvas = lassoOverlayRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // canvas.width 는 frame.offsetWidth * zoom 으로 설정돼 있어 lineWidth=1.5 = 1.5 화면 픽셀.
      // getBoundingClientRect 로 잔여 오차를 흡수한다.
      const rect = canvas.getBoundingClientRect();
      const ls = rect.width > 0 ? canvas.width / rect.width : 1;

      const pts = lassoClientPtsRef.current;

      // ── 커밋 완료 상태: 파란 fill 영구 표시 ──────────────────────────────────
      if (lassoCommittedRef.current && pts.length >= 3) {
        const off = moveOff ?? { dx: 0, dy: 0 };
        const all = pts.map(p => clientToOverlay(p.lx + off.dx, p.ly + off.dy));
        ctx.beginPath();
        ctx.moveTo(all[0].x, all[0].y);
        all.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = "rgba(100, 160, 255, 0.35)";
        ctx.fill();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5 * ls;
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.stroke();
        ctx.setLineDash([5 * ls, 4 * ls]);
        ctx.lineWidth = ls;
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.stroke();
        ctx.setLineDash([]);
        return;
      }

      // pts 없어도 자석 스냅 커서는 표시(magnetic 첫 점 전 미리보기).
      if (pts.length === 0 && !extraPt) return;

      const all = pts.map(p => clientToOverlay(p.lx, p.ly));
      if (extraPt) all.push(clientToOverlay(extraPt.lx, extraPt.ly));

      if (closedFill && all.length >= 3) {
        ctx.beginPath();
        ctx.moveTo(all[0].x, all[0].y);
        all.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        ctx.closePath();
        ctx.fillStyle = "rgba(100, 160, 255, 0.35)";
        ctx.fill();
      }

      if (all.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(all[0].x, all[0].y);
        all.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
        if (closedFill) ctx.closePath();
        ctx.setLineDash([]);
        ctx.lineWidth = 1.5 * ls;
        ctx.strokeStyle = "rgba(255,255,255,0.9)";
        ctx.stroke();
        ctx.setLineDash([5 * ls, 4 * ls]);
        ctx.lineWidth = ls;
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // 시작점 마커 — poly/magnetic 에서 "여기 클릭해 닫기" 스냅 목표 표시.
      if (pts.length >= 3) {
        const s = clientToOverlay(pts[0].lx, pts[0].ly);
        ctx.beginPath();
        ctx.arc(s.x, s.y, 5 * ls, 0, Math.PI * 2);
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.lineWidth = ls;
        ctx.stroke();
      }

      // 앵커 도트 — magnetic 모드에서 각 앵커 위치에 흰 테두리 노란 점 표시.
      if (lassoType === "magnetic" && pts.length > 0) {
        pts.forEach(p => {
          const ap = clientToOverlay(p.lx, p.ly);
          ctx.beginPath();
          ctx.arc(ap.x, ap.y, 3.5 * ls, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 220, 0, 0.95)";
          ctx.fill();
          ctx.strokeStyle = "rgba(0,0,0,0.7)";
          ctx.lineWidth = ls;
          ctx.stroke();
        });
      }

      // 현재 스냅 커서 — 마우스 위치는 아웃라인 원으로만 표시(채우지 않음 = 앵커 아님을 구분).
      if (lassoType === "magnetic" && extraPt) {
        const sp = clientToOverlay(extraPt.lx, extraPt.ly);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 4 * ls, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 220, 0, 0.9)";
        ctx.lineWidth = 1.5 * ls;
        ctx.stroke();
      }
    },
    [clientToOverlay, lassoType, zp.zoom],
  );

  // 마스크 커밋(공통) — 누적 정점을 닫고 brushCanvasRef 에 빨강 폴리곤 채움 → handleExtractBrush 활성.
  const commitLassoPoints = useCallback(() => {
    const pts = lassoClientPtsRef.current;
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || pts.length < 3) {
      clearLassoState();
      return;
    }
    const canvas = brushCanvasRef.current;
    if (!canvas) {
      // inpaintNat 아직 로드 중 — 경로는 유지하고 대기. 이미지 로드 완료 후 Enter/완료 재시도.
      return;
    }
    // LOCAL(lx/ly) → 현재 줌의 client 좌표 복원(overlay rect 기준) → screenToSource. 줌 변경 후에도 정합.
    const overlayRect = lassoOverlayRef.current?.getBoundingClientRect();
    if (!overlayRect) return;
    const imagePts = pts.map(p =>
      screenToSource(
        canvas,
        p.lx * zp.zoom + overlayRect.left,
        p.ly * zp.zoom + overlayRect.top,
        layer,
      ),
    );
    lassoImagePtsRef.current = imagePts; // ← 커밋된 원본 픽셀 좌표 저장
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#ff0000";
    ctx.beginPath();
    ctx.moveTo(imagePts[0].x, imagePts[0].y);
    imagePts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fill();

    // 선택 완료 — 파란 폴리곤을 오버레이에 영구 표시(전체지우기/분리 전까지).
    // pts 는 줌 변경 시 재그리기에 사용하므로 유지한다.
    lassoCommittedRef.current = true;
    lassoRubberBandRef.current = null;
    lassoDrawingRef.current = false;
    setLassoPtCount(pts.length);
    redrawLassoOverlay(undefined, true);
    setBrushPainted(true);
  }, [layers, selectedLayerId, screenToSource, clearLassoState, redrawLassoOverlay, zp.zoom]);

  // 자석 스냅 — 화면점 주변 원본 픽셀(반경≈화면 20px)에서 Sobel gradient 최대점을 찾아 그 위치를 화면좌표로.
  const snapToEdge = useCallback(
    (clientX: number, clientY: number): { cx: number; cy: number } | null => {
      const grad = lassoEdgeGradRef.current;
      const size = lassoEdgeSizeRef.current;
      const canvas = brushCanvasRef.current;
      const layer = layers.find(l => l.id === selectedLayerId);
      if (!grad || !size || !canvas || !layer) return null;

      const center = screenToSource(canvas, clientX, clientY, layer);
      const rect = canvas.getBoundingClientRect();
      const imgRadiusPx = 8 * (canvas.width / (rect.width || 1)); // 화면 8px → 원본 픽셀 (마우스 근처만 스냅)
      const r = Math.ceil(imgRadiusPx);

      let best = -1, bx = center.x, by = center.y;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy > r * r) continue;
          const px = Math.round(center.x + dx), py = Math.round(center.y + dy);
          if (px < 0 || py < 0 || px >= size.w || py >= size.h) continue;
          const g = grad[py * size.w + px];
          if (g > best) { best = g; bx = center.x + dx; by = center.y + dy; }
        }
      }
      // 픽셀/엣지가 없는 빈 영역 — gradient 최소 임계값 미달 시 스냅 거부.
      if (best < 8) return null;
      return imageToClient(bx, by, layer);
    },
    [layers, selectedLayerId, screenToSource, imageToClient],
  );

  // 자유 올가미 — brushCanvasRef pointer 이벤트(이미 layerTransform 공유). 경로는 오버레이에 그린다.
  const onLassoDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      e.stopPropagation(); // 아래 레이어의 onLayerBodyDown(이동 드래그) 차단
      // 커밋 상태에서 새 드래그 시작 시 초기화
      if (lassoCommittedRef.current) {
        lassoCommittedRef.current = false;
        setBrushPainted(false);
      }
      lassoDrawingRef.current = true;
      const lp = clientToLocal(e.clientX, e.clientY);
      lassoClientPtsRef.current = [lp];
      setLassoPtCount(1);
      redrawLassoOverlay();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {}
    },
    [redrawLassoOverlay, clientToLocal],
  );
  const onLassoMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoDrawingRef.current) return;
      const lp = clientToLocal(e.clientX, e.clientY);
      lassoClientPtsRef.current.push(lp);
      setLassoPtCount(lassoClientPtsRef.current.length);
      redrawLassoOverlay(lp);
    },
    [redrawLassoOverlay, clientToLocal],
  );
  const onLassoUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoDrawingRef.current) return;
      lassoDrawingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {}
      commitLassoPoints(); // 떼면 시작점과 직선 연결(자동 닫기). <3 점이면 clearLassoState.
    },
    [commitLassoPoints],
  );

  // 다각형/자석 올가미 — 오버레이 캔버스의 click/move/dblclick.
  const onLassoOverlayClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (lassoType !== "poly" && lassoType !== "magnetic") return;
      e.preventDefault();
      // 커밋 상태에서 새 점 추가 시 이전 선택 초기화 후 새 드로잉 시작.
      if (lassoCommittedRef.current) {
        lassoCommittedRef.current = false;
        lassoClientPtsRef.current = [];
        setBrushPainted(false);
      }
      const pts = lassoClientPtsRef.current;
      const el = clientToLocal(e.clientX, e.clientY);
      // 시작점 근처(≥3점 & 12px client 이내) 클릭 → 닫기. local 거리 기준이라 임계값도 12/zoom.
      if (pts.length >= 3) {
        const dx = el.lx - pts[0].lx, dy = el.ly - pts[0].ly;
        if (Math.sqrt(dx * dx + dy * dy) < 12 / zp.zoom) {
          commitLassoPoints();
          return;
        }
      }
      if (lassoType === "magnetic") {
        // snapToEdge 는 client 좌표 반환 → local 로 변환해 저장.
        const snapped = snapToEdge(e.clientX, e.clientY);
        const clicked = snapped ? clientToLocal(snapped.cx, snapped.cy) : el;
        pts.push(clicked);
        // 클릭으로 앵커를 고정했으므로 누적 거리·prevSnap 리셋.
        lassoMagPrevSnapRef.current = null;
        lassoMagAccDistRef.current = 0;
        lassoMagLastClientRef.current = null;
      } else {
        pts.push(el);
      }
      setLassoPtCount(pts.length);
      redrawLassoOverlay(lassoRubberBandRef.current ?? undefined);
    },
    [lassoType, commitLassoPoints, redrawLassoOverlay, snapToEdge, clientToLocal, zp.zoom],
  );
  const onLassoOverlayMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (lassoType === "free") return; // free 는 brushCanvas 이벤트 사용
      // magnetic: 첫 점 전에도 스냅 커서 미리보기. poly: 첫 점 전엔 고무줄 불필요.
      if (lassoType !== "magnetic" && lassoClientPtsRef.current.length === 0) return;
      let pt: { lx: number; ly: number };
      if (lassoType === "magnetic") {
        // snapToEdge: 엣지 없는 빈 영역이면 null 반환.
        const snapped = snapToEdge(e.clientX, e.clientY);
        // 고무줄 미리보기는 현재 스냅 위치 우선, 없으면 마우스 원위치.
        pt = snapped ? clientToLocal(snapped.cx, snapped.cy) : clientToLocal(e.clientX, e.clientY);

        // 마우스 이동 거리 누적 — 일정 Frequency(12 screen px)마다 직전 스냅 위치에 앵커 배치.
        const pts = lassoClientPtsRef.current;
        const lastClient = lassoMagLastClientRef.current;
        if (lastClient) {
          const mdx = e.clientX - lastClient.x, mdy = e.clientY - lastClient.y;
          lassoMagAccDistRef.current += Math.sqrt(mdx * mdx + mdy * mdy);
        }
        lassoMagLastClientRef.current = { x: e.clientX, y: e.clientY };

        if (pts.length > 0 && snapped !== null) {
          const FREQ = 40; // 화면 40px 이동마다 앵커 1개
          if (lassoMagAccDistRef.current >= FREQ) {
            lassoMagAccDistRef.current = 0;
            // 직전 스냅 위치(prevSnap)에 찍어 "지나간 자리에 달라붙는" 효과.
            const prev = lassoMagPrevSnapRef.current ?? pt;
            pts.push(prev);
            setLassoPtCount(pts.length);
          }
          lassoMagPrevSnapRef.current = pt;
        } else if (snapped === null) {
          lassoMagPrevSnapRef.current = null;
        }
      } else {
        pt = clientToLocal(e.clientX, e.clientY);
      }
      lassoRubberBandRef.current = pt;
      redrawLassoOverlay(pt); // 마지막 앵커 → 현재(스냅된) 점 고무줄 미리보기
    },
    [lassoType, redrawLassoOverlay, snapToEdge, clientToLocal, zp.zoom],
  );
  const onLassoOverlayDblClick = useCallback(() => {
    if (lassoClientPtsRef.current.length >= 3) commitLassoPoints();
  }, [commitLassoPoints]);

  // 오버레이 캔버스 크기 동기화 — data-canvas-frame(부모) 크기에 맞춤(ResizeObserver).
  useLayoutEffect(() => {
    if (!isLassoActive) return;
    const canvas = lassoOverlayRef.current;
    if (!canvas) return;
    const frame = canvas.parentElement;
    if (!frame) return;
    const sync = () => {
      // zoom 배율로 캔버스 해상도를 높여 줌인 시 선 굵기·품질 일정 유지.
      canvas.width = Math.round(frame.offsetWidth * zp.zoom);
      canvas.height = Math.round(frame.offsetHeight * zp.zoom);
      // 크기 변경(→ clearRect) 후 기존 경로/커밋 영역 복원.
      redrawLassoOverlay(lassoRubberBandRef.current ?? undefined);
    };
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(frame);
    return () => ro.disconnect();
  }, [isLassoActive, zp.zoom, redrawLassoOverlay]);

  // poly/magnetic 키보드 — Backspace(마지막 점)/Esc(전체 취소)/Enter(완료). 입력 포커스 시 무시.
  useEffect(() => {
    if (!isLassoActive || lassoType === "free") return;
    const handler = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      if (e.key === "Backspace" || e.key === "Delete" || e.key === "\\") {
        lassoClientPtsRef.current.pop();
        setLassoPtCount(lassoClientPtsRef.current.length);
        redrawLassoOverlay(lassoRubberBandRef.current ?? undefined);
        e.preventDefault();
      } else if (e.key === "Escape") {
        clearLassoState();
        e.preventDefault();
      } else if (e.key === "Enter") {
        commitLassoPoints();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [isLassoActive, lassoType, redrawLassoOverlay, clearLassoState, commitLassoPoints]);

  // 자석 올가미 엣지 맵 초기화 — magnetic 전환·레이어 변경 시 Sobel gradient 1회 계산.
  useEffect(() => {
    if (!isLassoActive || lassoType !== "magnetic") return;
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer) return;
    lassoEdgeGradRef.current = null;
    lassoEdgeSizeRef.current = null;
    const img = new window.Image();
    img.src = `/api/images/${layer.generationId}`;
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, c.width, c.height);
      lassoEdgeGradRef.current = sobelGradient(data);
      lassoEdgeSizeRef.current = { w: c.width, h: c.height };
    };
  }, [tool, extractMode, lassoType, selectedLayerId, layers]);

  // 칠한 마스크 + 프롬프트로 인페인트 실행 — 채우기(사용자 프롬프트+참조)와 오브젝트 지우기(고정 프롬프트)가 공유.
  const runInpaint = useCallback(
    async (prompt: string, reference: string | null) => {
      const layer = layers.find(l => l.id === selectedLayerId);
      const canvas = brushCanvasRef.current;
      if (!layer || !canvas || inpaintBusy || !prompt.trim()) return;
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
        const r = await onInpaint(layer.generationId, maskDataUrl, prompt.trim(), reference);
        if (r) {
          pushUndo();
          patchLayer(layer.id, { generationId: r.generationId });
          closeTool();
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setInpaintBusy(false);
      }
    },
    [layers, selectedLayerId, inpaintBusy, onInpaint, pushUndo, patchLayer, closeTool],
  );
  // 채우기 — 사용자 프롬프트 + 선택 참조로 재생성.
  const handleInpaintSubmit = useCallback(
    () => runInpaint(inpaintPrompt, refId),
    [runInpaint, inpaintPrompt, refId],
  );
  // 오브젝트 지우기 — 칠한 영역을 주변 배경으로 메워 오브젝트 제거(고정 프롬프트, 참조 없음).
  const handleObjectRemove = useCallback(() => runInpaint(OBJECT_REMOVE_PROMPT, null), [runInpaint]);

  // 브러시 기반 분리 — 칠한 마스크 + 부위명으로 그 영역을 추출해 새 레이어로. 인페인트 export 와 동일 포맷.
  const handleExtractBrush = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    const canvas = brushCanvasRef.current;
    if (!layer || !canvas || extracting || !extractInput.trim() || !brushPainted) return;
    // export: 소스 해상도 검정 배경 + 빨강 칠(MaskCanvas 포맷).
    const out = document.createElement("canvas");
    out.width = canvas.width;
    out.height = canvas.height;
    const octx = out.getContext("2d");
    if (!octx) return;
    octx.fillStyle = "#000000";
    octx.fillRect(0, 0, out.width, out.height);
    octx.drawImage(canvas, 0, 0);
    const maskDataUrl = out.toDataURL("image/png");
    setExtracting(true);
    setError(null);
    try {
      const r = await onExtractBrush(layer.generationId, maskDataUrl, extractInput.trim());
      if (r) {
        pushUndo();
        const nl = makeLayer(r.generationId);
        setLayers(prev => [...prev, nl]);
        setSelectedLayerId(nl.id);
        closeTool();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, extracting, extractInput, brushPainted, onExtractBrush, pushUndo, closeTool]);

  const handleLassoCutout = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || !inpaintNat || extracting) return;
    const imagePts = lassoImagePtsRef.current;
    if (imagePts.length < 3) return;

    if (lassoAiCutout) {
      // AI 경로 — 기존 handleExtractBrush 재사용 (brushCanvasRef 빨강 마스크 이미 있음)
      await handleExtractBrush();
      return;
    }

    setExtracting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("이미지 로드 실패"));
        img.src = `/api/images/${layer.generationId}`;
      });

      const { w, h } = inpaintNat;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();

      const dataUrl = canvas.toDataURL("image/png");
      const r = await uploadImage({ dataUrl, sessionId });
      pushUndo();
      const nl: Layer = {
        ...makeLayer(r.generationId),
        x: layer.x,
        y: layer.y,
        scale: layer.scale,
        stretchW: layer.stretchW,
        stretchH: layer.stretchH,
        rotation: layer.rotation,
        flipH: layer.flipH,
      };
      setLayers(prev => [...prev, nl]);
      setSelectedLayerId(nl.id);
      closeTool();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, inpaintNat, extracting, lassoAiCutout, handleExtractBrush,
      sessionId, pushUndo, setLayers, setSelectedLayerId, closeTool, setExtracting, setError]);
  const handleLassoDuplicate = useCallback(async () => {
    const layer = layers.find(l => l.id === selectedLayerId);
    if (!layer || !inpaintNat || extracting) return;
    const imagePts = lassoImagePtsRef.current;
    if (imagePts.length < 3) return;

    setExtracting(true);
    setError(null);
    try {
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("이미지 로드 실패"));
        img.src = `/api/images/${layer.generationId}`;
      });

      const { w, h } = inpaintNat;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0, w, h);
      ctx.globalCompositeOperation = "destination-in";
      ctx.fillStyle = "#000";
      ctx.beginPath();
      ctx.moveTo(imagePts[0].x, imagePts[0].y);
      imagePts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
      ctx.closePath();
      ctx.fill();

      const dataUrl = canvas.toDataURL("image/png");
      const r = await uploadImage({ dataUrl, sessionId });
      pushUndo();
      // 원본 레이어 transform 상속, 원본은 유지
      const nl: Layer = {
        ...makeLayer(r.generationId),
        x: layer.x,
        y: layer.y,
        scale: layer.scale,
        stretchW: layer.stretchW,
        stretchH: layer.stretchH,
        rotation: layer.rotation,
        flipH: layer.flipH,
      };
      setLayers(prev => [...prev, nl]);
      setSelectedLayerId(nl.id);
      closeTool();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setExtracting(false);
    }
  }, [layers, selectedLayerId, inpaintNat, extracting,
      sessionId, pushUndo, setLayers, setSelectedLayerId, closeTool, setExtracting, setError]);
  const lassoDragStartRef = useRef<{ lx: number; ly: number } | null>(null);

  const handleLassoMoveStart = useCallback(() => {
    setLassoMoveOffset({ dx: 0, dy: 0 });
    // 드래그 대기 상태 — onMoveDown 에서 실제 드래그 시작
  }, [setLassoMoveOffset]);

  const onMoveDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoCommittedRef.current || lassoMoveOffset === null) return;
      e.preventDefault();
      e.stopPropagation();
      lassoDragStartRef.current = clientToLocal(e.clientX, e.clientY);
      setLassoDraggingMove(true);
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    },
    [clientToLocal, lassoMoveOffset],
  );

  const onMoveMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!lassoDragStartRef.current) return;
      const cur = clientToLocal(e.clientX, e.clientY);
      const dx = cur.lx - lassoDragStartRef.current.lx;
      const dy = cur.ly - lassoDragStartRef.current.ly;
      setLassoMoveOffset({ dx, dy });
      redrawLassoOverlay(undefined, true, { dx, dy });
    },
    [clientToLocal, redrawLassoOverlay],
  );

  const onMoveUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      setLassoDraggingMove(false);
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch {}
      lassoDragStartRef.current = null;
    },
    [],
  );

  // TODO: Task 6
  const handleLassoMoveConfirm = useCallback(async () => {}, []);

  const handleLassoMoveCancel = useCallback(() => {
    setLassoMoveOffset(null);
    setLassoDraggingMove(false);
    lassoDragStartRef.current = null;
    redrawLassoOverlay(undefined, true); // offset 없이 원위치 파란 선택 영역 복원
  }, [redrawLassoOverlay, setLassoMoveOffset]);

  // ── 레이어 레일 드래그 정렬 → 배열 순서(z) 동기화 ────────────────────────────────
  const reorderDragRef = useRef<string | null>(null);
  // FLIP — 재정렬로 행 위치가 바뀌면 옛 위치에서 새 위치로 부드럽게 슬라이드(자연스러운 인지).
  const railRef = useRef<HTMLDivElement>(null);
  const rowTopsRef = useRef<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const rows = rail.querySelectorAll<HTMLElement>("[data-lrow]");
    const prev = rowTopsRef.current;
    const next = new Map<string, number>();
    rows.forEach(row => {
      const lid = row.dataset.lid ?? "";
      const top = row.offsetTop;
      next.set(lid, top);
      const old = prev.get(lid);
      if (old != null && old !== top) {
        row.style.transition = "none";
        row.style.transform = `translateY(${old - top}px)`;
        requestAnimationFrame(() => {
          row.style.transition = "transform 180ms ease";
          row.style.transform = "";
        });
      }
    });
    rowTopsRef.current = next;
  }, [layers]);
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
    hw0: number; // 박스 반폭 (client px) — selBox 기반 정확값
    hh0: number; // 박스 반높이 (client px)
    llx0: number; // 그랩 시점 포인터 로컬 좌표 — 델타 기준
    lly0: number;
    x0: number; // 레이어 시작 x/y (frame px)
    y0: number;
    zoom: number;
    rot: number; // rad (양의 회전각)
    cx: number;
    cy: number;
    fhw: number; // 캔버스(프레임) 반폭/반높이 (frame px) — 가장자리 스냅용
    fhh: number;
  } | null>(null);

  const onHandleDown = useCallback(
    (e: React.PointerEvent, type: "corner" | "l" | "r" | "t" | "b" | "rot", layer: Layer) => {
      if (e.button === 2) return;
      e.preventDefault();
      e.stopPropagation();
      const frame = stageRef.current?.querySelector<HTMLElement>("[data-canvas-frame]");
      if (!frame) return;
      const rect = frame.getBoundingClientRect();
      // ★ 레이어 중심(client) = 프레임 중심 + 레이어 오프셋(x,y)·zoom. 프레임 중심이 아니라
      // 레이어 중심을 원점으로 써야 오프셋된 레이어에서도 반대 변이 정확히 고정된다(드리프트 수정).
      const cx = rect.left + rect.width / 2 + layer.x * zp.zoom;
      const cy = rect.top + rect.height / 2 + layer.y * zp.zoom;
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
        // 박스 반치수는 그랩 위치가 아니라 selBox(실제 표시 크기)로 정확히 계산 — 스냅/늘이기 오차 제거.
        hw0: selBox ? (selBox.w / 2) * layer.scale * layer.stretchW * zp.zoom || 1 : Math.abs(lx) || 1,
        hh0: selBox ? (selBox.h / 2) * layer.scale * layer.stretchH * zp.zoom || 1 : Math.abs(ly) || 1,
        llx0: lx,
        lly0: ly,
        x0: layer.x,
        y0: layer.y,
        zoom: zp.zoom,
        rot,
        cx,
        cy,
        fhw: rect.width / zp.zoom / 2,
        fhh: rect.height / zp.zoom / 2,
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
          // 그랩 후 포인터 이동량(델타)으로 폭 산출 — 박스 반폭은 정확값(hw0), 반대 변 고정.
          let newW = Math.max(8, 2 * d.hw0 + sign * (llx - d.llx0));
          // 캔버스 가장자리·중앙 스냅(회전 ~0 일 때만) — 그랩 변 frame x 를 목표에 맞춰 newW 재산출.
          if (Math.abs(d.rot) < 0.035) {
            const oppX = d.x0 - (sign * d.hw0) / d.zoom; // 고정(반대) 변 frame x
            const draggedX = d.x0 + (sign * (newW - d.hw0)) / d.zoom; // 현재 그랩 변 frame x
            const snapT = 7 / d.zoom;
            for (const T of [sign * d.fhw, -sign * d.fhw, 0]) {
              if (Math.abs(draggedX - T) < snapT) {
                newW = Math.abs(T - oppX) * d.zoom;
                break;
              }
            }
          }
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
          let newH = Math.max(8, 2 * d.hh0 + sign * (lly - d.lly0));
          if (Math.abs(d.rot) < 0.035) {
            const oppY = d.y0 - (sign * d.hh0) / d.zoom;
            const draggedY = d.y0 + (sign * (newH - d.hh0)) / d.zoom;
            const snapT = 7 / d.zoom;
            for (const T of [sign * d.fhh, -sign * d.fhh, 0]) {
              if (Math.abs(draggedY - T) < snapT) {
                newH = Math.abs(T - oppY) * d.zoom;
                break;
              }
            }
          }
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
    [pushUndo, patchLayer, zp.zoom, selBox],
  );

  // 휠/트랙패드 줌 — 커서 위치 기준(zoomAtPoint). 네이티브 리스너 + passive:false 로 페이지 스크롤 차단.
  const { zoomAtPoint } = zp;
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // deltaY 크기를 비례 반영 — 트랙패드(작은 delta)는 부드럽고, 마우스 휠(큰 delta)은 적당히 반응.
      // 0.003 스케일로 deltaY≈83 → 0.25(기존 ZOOM_STEP 동치), 최대 0.2 캡.
      const delta = Math.sign(-e.deltaY) * Math.min(Math.abs(e.deltaY) * 0.003, 0.2);
      zoomAtPoint(el, e.clientX, e.clientY, delta);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAtPoint]);

  // ── 레이어 본체 드래그 = 이동 (선택). client delta → canvas px 는 zoom 으로 역산. ──────
  const moveDragRef = useRef<{
    sx: number; sy: number; ox: number; oy: number;
    fhw: number; fhh: number; // 캔버스 반폭/반높이 (canvas px)
    hw: number; hh: number;   // 레이어 렌더 반폭/반높이 (canvas px)
  } | null>(null);
  const onLayerBodyDown = useCallback(
    (e: React.PointerEvent, layer: Layer) => {
      if (e.button === 2) return; // 오른쪽 클릭 → 팬으로 버블업
      e.preventDefault();
      e.stopPropagation();
      setSelectedLayerId(layer.id);
      pushUndo();
      const zoom = zp.zoom;
      const frame = stageRef.current?.querySelector<HTMLElement>("[data-canvas-frame]");
      const frameRect = frame?.getBoundingClientRect();
      moveDragRef.current = {
        sx: e.clientX, sy: e.clientY, ox: layer.x, oy: layer.y,
        fhw: frameRect ? frameRect.width / zoom / 2 : Infinity,
        fhh: frameRect ? frameRect.height / zoom / 2 : Infinity,
        hw: selBox ? (selBox.w / 2) * layer.scale * layer.stretchW : 0,
        hh: selBox ? (selBox.h / 2) * layer.scale * layer.stretchH : 0,
      };
      const onMove = (ev: PointerEvent) => {
        const d = moveDragRef.current;
        if (!d) return;
        let nx = d.ox + (ev.clientX - d.sx) / zoom;
        let ny = d.oy + (ev.clientY - d.sy) / zoom;
        // Shift = 직선 이동(이동량 큰 축만 살리고 다른 축은 시작값 고정).
        if (ev.shiftKey) {
          if (Math.abs(ev.clientX - d.sx) >= Math.abs(ev.clientY - d.sy)) ny = d.oy;
          else nx = d.ox;
        }
        // 스냅 — 임계값 화면상 8px. 중앙 우선, 미달 시 4면(가장자리) 검사.
        const snap = 8 / zoom;
        const { fhw, fhh, hw, hh } = d;
        let gv = false, gh = false;
        let vEdge: "left" | "right" | undefined;
        let hEdge: "top" | "bottom" | undefined;
        // 중앙 스냅
        if (Math.abs(nx) < snap) { nx = 0; gv = true; }
        if (Math.abs(ny) < snap) { ny = 0; gh = true; }
        // 면 스냅 — 레이어 엣지가 캔버스 경계에 가까우면 달라붙음
        if (!gv && hw > 0) {
          if (Math.abs(nx - hw + fhw) < snap) { nx = hw - fhw; gv = true; vEdge = "left"; }
          else if (Math.abs(nx + hw - fhw) < snap) { nx = fhw - hw; gv = true; vEdge = "right"; }
        }
        if (!gh && hh > 0) {
          if (Math.abs(ny - hh + fhh) < snap) { ny = hh - fhh; gh = true; hEdge = "top"; }
          else if (Math.abs(ny + hh - fhh) < snap) { ny = fhh - hh; gh = true; hEdge = "bottom"; }
        }
        setSnapGuides(gv || gh ? { v: gv, h: gh, vEdge, hEdge } : null);
        patchLayer(layer.id, { x: nx, y: ny });
      };
      const onUp = () => {
        moveDragRef.current = null;
        setSnapGuides(null);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [zp.zoom, pushUndo, patchLayer, selBox],
  );

  // ── 합치기 → /api/composite (레이어별 transform + filters 전부 포함) ───────────────
  const handleComposite = useCallback(async () => {
    if (layers.length === 0 || composing) return;
    setComposing(true);
    setError(null);
    try {
      const frame = stageRef.current?.querySelector<HTMLElement>("[data-canvas-frame]");
      const frameW = frame?.offsetWidth || 640;
      // frameH fallback: offsetHeight가 0이면 customSize 종횡비로 계산 (aspect-ratio 미적용 방어)
      const frameH = frame?.offsetHeight || (frameW * (customSize.h || frameW) / (customSize.w || frameW));
      const outW = preset.w || customSize.w || frameW;
      const outH = preset.h || customSize.h || frameH;
      const kx = outW / frameW;
      const ky = outH / frameH;

      const visibleLayers = layers.filter(l => l.visible);
      const result = await compositeScene({
        layers: visibleLayers.map(l => {
          // CSS 표시 크기 = min(naturalW, frameW) × 비율유지 높이.
          // scale·stretch는 이 표시 크기에 곱해지므로, 출력 픽셀 타겟을 직접 계산해 보낸다.
          // naturalW=0이면 미로드 — frameW/frameH를 fallback으로 사용(기존 동작 유지).
          const nw = l.naturalW > 0 ? l.naturalW : frameW;
          const nh = l.naturalH > 0 ? l.naturalH : frameH;
          const displayW = Math.min(nw, frameW);
          const displayH = displayW * nh / nw;
          return {
            generationId: l.generationId,
            opacity: l.opacity,
            x: Math.round(l.x * kx),
            y: Math.round(l.y * ky),
            targetW: Math.max(1, Math.round(displayW * l.scale * l.stretchW * kx)),
            targetH: Math.max(1, Math.round(displayH * l.scale * l.stretchH * ky)),
            rotation: l.rotation,
            flipH: l.flipH,
            filters: {
              brightness: l.filters.brightness,
              saturation: l.filters.saturation,
              hue: l.filters.hue,
              contrast: l.filters.contrast,
              blur: l.filters.blur,
            },
          };
        }),
        sessionId: sessionId ?? undefined,
        outputWidth: outW,
        outputHeight: outH,
      });
      onComposited(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComposing(false);
    }
  }, [layers, composing, sessionId, preset.w, preset.h, customSize, onComposited]);

  // ── AI 합성 → /api/composite-ai (sharp 평탄화 + Codex img2img 자연스러운 합성) ──
  const handleAIComposite = useCallback(async () => {
    if (layers.length === 0 || composing || composingAI) return;
    setComposingAI(true);
    onGeneratingChange?.(true);
    setError(null);
    try {
      const frame = stageRef.current?.querySelector<HTMLElement>("[data-canvas-frame]");
      const frameW = frame?.offsetWidth || 640;
      const frameH = frame?.offsetHeight || (frameW * (customSize.h || frameW) / (customSize.w || frameW));
      const outW = preset.w || customSize.w || frameW;
      const outH = preset.h || customSize.h || frameH;
      const kx = outW / frameW;
      const ky = outH / frameH;

      const visibleLayers = layers.filter(l => l.visible);
      const result = await compositeSceneAI({
        layers: visibleLayers.map(l => {
          const nw = l.naturalW > 0 ? l.naturalW : frameW;
          const nh = l.naturalH > 0 ? l.naturalH : frameH;
          const displayW = Math.min(nw, frameW);
          const displayH = displayW * nh / nw;
          return {
            generationId: l.generationId,
            opacity: l.opacity,
            x: Math.round(l.x * kx),
            y: Math.round(l.y * ky),
            targetW: Math.max(1, Math.round(displayW * l.scale * l.stretchW * kx)),
            targetH: Math.max(1, Math.round(displayH * l.scale * l.stretchH * ky)),
            rotation: l.rotation,
            flipH: l.flipH,
            filters: {
              brightness: l.filters.brightness,
              saturation: l.filters.saturation,
              hue: l.filters.hue,
              contrast: l.filters.contrast,
              blur: l.filters.blur,
            },
          };
        }),
        sessionId: sessionId ?? undefined,
        outputWidth: outW,
        outputHeight: outH,
        // prompt 미전송 — 서버가 평탄화 이미지를 Claude Vision 으로 분석해 자동 생성한다.
      });
      onComposited(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setComposingAI(false);
      onGeneratingChange?.(false);
    }
  }, [layers, composing, composingAI, sessionId, preset.w, preset.h, customSize, onComposited, onGeneratingChange]);

  // 스테이지에 표시할 프레임 크기 — 출력 종횡비를 고정 영역에 contain-fit.
  const aspect = canvasSize.w && canvasSize.h ? canvasSize.w / canvasSize.h : 4 / 3;

  // 레일은 위→아래로 z-역순 표시(맨 위 = 최상단 = 배열 마지막).
  const railLayers = [...layers].reverse();

  // 마스크 브러시 컨트롤(브러시/지우개·크기·되돌리기·전체지우기) — 영역 편집 + 브러시 분리 바가 공유.
  const brushControls = (
    <>
      <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
        <button
          onClick={() => setBrushTool("brush")}
          className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${
            brushTool === "brush"
              ? "bg-[color:var(--accent)]/20 text-text-primary"
              : "text-text-muted hover:text-text-primary"
          }`}
          title="브러시 — 영역을 칠하기"
        >
          <Brush size={12} /> 브러시
        </button>
        <button
          onClick={() => setBrushTool("eraser")}
          className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${
            brushTool === "eraser"
              ? "bg-[color:var(--accent)]/20 text-text-primary"
              : "text-text-muted hover:text-text-primary"
          }`}
          title="지우개 — 칠한 영역 깎아내기"
        >
          <Eraser size={12} /> 지우개
        </button>
      </div>
      <input
        type="range"
        min={5}
        max={120}
        value={inpaintBrush}
        onChange={e => setInpaintBrush(Number(e.target.value))}
        className="w-20 accent-[color:var(--accent)]"
        title="브러시 크기"
      />
      <button
        onClick={undoBrushStroke}
        disabled={brushUndoCount === 0}
        className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-text-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30"
        title="직전 스트로크 되돌리기"
      >
        <RotateCcw size={12} /> 되돌리기
      </button>
      <button
        onClick={clearBrush}
        className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
        title="칠한 영역 전체 지우기"
      >
        전체지우기
      </button>
    </>
  );

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

      {/* 도구 스트립(한 줄) — 출력 규격 + (레이어 선택 시) 변형·생성형 메뉴. 생성형은 클릭 시
          즉시 실행하지 않고 하단 바를 띄운다(openTool). */}
      <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-border px-3.5 py-2 text-xs">
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
            <div className="relative flex h-7 w-16 overflow-hidden rounded-md border border-border bg-bg-panel focus-within:border-[color:var(--accent)]/60">
              <input
                type="number"
                min={1}
                value={customSize.w}
                onFocus={e => e.target.select()}
                onChange={e => setCustomSize(s => ({ ...s, w: Math.max(1, Number(e.target.value)) }))}
                className="h-full w-full bg-transparent pl-1.5 pr-5 text-text-primary focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <div className="absolute right-0 flex h-full w-4 flex-col border-l border-border">
                <button type="button" tabIndex={-1} onClick={() => setCustomSize(s => ({ ...s, w: s.w + 1 }))} className="flex flex-1 items-center justify-center text-text-muted hover:bg-bg-card hover:text-text-primary">
                  <ChevronUp className="h-2.5 w-2.5" />
                </button>
                <button type="button" tabIndex={-1} onClick={() => setCustomSize(s => ({ ...s, w: Math.max(1, s.w - 1) }))} className="flex flex-1 items-center justify-center border-t border-border text-text-muted hover:bg-bg-card hover:text-text-primary">
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
            ×
            <div className="relative flex h-7 w-16 overflow-hidden rounded-md border border-border bg-bg-panel focus-within:border-[color:var(--accent)]/60">
              <input
                type="number"
                min={1}
                value={customSize.h}
                onFocus={e => e.target.select()}
                onChange={e => setCustomSize(s => ({ ...s, h: Math.max(1, Number(e.target.value)) }))}
                className="h-full w-full bg-transparent pl-1.5 pr-5 text-text-primary focus:outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
              <div className="absolute right-0 flex h-full w-4 flex-col border-l border-border">
                <button type="button" tabIndex={-1} onClick={() => setCustomSize(s => ({ ...s, h: s.h + 1 }))} className="flex flex-1 items-center justify-center text-text-muted hover:bg-bg-card hover:text-text-primary">
                  <ChevronUp className="h-2.5 w-2.5" />
                </button>
                <button type="button" tabIndex={-1} onClick={() => setCustomSize(s => ({ ...s, h: Math.max(1, s.h - 1) }))} className="flex flex-1 items-center justify-center border-t border-border text-text-muted hover:bg-bg-card hover:text-text-primary">
                  <ChevronDown className="h-2.5 w-2.5" />
                </button>
              </div>
            </div>
          </span>
        )}
        <span className="text-text-muted/60">
          {canvasSize.w}×{canvasSize.h}
        </span>
        {selected && (
          <>
            <span className="mx-1 h-4 w-px bg-border" />
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
            {(
              [
                ["bg", "배경 제거", Sparkles],
                ["upscale", "업스케일", Sparkles],
                ["trim", "여백 제거", Scissors],
                ["inpaint", "영역 편집", Wand2],
                ["extract", "레이어 분리", Scissors],
              ] as const
            ).map(([kind, label, Icon]) => (
              <button
                key={kind}
                onClick={() => openTool(kind, selected)}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] ${
                  tool === kind
                    ? "border-[color:var(--accent)] bg-[color:var(--accent)]/10 text-text-primary"
                    : "border-[color:var(--accent)]/45 text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
                }`}
                title={`${label} — 하단 바에서 실행`}
              >
                <Icon size={11} /> {label}
              </button>
            ))}
            {onReskin && (
              <>
                <span className="mx-1 h-4 w-px bg-border" />
                <button
                  onClick={() => onReskin(selected.generationId, "color")}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                  title="리스킨 — ReskinPanel에서 색·재질 교체"
                >
                  <Palette size={11} /> 리스킨
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* 본문: 스테이지 + 레이어 레일 */}
      <div className="relative flex min-h-0 flex-1">
        {/* AI 합성 중 편집 잠금 오버레이 — 드래그·핸들·필터·레일 등 모든 입력을 차단. */}
        {composingAI && (
          <div className="absolute inset-0 z-50 flex cursor-not-allowed items-center justify-center bg-bg-app/60 backdrop-blur-[2px]">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-bg-card px-5 py-3 text-sm text-text-muted shadow-xl">
              <Loader2 size={15} className="animate-spin text-[color:var(--accent)]" />
              AI 합성 중… 편집이 잠겨 있습니다
            </div>
          </div>
        )}
        {/* 스테이지 */}
        <div className="relative flex min-w-0 flex-1 flex-col">
          {/* 이전 편집 복원 칩 — 저장본이 있을 때만(자동 적용 X, 사용자가 이어서/처음부터 선택). */}
          {restorable && !restoreDismissed && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-30 flex -translate-x-1/2 justify-center px-4">
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[color:var(--accent)]/50 bg-bg-card/95 py-1.5 pl-3 pr-1.5 text-xs shadow-2xl backdrop-blur">
                <RotateCcw size={13} className="text-[color:var(--accent)]" />
                <span className="text-text-primary">이 이미지의 이전 편집이 있어요</span>
                <button
                  onClick={applyRestore}
                  className="rounded-full bg-[color:var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white"
                >
                  이어서
                </button>
                <button
                  onClick={discardRestore}
                  className="rounded-full px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                  title="저장된 이전 편집을 폐기하고 새로 시작"
                >
                  처음부터
                </button>
                <button
                  onClick={() => setRestoreDismissed(true)}
                  className="rounded-full p-1 text-text-muted hover:text-text-primary"
                  title="닫기 (저장본은 유지)"
                >
                  <X size={13} />
                </button>
              </div>
            </div>
          )}
          <div
            ref={stageRef}
            className="relative m-4 flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-[#0c0c0d]"
            onPointerDown={zp.onRightPanDown}
            onPointerMove={zp.onPanPointerMove}
            onPointerUp={zp.onPanPointerUp}
            onContextMenu={e => e.preventDefault()}
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
                  style={{
                    backgroundSize: `${16 / zp.zoom}px ${16 / zp.zoom}px`,
                    backgroundPosition: `0 0, 0 ${8 / zp.zoom}px, ${8 / zp.zoom}px ${-8 / zp.zoom}px, ${-8 / zp.zoom}px 0`,
                  }}
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
                        onLoad={e => {
                          const el = e.currentTarget;
                          if (el.naturalWidth > 0 && el.naturalHeight > 0) {
                            patchLayer(layer.id, { naturalW: el.naturalWidth, naturalH: el.naturalHeight });
                          }
                        }}
                      />
                      {/* 인라인 마스크 캔버스 — 영역 편집(inpaint) + 분리(extract: brush·lasso)가 공유.
                          레이어와 같은 transform 을 CSS 가 적용(표시), 포인터는 점-좌표 역변환으로 원본 픽셀에 칠한다(정밀).
                          자유 올가미(free)는 이 캔버스의 pointer 이벤트로 드래그 경로를 받고(경로는 오버레이),
                          poly/magnetic 은 위 오버레이 캔버스가 클릭을 받는다. lasso 라도 mask commit 에 필요해 mount 유지.
                          마스크 commit 빨강 fill 은 보여선 안 되므로 lasso 일 때는 캔버스를 숨긴다(opacity-0). */}
                      {(tool === "inpaint" ||
                        (tool === "extract" && (extractMode === "lasso" || extractMode === "brush"))) &&
                        selectedLayerId === layer.id &&
                        inpaintNat && (
                        <canvas
                          ref={brushCanvasRef}
                          width={inpaintNat.w}
                          height={inpaintNat.h}
                          className={`absolute inset-0 h-full w-full cursor-crosshair ${
                            isLassoActive ? "opacity-0" : "opacity-50"
                          }`}
                          style={{
                            touchAction: "none",
                            // poly/magnetic 은 오버레이가 클릭을 받아야 하므로 brushCanvas 는 포인터 무시.
                            pointerEvents:
                              isLassoActive && lassoType !== "free"
                                ? "none"
                                : "auto",
                          }}
                          onPointerDown={e => {
                            if (lassoMoveOffset !== null) { onMoveDown(e); return; }
                            isLassoActive ? onLassoDown(e) : onBrushDown(e, layer);
                          }}
                          onPointerMove={e => {
                            if (lassoDraggingMove) { onMoveMove(e); return; }
                            isLassoActive ? onLassoMove(e) : onBrushMove(e, layer);
                          }}
                          onPointerUp={e => {
                            if (lassoDraggingMove) { onMoveUp(e); return; }
                            isLassoActive ? onLassoUp(e) : onBrushUp(e);
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {/* 올가미 경로 시각화 오버레이 — 화면 공간(artboard 좌표계). 흰선+검정 점선으로 경로를 그린다.
                      free 는 pointer 를 흘려보내 아래 brushCanvas 가 드래그를 받고, poly/magnetic 은 여기서
                      클릭/이동/더블클릭을 직접 처리한다. */}
                  {isLassoActive && (
                    <canvas
                      ref={lassoOverlayRef}
                      className="absolute inset-0 z-10"
                      style={{
                        width: "100%",
                        height: "100%",
                        pointerEvents: lassoMoveOffset !== null ? "auto" : lassoType === "free" ? "none" : "auto",
                        cursor: lassoMoveOffset !== null ? "move" : "crosshair",
                        touchAction: "none",
                      }}
                      // poly/magnetic 의 첫 클릭이 부모 data-canvas-frame 의 onPointerDown(레이어 선택 해제)으로
                      // 버블링되면 selectedLayerId=null → 하단 바·brushCanvas 가 사라지고 commit/snap 이 무력화된다.
                      // free 가 onLassoDown 에서 stopPropagation 하는 것과 동일하게, 여기서 차단한다.
                      onPointerDown={lassoType !== "free"
                        ? e => { if (lassoMoveOffset !== null) { onMoveDown(e); } else { e.stopPropagation(); } }
                        : lassoMoveOffset !== null ? onMoveDown : undefined
                      }
                      onClick={lassoType !== "free" && lassoMoveOffset === null ? onLassoOverlayClick : undefined}
                      onPointerMove={e => { onLassoOverlayMove(e); if (lassoDraggingMove) onMoveMove(e); }}
                      onPointerUp={e => { if (lassoDraggingMove) onMoveUp(e); }}
                      onDoubleClick={onLassoOverlayDblClick}
                    />
                  )}
                </div>

                {/* 선택 레이어 자유변형 핸들 — 클립 밖 오버레이라 캔버스 경계를 넘은 핸들도 잡힌다.
                    숨김 이미지로 레이어 박스 크기를 맞춰 핸들 위치 기준을 잡는다. */}
                {selected &&
                  tool !== "inpaint" &&
                  (
                    <div className="pointer-events-none absolute inset-0">
                        {/* 측정용(숨김·변형 없음) — 레이어 표시 크기(displayW/H) 확보. genId 바뀌면 remount. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          key={selected.generationId}
                          src={`/api/images/${selected.generationId}`}
                          alt=""
                          aria-hidden
                          className="block max-w-[min(56vw,640px)]"
                          style={{ position: "absolute", left: 0, top: 0, visibility: "hidden", pointerEvents: "none" }}
                          draggable={false}
                          onLoad={e =>
                            setSelBox({ w: e.currentTarget.offsetWidth, h: e.currentTarget.offsetHeight })
                          }
                        />
                        {selBox && (
                          // 핸들 박스 — scale 없이 회전·위치만. 크기는 selBox×scale 로 맞춰, 핸들/외곽선은
                          // 변형에 안 딸려가 항상 일정(포토샵식). 드래그 계산(onHandleDown)은 핸들 위치와 무관.
                          <div
                            style={{
                              position: "absolute",
                              left: "50%",
                              top: "50%",
                              width: Math.max(1, selBox.w * selected.scale * selected.stretchW),
                              height: Math.max(1, selBox.h * selected.scale * selected.stretchH),
                              transform: `translate(-50%, -50%) translate(${selected.x}px, ${selected.y}px) rotate(${selected.rotation}deg)`,
                            }}
                          >
                            {/* 점선 외곽선 — SVG 속성값을 zoom 으로 나눠 CSS scale 보정 */}
                            <svg
                              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
                            >
                              <rect
                                x="0" y="0" width="100%" height="100%"
                                fill="none"
                                stroke="var(--accent)"
                                strokeWidth={1.5 / zp.zoom}
                                strokeDasharray={`${5 / zp.zoom} ${4 / zp.zoom}`}
                              />
                            </svg>
                            {/* 핸들 — 자연 크기(12px) + scale(1/zoom) 역변환으로 래스터링 후 합성 */}
                            {(["tl", "tr", "bl", "br"] as const).map(c => (
                              <div
                                key={c}
                                onPointerDown={e => onHandleDown(e, "corner", selected)}
                                style={{
                                  position: "absolute",
                                  left: c.includes("l") ? 0 : "100%",
                                  top: c.includes("t") ? 0 : "100%",
                                  width: 12, height: 12,
                                  marginLeft: -6, marginTop: -6,
                                  transform: `scale(${1 / zp.zoom})`,
                                  transformOrigin: "center center",
                                  border: "1.5px solid var(--accent)",
                                  background: "white",
                                  borderRadius: 2,
                                  cursor: c === "tl" || c === "br" ? "nwse-resize" : "nesw-resize",
                                  pointerEvents: "auto",
                                }}
                              />
                            ))}
                            {(["t", "b"] as const).map(v => (
                              <div
                                key={v}
                                onPointerDown={e => onHandleDown(e, v, selected)}
                                style={{
                                  position: "absolute",
                                  left: "50%", top: v === "t" ? 0 : "100%",
                                  width: 12, height: 12,
                                  marginLeft: -6, marginTop: -6,
                                  transform: `scale(${1 / zp.zoom})`,
                                  transformOrigin: "center center",
                                  border: "1.5px solid var(--accent)",
                                  background: "white",
                                  borderRadius: 2,
                                  cursor: "ns-resize",
                                  pointerEvents: "auto",
                                }}
                              />
                            ))}
                            {(["l", "r"] as const).map(h => (
                              <div
                                key={h}
                                onPointerDown={e => onHandleDown(e, h, selected)}
                                style={{
                                  position: "absolute",
                                  left: h === "l" ? 0 : "100%", top: "50%",
                                  width: 12, height: 12,
                                  marginLeft: -6, marginTop: -6,
                                  transform: `scale(${1 / zp.zoom})`,
                                  transformOrigin: "center center",
                                  border: "1.5px solid var(--accent)",
                                  background: "white",
                                  borderRadius: 2,
                                  cursor: "ew-resize",
                                  pointerEvents: "auto",
                                }}
                              />
                            ))}
                            {/* 회전 노브 — 중심이 박스 상단에서 30 screen-px 위 */}
                            <div
                              onPointerDown={e => onHandleDown(e, "rot", selected)}
                              style={{
                                position: "absolute",
                                left: "50%", top: 0,
                                width: 13, height: 13,
                                marginLeft: -6.5,
                                marginTop: -30 / zp.zoom - 6.5,
                                transform: `scale(${1 / zp.zoom})`,
                                transformOrigin: "center center",
                                border: "1.5px solid var(--accent)",
                                background: "white",
                                borderRadius: "50%",
                                cursor: "grab",
                                pointerEvents: "auto",
                              }}
                            />
                          </div>
                        )}
                      </div>
                  )}
                {/* 스냅 가이드선 — 중앙 or 가장자리. */}
                {snapGuides?.v && !snapGuides.vEdge && (
                  <div className="pointer-events-none absolute bottom-0 left-1/2 top-0 w-px bg-[color:var(--accent)]" />
                )}
                {snapGuides?.vEdge === "left" && (
                  <div className="pointer-events-none absolute bottom-0 left-0 top-0 w-px bg-[color:var(--accent)]" />
                )}
                {snapGuides?.vEdge === "right" && (
                  <div className="pointer-events-none absolute bottom-0 right-0 top-0 w-px bg-[color:var(--accent)]" />
                )}
                {snapGuides?.h && !snapGuides.hEdge && (
                  <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-px bg-[color:var(--accent)]" />
                )}
                {snapGuides?.hEdge === "top" && (
                  <div className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-[color:var(--accent)]" />
                )}
                {snapGuides?.hEdge === "bottom" && (
                  <div className="pointer-events-none absolute left-0 right-0 bottom-0 h-px bg-[color:var(--accent)]" />
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
          <div ref={railRef} data-rail className="flex-1 overflow-auto p-2">
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
                  } ${draggingRowId === layer.id ? "opacity-60 shadow-lg" : ""}`}
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
                </div>
              );
            })}
          </div>

          {/* 선택 레이어 변형/배경제거 액션 + 필터 */}
          <div className="flex-none border-t border-border bg-bg-card p-3">
            {selected ? (
              <>
                <div className="mb-2 flex items-center gap-2">
                  <label className="w-8 text-[11px] text-text-muted">불투명</label>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={selected.opacity}
                    onChange={e => setOpacity(selected.id, Number(e.target.value))}
                    className="flex-1 accent-[color:var(--accent)]"
                  />
                  <b className="w-11 text-right font-mono text-[10px] font-medium text-text-muted">
                    {selected.opacity}%
                  </b>
                </div>
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
          {/* 합치기 — 단순(sharp)·AI(sharp+codex img2img) 2종. 필터 아래 상시 노출. */}
          <div className="flex-none border-t border-border p-3">
            <div className="flex gap-2">
              {/* 단순 합치기 (sharp 픽셀 병합) */}
              <button
                onClick={handleComposite}
                disabled={layers.length === 0 || composing || composingAI || busy}
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border bg-background text-sm font-medium disabled:opacity-40"
              >
                {composing ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> 합치는 중…
                  </>
                ) : (
                  `변환 (${layers.length}개)`
                )}
              </button>

              {/* AI 합성 (sharp 평탄화 + Codex img2img 재생성) */}
              <button
                onClick={handleAIComposite}
                disabled={layers.length === 0 || composing || composingAI || busy}
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
              >
                {composingAI ? (
                  <>
                    <Loader2 size={14} className="animate-spin" /> AI 합성 중…
                  </>
                ) : (
                  "AI 합성"
                )}
              </button>
            </div>
          </div>
        </aside>
      </div>

      {error && (
        <p className="flex-none px-4 pb-1 text-[11px] text-[color:var(--danger)]">{error}</p>
      )}

      {/* 도구 하단 바 — 선택한 메뉴를 여기서 실행(즉시 실행 X). tool 별로 내용 전환. */}
      {tool && selected && (
        <div className="pointer-events-none absolute bottom-6 left-0 right-[256px] z-40 flex justify-center px-4">
          <div className="pointer-events-auto flex max-w-[840px] flex-wrap items-center gap-2 rounded-xl border border-[color:var(--accent)]/50 bg-bg-card/95 px-3 py-2 shadow-2xl backdrop-blur">
            {tool === "inpaint" ? (
              <>
                <div className="flex w-full flex-col gap-1.5">
                  {/* 1행: 아이콘 + 레이블 + 서브모드 토글 + 도구 컨트롤 + × */}
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Wand2 size={14} className="text-[color:var(--accent)]" />
                    <span className="text-[11px] font-medium text-text-primary">영역 편집</span>
                    <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
                      <button
                        onClick={() => { if (inpaintMode !== "brush") { setInpaintMode("brush"); clearLassoState(); } }}
                        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${inpaintMode === "brush" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                      >
                        <Brush size={12} /> 브러시
                      </button>
                      <button
                        onClick={() => { if (inpaintMode !== "lasso") { setInpaintMode("lasso"); clearBrush(); } }}
                        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${inpaintMode === "lasso" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                      >
                        <Lasso size={12} /> 올가미
                      </button>
                    </div>
                    {inpaintMode === "brush" && brushControls}
                    {inpaintMode === "lasso" && (
                      <>
                        <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
                          {(["free", "poly", "magnetic"] as const).map(t => (
                            <button key={t} onClick={() => { setLassoType(t); clearLassoState(); }}
                              className={`flex h-6 items-center rounded px-2 text-[11px] ${lassoType === t ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                              title={t === "free" ? "자유 드래그" : t === "poly" ? "다각형" : "자석"}
                            >
                              {t === "free" ? "자유" : t === "poly" ? "다각형" : "자석"}
                            </button>
                          ))}
                        </div>
                        <button onClick={clearBrush} className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary">전체지우기</button>
                        {lassoType !== "free" && lassoPtCount >= 3 && (
                          <button onClick={commitLassoPoints} className="rounded-md border border-[color:var(--accent)] px-2 py-1 text-[11px] text-text-primary">완료 (Enter)</button>
                        )}
                      </>
                    )}
                    </div>
                    <button onClick={closeTool} className="flex-none rounded p-1 text-text-muted hover:text-text-primary"><X size={14} /></button>
                  </div>
                  {/* 2행: 참조 + 프롬프트 입력 + 실행 버튼들 */}
                  <div className="flex items-center gap-2">
                    {/* 참조 이미지 팝오버(선택) — 선택 시 인페인트의 둘째 첨부(참조)로 전달. */}
                    <div className="relative">
                      <button
                        onClick={() => setRefOpen(o => !o)}
                        className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] ${
                          refId
                            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary"
                            : "border-border text-text-muted hover:text-text-primary"
                        }`}
                        title="참조 이미지 — 프롬프트와 함께 인페인트에 사용(선택)"
                      >
                        <ImageIcon size={12} /> 참조{refId ? " ✓" : ""}
                      </button>
                      {refOpen && (
                        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg border border-border bg-bg-panel p-2 shadow-xl">
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-[11px] text-text-muted">참조 이미지 (선택)</span>
                            <div className="flex gap-0.5 rounded border border-border bg-bg-card p-0.5 text-[10px]">
                              {(["session", "gallery"] as const).map(scope => (
                                <button
                                  key={scope}
                                  onClick={() => setRefScope(scope)}
                                  className={`rounded px-1.5 py-0.5 ${
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
                          {(() => {
                            const list = refScope === "session" ? sessionRefs : galleryRefs;
                            if (list === null)
                              return <p className="py-2 text-center text-[10px] text-text-muted/60">불러오는 중…</p>;
                            if (list.length === 0)
                              return <p className="py-2 text-center text-[10px] text-text-muted/60">이미지 없음</p>;
                            return (
                              <div className="grid max-h-40 grid-cols-4 gap-1 overflow-y-auto">
                                {list.map(g => {
                                  const sel = refId === g.id;
                                  return (
                                    <button
                                      key={g.id}
                                      onClick={() => setRefId(sel ? null : g.id)}
                                      className={`relative aspect-square overflow-hidden rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/8px_8px] ${
                                        sel
                                          ? "border-[color:var(--accent)] ring-1 ring-[color:var(--accent)]"
                                          : "border-border hover:border-[color:var(--accent)]/50"
                                      }`}
                                      title={g.prompt ?? g.id}
                                    >
                                      {/* eslint-disable-next-line @next/next/no-img-element */}
                                      <img src={`/api/images/${g.id}`} alt="" className="h-full w-full object-contain" />
                                      {sel && (
                                        <span className="absolute right-0.5 top-0.5 rounded-full bg-[color:var(--accent)] px-1 text-[8px] font-bold text-white">
                                          ✓
                                        </span>
                                      )}
                                    </button>
                                  );
                                })}
                              </div>
                            );
                          })()}
                        </div>
                      )}
                    </div>
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
                    <button
                      onClick={handleObjectRemove}
                      disabled={inpaintBusy || !brushPainted}
                      className="flex h-7 items-center gap-1 rounded-lg border border-[color:var(--danger)]/50 px-2.5 text-xs font-medium text-[color:var(--danger)] hover:bg-[color:var(--danger)]/10 disabled:cursor-not-allowed disabled:opacity-40"
                      title="칠한 영역의 오브젝트를 지우고 주변 배경으로 채움"
                    >
                      <Trash2 size={13} /> 오브젝트 지우기
                    </button>
                  </div>
                </div>
              </>
            ) : tool === "extract" ? (
              <>
                <div className="flex w-full flex-col gap-1.5">
                  {/* 1행: 아이콘 + 레이블 + 서브모드 토글 + 도구 컨트롤 + × */}
                  <div className="flex items-center gap-2">
                    <div className="flex flex-1 flex-wrap items-center gap-2">
                    <Scissors size={14} className="text-[color:var(--accent)]" />
                    <span className="text-[11px] font-medium text-text-primary">레이어 분리</span>
                    {/* 입력(부위명)/브러시(칠한 영역)/올가미(폴리곤) 서브모드 토글. 전환 시 칠한 마스크 초기화. */}
                    <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
                      <button
                        onClick={() => { if (extractMode !== "text") { setExtractMode("text"); clearBrush(); } }}
                        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${extractMode === "text" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                        title="부위 이름으로 분리 (AI)"
                      >
                        <Tags size={12} /> 입력
                      </button>
                      <button
                        onClick={() => { if (extractMode !== "brush") { setExtractMode("brush"); clearBrush(); } }}
                        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${extractMode === "brush" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                        title="브러시 — 칠한 영역을 분리"
                      >
                        <Brush size={12} /> 브러시
                      </button>
                      <button
                        onClick={() => { if (extractMode !== "lasso") { setExtractMode("lasso"); clearBrush(); } }}
                        className={`flex h-6 items-center gap-1 rounded px-2 text-[11px] ${extractMode === "lasso" ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                        title="올가미 — 영역을 자유 폴리곤으로 둘러 분리"
                      >
                        <Lasso size={12} /> 올가미
                      </button>
                    </div>
                    {extractMode === "brush" && brushControls}
                    {/* 올가미 타입(자유/다각형/자석) + 전체지우기 + (점≥3) 완료. */}
                    {extractMode === "lasso" && (
                      <>
                        {!lassoCommittedRef.current ? (
                          /* ── 드로잉 모드 ── */
                          <>
                            <div className="flex gap-0.5 rounded-md border border-border bg-bg-panel p-0.5">
                              {(["free", "poly", "magnetic"] as const).map(t => (
                                <button
                                  key={t}
                                  onClick={() => { setLassoType(t); clearLassoState(); }}
                                  className={`flex h-6 items-center rounded px-2 text-[11px] ${lassoType === t ? "bg-[color:var(--accent)]/20 text-text-primary" : "text-text-muted hover:text-text-primary"}`}
                                  title={t === "free" ? "자유 — 드래그로 그리고 떼면 자동으로 닫힘" : t === "poly" ? "다각형 — 클릭으로 꼭짓점, 더블클릭/시작점 클릭으로 닫기" : "자석 — 이미지 경계선에 자동 스냅"}
                                >
                                  {t === "free" ? "자유" : t === "poly" ? "다각형" : "자석"}
                                </button>
                              ))}
                            </div>
                            <button onClick={clearBrush} className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary">전체지우기</button>
                            {lassoType !== "free" && lassoPtCount >= 3 && (
                              <button onClick={commitLassoPoints} className="rounded-md border border-[color:var(--accent)] px-2 py-1 text-[11px] text-text-primary">완료 (Enter)</button>
                            )}
                          </>
                        ) : lassoDraggingMove || lassoMoveOffset ? (
                          /* ── 이동 모드 ── */
                          <>
                            <span className="text-[11px] text-text-muted">드래그로 이동하세요</span>
                            <button
                              onClick={handleLassoMoveConfirm}
                              disabled={extracting}
                              className="flex h-6 items-center gap-1 rounded-lg bg-[color:var(--accent)] px-3 text-[11px] font-medium text-white disabled:opacity-40"
                            >
                              {extracting ? <><Loader2 size={12} className="animate-spin" /> 처리 중…</> : "확정"}
                            </button>
                            <button
                              onClick={handleLassoMoveCancel}
                              className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                            >
                              취소
                            </button>
                            <button
                              onClick={() => setLassoAiRestore(v => !v)}
                              className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] ${lassoAiRestore ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary" : "border-border text-text-muted hover:text-text-primary"}`}
                            >
                              AI 복원 {lassoAiRestore ? "ON" : "OFF"}
                            </button>
                          </>
                        ) : (
                          /* ── 액션 선택 모드 ── */
                          <>
                            <span className="text-[11px] text-text-muted">영역이 선택됐습니다</span>
                            <button
                              onClick={handleLassoCutout}
                              disabled={extracting}
                              className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
                            >
                              {extracting ? <><Loader2 size={12} className="animate-spin" /></> : "누끼 따기"}
                            </button>
                            <button
                              onClick={() => setLassoAiCutout(v => !v)}
                              className={`flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] ${lassoAiCutout ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary" : "border-border text-text-muted hover:text-text-primary"}`}
                              title="누끼 방식: OFF=즉시 픽셀 크롭, ON=AI 부드러운 누끼"
                            >
                              AI {lassoAiCutout ? "ON" : "OFF"}
                            </button>
                            <button
                              onClick={handleLassoDuplicate}
                              disabled={extracting}
                              className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
                            >
                              복제
                            </button>
                            <button
                              onClick={handleLassoMoveStart}
                              className="flex h-6 items-center rounded-lg border border-border px-2 text-[11px] text-text-muted hover:text-text-primary"
                            >
                              이동
                            </button>
                            <button
                              onClick={() => { clearLassoState(); setBrushPainted(false); }}
                              className="rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
                            >
                              다시 그리기
                            </button>
                          </>
                        )}
                      </>
                    )}
                    </div>
                    <button onClick={closeTool} className="flex-none rounded p-1 text-text-muted hover:text-text-primary"><X size={14} /></button>
                  </div>
                  {/* 2행: 이름 입력 + 부가 컨트롤 + 분리 버튼 */}
                  <div className="flex items-center gap-2">
                    <input
                      value={extractInput}
                      onChange={e => setExtractInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key !== "Enter") return;
                        if (extractMode === "text") handleExtract();
                        else handleExtractBrush();
                      }}
                      placeholder={extractMode === "text" ? "예: 머리, 무기" : "이 영역의 이름 (예: 머리)"}
                      disabled={extracting}
                      className="h-7 w-40 min-w-0 flex-1 rounded-md border border-border bg-bg-panel px-2 text-xs text-text-primary placeholder:text-text-muted/50 focus:border-[color:var(--accent)]/60 focus:outline-none"
                    />
                    {extractMode === "text" && (
                      <>
                        {/* AI 부위 제안 — 선택 시 부위명을 쉼표로 이어 붙임. */}
                        <div className="relative">
                          <AiSuggestButton loading={extractAiLoading} onClick={handleExtractAiSuggest} compact disabled={isCodex} />
                          {extractAiSuggestions && (
                            <AiSuggestDropdown
                              suggestions={extractAiSuggestions}
                              placement="bottom"
                              width="w-[280px]"
                              onSelect={body => setExtractInput(prev => (prev.trim() ? `${prev.trim()}, ${body}` : body))}
                              onClose={() => setExtractAiSuggestions(null)}
                            />
                          )}
                        </div>
                        {/* 원본 복원 토글 — 가려진 부위까지 복원(off=보이는 픽셀만). 텍스트 추출에서만 유효. */}
                        <button
                          onClick={() => setExtractAutoRestore(v => !v)}
                          className={`flex h-7 items-center gap-1 rounded-md border px-2 text-[11px] ${extractAutoRestore ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15 text-text-primary" : "border-border text-text-muted hover:text-text-primary"}`}
                          title="가려진 부위까지 복원해 완전한 레이어로 추출 (끄면 보이는 부분만)"
                        >
                          원본 복원 {extractAutoRestore ? "ON" : "OFF"}
                        </button>
                      </>
                    )}
                    <button
                      onClick={extractMode === "text" ? handleExtract : handleExtractBrush}
                      disabled={extracting || !extractInput.trim() || (extractMode !== "text" && !brushPainted)}
                      className="flex h-7 items-center gap-1.5 rounded-lg bg-[color:var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-40"
                    >
                      {extracting ? (
                        <>
                          <Loader2 size={13} className="animate-spin" /> 분리 중…
                        </>
                      ) : (
                        "분리 ▸"
                      )}
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <>
                {tool === "trim" ? (
                  <Scissors size={14} className="text-[color:var(--accent)]" />
                ) : (
                  <Sparkles size={14} className="text-[color:var(--accent)]" />
                )}
                <span className="text-[11px] font-medium text-text-primary">
                  {tool === "bg" ? "배경 제거" : tool === "upscale" ? "업스케일" : "여백 제거"}
                </span>
                <span className="text-[11px] text-text-muted">
                  {tool === "bg"
                    ? "선택 레이어의 배경을 투명하게 (AI)"
                    : tool === "upscale"
                      ? "선택 레이어를 고화질로 (AI)"
                      : "선택 레이어의 투명 여백을 잘라냄 (sharp)"}
                </span>
                <button
                  onClick={() => {
                    void runLayerOp(tool, selected.id).then(closeTool);
                  }}
                  disabled={!!layerOp}
                  className="flex h-7 items-center gap-1.5 rounded-lg bg-[color:var(--accent)] px-3 text-xs font-medium text-white disabled:opacity-40"
                >
                  {layerOp ? (
                    <>
                      <Loader2 size={13} className="animate-spin" /> 처리 중…
                    </>
                  ) : (
                    "실행 ▸"
                  )}
                </button>
              </>
            )}
            {tool !== "inpaint" && tool !== "extract" && (
              <button onClick={closeTool} className="rounded p-1 text-text-muted hover:text-text-primary">
                <X size={14} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
