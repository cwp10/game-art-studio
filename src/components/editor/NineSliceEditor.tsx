"use client";

import { ArrowLeft, Loader2 } from "lucide-react";
import { useRef, useState } from "react";

import { jsonFetch } from "@/lib/api/client";

/**
 * NineSliceEditor — 단일 이미지를 9-slice 영역으로 분할하는 편집기.
 *
 * 4개의 inset(좌/우/상/하)으로 모서리·가장자리·중앙 9개 영역을 정의하고,
 * 원본 위에 슬라이스 라인을 오버레이로 보여준다. "그리드 미리보기"는 슬라이스 선이
 * 구워진 가이드 이미지를(POST /api/nine-slice), "리사이즈 출력"은 inset 을 유지한 채
 * 지정 크기로 늘린 결과를(POST /api/nine-slice-scale) 서버 후처리로 요청한다.
 * 결과는 onResult 로 부모에 전달돼 chat 결과 카드로 삽입된다.
 */

type Props = {
  generationId: string; // 슬라이싱할 원본 이미지 id
  sessionId: string | null;
  hideHeader?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
  onResult?: (result: {
    generationId: string;
    width: number;
    height: number;
    kind: "nine_slice" | "nine_slice_scaled" | "nine_slice_trimmed";
  }) => void;
};

type ApiResult = { generationId: string; imagePath: string; width: number; height: number };

type DragAxis = "top" | "bottom" | "left" | "right";

