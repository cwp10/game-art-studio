"use client";

import { Loader2, Scissors, X } from "lucide-react";
import { useState } from "react";

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
  onClose: () => void;
  onResult?: (result: {
    generationId: string;
    width: number;
    height: number;
    kind: "nine_slice" | "nine_slice_scaled";
  }) => void;
};

type ApiResult = { generationId: string; imagePath: string; width: number; height: number };

export function NineSliceEditor({ generationId, sessionId, onClose, onResult }: Props) {
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

  const imageUrl = `/api/images/${generationId}`;

  // inset 유효성 — 자연 크기를 알 때만 검사. 좌+우(또는 상+하)가 이미지 폭(높이)을 넘으면 중앙이 사라짐.
  const insetInvalid =
    natural !== null &&
    (insetLeft + insetRight >= natural.w || insetTop + insetBottom >= natural.h);

  const resizeReady = outWidth.trim() !== "" && outHeight.trim() !== "";

  const run = async (
    endpoint: "/api/nine-slice" | "/api/nine-slice-scale",
    kind: "nine_slice" | "nine_slice_scaled",
  ) => {
    if (busy || insetInvalid) return;
    setBusy(true);
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
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ApiResult;
      onResult?.({ generationId: data.generationId, width: data.width, height: data.height, kind });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
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
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Scissors size={14} /> 9-slice 편집기
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 gap-4 overflow-y-auto p-4">
        {/* 좌: 원본 미리보기 + 슬라이스 라인 오버레이 */}
        <div className="flex flex-1 flex-col gap-2">
          <p className="text-xs font-medium text-text-muted">원본 미리보기</p>
          <div className="relative inline-flex max-h-[60vh] items-center justify-center self-start checkerboard overflow-hidden rounded-lg border border-border">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={imageUrl}
              alt="9-slice 원본"
              className="block max-h-[60vh] max-w-full object-contain"
              onLoad={e => {
                const img = e.currentTarget;
                setNatural({ w: img.naturalWidth, h: img.naturalHeight });
              }}
            />
            {/* 슬라이스 라인 — 1px dashed accent. 자연 크기 기준 %. */}
            {linePct && (
              <>
                <div
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[color:var(--accent)]"
                  style={{ top: linePct.top }}
                />
                <div
                  className="pointer-events-none absolute inset-x-0 border-t border-dashed border-[color:var(--accent)]"
                  style={{ bottom: linePct.bottom }}
                />
                <div
                  className="pointer-events-none absolute inset-y-0 border-l border-dashed border-[color:var(--accent)]"
                  style={{ left: linePct.left }}
                />
                <div
                  className="pointer-events-none absolute inset-y-0 border-l border-dashed border-[color:var(--accent)]"
                  style={{ right: linePct.right }}
                />
              </>
            )}
          </div>
          {natural && (
            <p className="text-[11px] text-text-muted/60">
              원본 {natural.w}×{natural.h}px
            </p>
          )}
        </div>

        {/* 우: inset 설정 + 리사이즈 출력 */}
        <div className="flex w-48 shrink-0 flex-col gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-muted">Inset 설정 (px)</p>
            <InsetInput label="좌" value={insetLeft} onChange={setInsetLeft} />
            <InsetInput label="우" value={insetRight} onChange={setInsetRight} />
            <InsetInput label="상" value={insetTop} onChange={setInsetTop} />
            <InsetInput label="하" value={insetBottom} onChange={setInsetBottom} />
            {insetInvalid && (
              <p className="text-[11px] text-[color:var(--danger)]">
                inset 합이 원본 크기를 넘습니다 — 중앙 영역이 없습니다.
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-muted">리사이즈 출력 (선택)</p>
            <SizeInput label="너비" value={outWidth} onChange={setOutWidth} />
            <SizeInput label="높이" value={outHeight} onChange={setOutHeight} />
            <p className="text-[11px] text-text-muted/50">
              너비·높이를 입력하면 모서리를 유지한 채 늘립니다.
            </p>
          </div>
        </div>
      </div>

      {error && (
        <p className="mx-auto w-full max-w-[880px] px-4 pb-2 text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      )}

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
        <button
          onClick={onClose}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        <button
          onClick={() => run("/api/nine-slice", "nine_slice")}
          disabled={busy || insetInvalid}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-border text-sm text-text-primary hover:bg-bg-card disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Scissors size={14} />} 그리드 미리보기
        </button>
        <button
          onClick={() => run("/api/nine-slice-scale", "nine_slice_scaled")}
          disabled={busy || insetInvalid || !resizeReady}
          className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null} 리사이즈 출력
        </button>
      </footer>
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

/** 출력 크기 입력 — 빈 문자열 허용(미설정). */
function SizeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <span className="w-6 shrink-0">{label}</span>
      <input
        type="number"
        min={1}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder="px"
        className="h-7 w-full rounded-lg border border-border bg-bg-card px-2 text-xs tabular-nums text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
      />
      <span className="text-text-muted/50">px</span>
    </label>
  );
}
