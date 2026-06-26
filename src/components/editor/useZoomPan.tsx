"use client";

import { Hand, Pencil, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useRef, useState } from "react";

/**
 * useZoomPan — MaskCanvas/LayerCanvas 공유 줌·팬 훅.
 *
 * 16:10 뷰박스 안에서 캔버스 스택을 CSS transform 으로 줌/팬한다. 원본 픽셀·stroke 좌표를
 * 건드리지 않으므로 export(1/fitScale 역산) 수식은 그대로 안전하다. 순수 상태 로직만 담당.
 */

export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export type ZoomPan = {
  zoom: number;
  pan: { x: number; y: number };
  panMode: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  setZoom: (z: number) => void;
  resetView: () => void;
  togglePanMode: () => void;
  /**
   * 마우스 커서 위치 기준 anchor 줌. containerEl 은 (transform 이 걸리지 않은) 뷰박스 div.
   * delta 양수=줌인 / 음수=줌아웃, 크기가 실제 줌 변화량. clamp 후 ratio 로 pan 을 재계산해 커서 아래 픽셀을 고정한다.
   */
  zoomAtPoint: (containerEl: HTMLElement, clientX: number, clientY: number, delta: number) => void;
  /** panMode 일 때만 캔버스 위 포인터 드래그를 팬으로 소비. 그리기 핸들러보다 먼저 호출. */
  onPanPointerDown: (e: React.PointerEvent) => void;
  onPanPointerMove: (e: React.PointerEvent) => void;
  onPanPointerUp: (e: React.PointerEvent) => void;
  /** 오른쪽 클릭 드래그로 팬. panMode 무관하게 항상 동작. */
  onRightPanDown: (e: React.PointerEvent) => void;
  /** pan 을 dx/dy 만큼 이동. 화살표·WASD 키 이동에 사용. */
  movePan: (dx: number, dy: number) => void;
};

export function useZoomPan(): ZoomPan {
  // zoom·pan 을 한 상태로 묶는다. zoomAtPoint 는 둘을 함께 읽고 써야 하므로 단일 함수형
  // 업데이터로 원자적으로 갱신한다 — 빠른 스크롤에서 매 틱 누적(functional updater 는 직전
  // pending 값을 본다)되고, StrictMode 이중 호출에도 멱등하다.
  const [view, setView] = useState<{ zoom: number; pan: { x: number; y: number } }>({
    zoom: 1,
    pan: { x: 0, y: 0 },
  });
  const [panMode, setPanMode] = useState(false);
  // 드래그 시작 시점의 clientXY + pan 기준점. 팬 중에만 유효.
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  const setZoom = useCallback(
    (z: number) => setView(v => ({ ...v, zoom: clampZoom(z) })),
    [],
  );
  const zoomIn = useCallback(
    () => setView(v => ({ ...v, zoom: clampZoom(v.zoom + ZOOM_STEP) })),
    [],
  );
  const zoomOut = useCallback(
    () => setView(v => ({ ...v, zoom: clampZoom(v.zoom - ZOOM_STEP) })),
    [],
  );
  const resetView = useCallback(() => setView({ zoom: 1, pan: { x: 0, y: 0 } }), []);
  const togglePanMode = useCallback(() => setPanMode(v => !v), []);

  const zoomAtPoint = useCallback(
    (containerEl: HTMLElement, clientX: number, clientY: number, delta: number) => {
      const rect = containerEl.getBoundingClientRect();
      // transform-origin:center + 중앙 배치라 앵커는 "뷰박스 중심 기준 커서 오프셋"이다.
      const cx = clientX - rect.left - rect.width / 2;
      const cy = clientY - rect.top - rect.height / 2;
      setView(({ zoom: oldZoom, pan: oldPan }) => {
        const newZoom = clampZoom(oldZoom + delta);
        const ratio = newZoom / oldZoom; // clamp 후 비율 — 경계에서 1 → pan 고정.
        return {
          zoom: newZoom,
          pan: { x: cx - (cx - oldPan.x) * ratio, y: cy - (cy - oldPan.y) * ratio },
        };
      });
    },
    [],
  );

  const onPanPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!panMode) return;
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {}
      dragRef.current = { sx: e.clientX, sy: e.clientY, px: view.pan.x, py: view.pan.y };
    },
    [panMode, view.pan.x, view.pan.y],
  );

  const onRightPanDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 2) return;
      e.preventDefault();
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {}
      dragRef.current = { sx: e.clientX, sy: e.clientY, px: view.pan.x, py: view.pan.y };
    },
    [view.pan.x, view.pan.y],
  );

  const onPanPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setView(v => ({ ...v, pan: { x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) } }));
  }, []);

  const onPanPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  const movePan = useCallback(
    (dx: number, dy: number) => setView(v => ({ ...v, pan: { x: v.pan.x + dx, y: v.pan.y + dy } })),
    [],
  );

  return {
    zoom: view.zoom,
    pan: view.pan,
    panMode,
    zoomIn,
    zoomOut,
    setZoom,
    resetView,
    togglePanMode,
    zoomAtPoint,
    onPanPointerDown,
    onPanPointerMove,
    onPanPointerUp,
    onRightPanDown,
    movePan,
  };
}

/**
 * contain-fit 산출. 뷰박스는 가용 폭(=UI 너비) 전체를 쓰고, 높이는 16:10 기준이되 가용
 * 높이를 넘지 않게 클램프한다(가용 높이가 짧으면 더 납작한 박스). 그 안에 이미지를 종횡비
 * 유지로 넣는다(레터박스 허용). fitScale 은 export 의 scale 로 재사용된다.
 */
export function fitBox(availW: number, availH: number, imageWidth: number, imageHeight: number) {
  const viewW = Math.max(1, Math.floor(availW));
  const viewH = Math.max(1, Math.min(Math.round((viewW * 10) / 16), Math.floor(availH)));
  const fitScale = Math.min(viewW / imageWidth, viewH / imageHeight);
  const displayW = Math.max(1, Math.round(imageWidth * fitScale));
  const displayH = Math.max(1, Math.round(imageHeight * fitScale));
  return { viewW, viewH, fitScale, displayW, displayH };
}

/**
 * 포인터 → 캔버스 내부(display-px) 좌표. getBoundingClientRect 는 CSS transform(zoom/pan)을
 * 반영하므로 rect 비율로 역산하면 어떤 줌/팬에서도 정확한 display-px 가 나온다. export 무변경.
 */
export function rectRatioPoint(
  e: React.PointerEvent<HTMLCanvasElement>,
): { x: number; y: number } {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (el.width / rect.width),
    y: (e.clientY - rect.top) * (el.height / rect.height),
  };
}

/** 뷰박스 우하단 줌/팬 컨트롤. transform 밖에 두어 줌에 딸려가지 않는다. */
export function ZoomPanControls({ zp }: { zp: ZoomPan }) {
  return (
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
      <button
        onClick={zp.togglePanMode}
        className={`flex items-center gap-1 rounded border px-2 py-1 ${
          zp.panMode
            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
            : "border-border text-text-muted hover:text-text-primary"
        }`}
        title={zp.panMode ? "이동 모드 (드래그로 팬)" : "편집 모드 (드래그로 그리기)"}
      >
        {zp.panMode ? (
          <>
            <Hand size={12} /> 이동
          </>
        ) : (
          <>
            <Pencil size={12} /> 편집
          </>
        )}
      </button>
    </div>
  );
}