export function NineSliceEditor({ generationId, sessionId, hideHeader, onBusyChange, onClose, onResult }: Props) {
  const [insetLeft, setInsetLeft] = useState(20);
  const [insetRight, setInsetRight] = useState(20);
  const [insetTop, setInsetTop] = useState(20);
  const [insetBottom, setInsetBottom] = useState(20);
  // 리사이즈 출력 크기 — 빈 문자열이면 미설정(버튼 비활성).
  const [outWidth, setOutWidth] = useState("");
  const [outHeight, setOutHeight] = useState("");
  // 원본 자연 크기 — <img onLoad> 로 캡처해 inset 유효성·라인 % 계산에 사용.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 드래그 핸들러의 onMove 클로저는 마운트 시 고정돼 state 를 직접 읽으면 stale 값이 된다.
  // inset 값을 ref 로 미러링하고, 모든 inset 쓰기를 아래 wrapper 로 통일해 일관성을 유지한다.
  const imageRef = useRef<HTMLImageElement>(null);
  const dragging = useRef<DragAxis | null>(null);
  const insetTopRef = useRef(20);
  const insetBottomRef = useRef(20);
  const insetLeftRef = useRef(20);
  const insetRightRef = useRef(20);
  const setTop = (v: number) => { insetTopRef.current = v; setInsetTop(v); };
  const setBottom = (v: number) => { insetBottomRef.current = v; setInsetBottom(v); };
  const setLeft = (v: number) => { insetLeftRef.current = v; setInsetLeft(v); };
  const setRight = (v: number) => { insetRightRef.current = v; setInsetRight(v); };

  /* eslint-disable react-hooks/refs -- refs accessed inside event/mousemove handlers, not during render */
  // 점선 핸들 드래그 → inset 실시간 갱신. 반대쪽 inset 은 ref 에서 읽어 stale 회피.
  const startDrag = (axis: DragAxis) => (e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = axis;
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!imageRef.current || !natural) return;
      const rect = imageRef.current.getBoundingClientRect();
      if (axis === "top") {
        const raw = Math.round(((ev.clientY - rect.top) / rect.height) * natural.h);
        setTop(Math.max(0, Math.min(raw, natural.h - insetBottomRef.current - 1)));
      } else if (axis === "bottom") {
        const raw = Math.round(((rect.bottom - ev.clientY) / rect.height) * natural.h);
        setBottom(Math.max(0, Math.min(raw, natural.h - insetTopRef.current - 1)));
      } else if (axis === "left") {
        const raw = Math.round(((ev.clientX - rect.left) / rect.width) * natural.w);
        setLeft(Math.max(0, Math.min(raw, natural.w - insetRightRef.current - 1)));
      } else {
        const raw = Math.round(((rect.right - ev.clientX) / rect.width) * natural.w);
        setRight(Math.max(0, Math.min(raw, natural.w - insetLeftRef.current - 1)));
      }
    };

    const onUp = () => {
      dragging.current = null;
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };
  /* eslint-enable react-hooks/refs */

  const imageUrl = `/api/images/${generationId}`;

  // inset 유효성 — 자연 크기를 알 때만 검사. 좌+우(또는 상+하)가 이미지 폭(높이)을 넘으면 중앙이 사라짐.
  const insetInvalid =
    natural !== null &&
    (insetLeft + insetRight >= natural.w || insetTop + insetBottom >= natural.h);

  const resizeReady = outWidth.trim() !== "" && outHeight.trim() !== "";

  const run = async (
    endpoint: "/api/nine-slice" | "/api/nine-slice-scale" | "/api/nine-slice-trim",
    kind: "nine_slice" | "nine_slice_scaled" | "nine_slice_trimmed",
  ) => {
    if (busy || insetInvalid) return;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        generationId,
        insetLeft,
        insetRight,
        insetTop,
        insetBottom,
        sessionId: sessionId ?? undefined,
      };
      if (kind === "nine_slice_scaled") {
        body.targetWidth = Number(outWidth);
        body.targetHeight = Number(outHeight);
      }
      const res = await jsonFetch(endpoint, "POST", body);
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ApiResult;
      onResult?.({ generationId: data.generationId, width: data.width, height: data.height, kind });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  };

  // 라인 위치 — 자연 크기 기준 %. 자연 크기를 모르면(로드 전) 라인 숨김.
  const linePct = natural
    ? {
        top: `${(insetTop / natural.h) * 100}%`,
        bottom: `${(insetBottom / natural.h) * 100}%`,
        left: `${(insetLeft / natural.w) * 100}%`,
        right: `${(insetRight / natural.w) * 100}%`,
      }
    : null;

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      {!hideHeader && (
        <header className="flex h-[50px] flex-none items-center gap-3 border-b border-border px-3.5">
          <button
            onClick={onClose}
            className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
            title="대화로 돌아가기"
          >
            <ArrowLeft size={14} /> 대화로 돌아가기
          </button>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-medium text-text-primary">9-Slice 편집기</span>
            <span className="text-[11px] text-text-muted">모서리를 유지한 채 크기를 조절합니다</span>
          </div>
        </header>
      )}

      {/* 도구 스트립 — 출력 규격(리사이즈). 캔버스 에디터 상단 스트립과 동일 위치. */}
      <div className="flex flex-none flex-wrap items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
        <span className="text-text-muted">리사이즈 출력</span>
        <input
          type="number"
          min={1}
          value={outWidth}
          onChange={e => setOutWidth(e.target.value)}
          placeholder="너비"
          className="h-7 w-20 rounded-md border border-border bg-bg-panel px-2 tabular-nums text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
        />
        <span className="text-text-muted/50">×</span>
        <input
          type="number"
          min={1}
          value={outHeight}
          onChange={e => setOutHeight(e.target.value)}
          placeholder="높이"
          className="h-7 w-20 rounded-md border border-border bg-bg-panel px-2 tabular-nums text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
        />
        <span className="text-text-muted/50">입력 시 모서리를 유지한 채 늘립니다(미입력 시 그리드 미리보기만)</span>
        {natural && (
          <span className="ml-auto tabular-nums text-text-muted/60">원본 {natural.w}×{natural.h}px</span>
        )}
      </div>

      {/* 본문 — 중앙 스테이지(미리보기) + 우측 레일(옵션·액션). 캔버스 에디터와 동일 골격. */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative m-4 flex flex-1 items-center justify-center overflow-hidden rounded-xl border border-border bg-[#0c0c0d]">
            <div className="relative inline-flex max-h-full items-center justify-center checkerboard overflow-hidden rounded-lg border border-border">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imageRef}
                src={imageUrl}
                alt="9-slice 원본"
                className="block max-h-[78vh] max-w-full object-contain"
                onLoad={e => {
                  const img = e.currentTarget;
                  setNatural({ w: img.naturalWidth, h: img.naturalHeight });
                  setOutWidth(v => v || String(img.naturalWidth));
                  setOutHeight(v => v || String(img.naturalHeight));
                }}
              />
              {/* 슬라이스 라인 — dashed accent. 8px 히트 영역을 가진 드래그 핸들. 자연 크기 기준 %. */}
              {linePct && (
                <>
                  {/* 상단 — ns-resize */}
                  <div
                    onMouseDown={startDrag("top")}
                    className="pointer-events-auto absolute inset-x-0 z-10 flex cursor-ns-resize items-center justify-center"
                    style={{ top: `calc(${linePct.top} - 4px)`, height: "8px" }}
                  >
                    <div className="w-full border-t border-dashed border-[color:var(--accent)]" />
                  </div>
                  {/* 하단 — ns-resize */}
                  <div
                    onMouseDown={startDrag("bottom")}
                    className="pointer-events-auto absolute inset-x-0 z-10 flex cursor-ns-resize items-center justify-center"
                    style={{ bottom: `calc(${linePct.bottom} - 4px)`, height: "8px" }}
                  >
                    <div className="w-full border-t border-dashed border-[color:var(--accent)]" />
                  </div>
                  {/* 좌측 — ew-resize */}
                  <div
                    onMouseDown={startDrag("left")}
                    className="pointer-events-auto absolute inset-y-0 z-10 flex cursor-ew-resize items-center justify-center"
                    style={{ left: `calc(${linePct.left} - 4px)`, width: "8px" }}
                  >
                    <div className="h-full border-l border-dashed border-[color:var(--accent)]" />
                  </div>
                  {/* 우측 — ew-resize */}
                  <div
                    onMouseDown={startDrag("right")}
                    className="pointer-events-auto absolute inset-y-0 z-10 flex cursor-ew-resize items-center justify-center"
                    style={{ right: `calc(${linePct.right} - 4px)`, width: "8px" }}
                  >
                    <div className="h-full border-l border-dashed border-[color:var(--accent)]" />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* 우측 레일 — inset 옵션(레이어 레일 자리) + 하단 액션(합치기 자리). */}
        <div className="flex w-[256px] flex-none flex-col border-l border-border bg-bg-panel">
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            <p className="text-xs text-text-muted/70">
              미리보기의 점선을 드래그해 inset 을 설정하세요.
            </p>
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-1 text-xs text-text-muted select-none">
                <span className="transition-transform group-open:rotate-90">▶</span>
                <span>미세 조정</span>
                <span className="ml-auto tabular-nums text-text-muted/60">
                  L:{insetLeft} R:{insetRight} T:{insetTop} B:{insetBottom}
                </span>
              </summary>
              <div className="mt-2 space-y-2">
                <InsetInput label="좌" value={insetLeft} onChange={setLeft} />
                <InsetInput label="우" value={insetRight} onChange={setRight} />
                <InsetInput label="상" value={insetTop} onChange={setTop} />
                <InsetInput label="하" value={insetBottom} onChange={setBottom} />
              </div>
            </details>
            {insetInvalid && (
              <p className="text-[11px] text-[color:var(--danger)]">inset 합이 원본 크기를 넘습니다 — 중앙 영역이 없습니다.</p>
            )}
            {error && <p className="text-[11px] text-[color:var(--danger)]">{error}</p>}
          </div>
          <div className="flex flex-none flex-col gap-2 border-t border-border p-3">
<button
              onClick={() => run("/api/nine-slice-scale", "nine_slice_scaled")}
              disabled={busy || insetInvalid || !resizeReady}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
              title={!resizeReady ? "리사이즈 출력 크기를 입력하세요" : ""}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} 리사이즈 출력 ▸
            </button>
            <button
              onClick={() => run("/api/nine-slice-trim", "nine_slice_trimmed")}
              disabled={busy || insetInvalid}
              className="flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[color:var(--accent)] text-sm font-medium text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10 disabled:opacity-40"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null} 최적화 출력 ▸
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}

/** inset 숫자 입력 — 0 이상 정수. */
function InsetInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <span className="w-6 shrink-0">{label}</span>
      <input
        type="number"
        min={0}
        value={value}
        onChange={e => onChange(Math.max(0, Number(e.target.value) || 0))}
        className="h-7 w-full rounded-lg border border-border bg-bg-card px-2 text-xs tabular-nums text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
      />
      <span className="text-text-muted/50">px</span>
    </label>
  );
}
