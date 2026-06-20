"use client";

import { Gamepad2, Plus, X } from "lucide-react";
import { useState } from "react";
import { PanelFooter } from "./PanelFooter";

/**
 * ButtonStateEditor — 단일 이미지를 UI 버튼의 3가지 상태(normal/hover/pressed)로 변환하는 편집기.
 *
 * hover 는 밝기·채도를 올린 버전, pressed 는 밝기·채도를 낮추고 살짝 축소한 버전을
 * 서버 후처리로 요청한다(POST /api/button-states). 한 번의 호출로 3장을 모두 만들어
 * normal/hover/pressed 결과를 반환받고, onResult 로 부모에 전달해 chat 결과 카드 3개로 삽입한다.
 * 생성 후에도 패널을 닫지 않고 각 슬롯에 결과를 표시 — 슬라이더를 조절해 다시 생성하거나,
 * 슬롯별 "채팅에 추가"(onAddOne) 로 원하는 상태만 개별 삽입할 수 있다.
 */

type StateKey = "normal" | "hover" | "pressed";

type ApiSlot = { generationId: string; imagePath: string; width: number; height: number };
type ApiResult = { normal: ApiSlot; hover: ApiSlot; pressed: ApiSlot };

type Props = {
  generationId: string;
  sessionId: string | null;
  onClose: () => void;
  /** 3종 생성 성공 시 1회 호출 — 부모가 chat 카드 3개를 일괄 삽입. */
  onResult?: (results: {
    normal: { generationId: string; width: number; height: number };
    hover: { generationId: string; width: number; height: number };
    pressed: { generationId: string; width: number; height: number };
  }) => void;
  /** 슬롯별 "채팅에 추가" — 한 상태만 개별 삽입(선택). onResult 의 일괄 삽입과 별개. */
  onAddOne?: (result: { generationId: string; width: number; height: number; state: StateKey }) => void;
};

const LABELS: Record<StateKey, string> = {
  normal: "Normal",
  hover: "Hover",
  pressed: "Pressed",
};

export function ButtonStateEditor({ generationId, sessionId, onClose, onResult, onAddOne }: Props) {
  const [hoverBrightness, setHoverBrightness] = useState(1.25);
  const [hoverSaturation, setHoverSaturation] = useState(1.15);
  const [pressedBrightness, setPressedBrightness] = useState(0.75);
  const [pressedSaturation, setPressedSaturation] = useState(0.85);
  const [pressedScale, setPressedScale] = useState(0.95);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 생성 결과 — null 이면 생성 전(3슬롯 모두 원본 미리보기). 비null 이면 각 상태 결과.
  const [results, setResults] = useState<Record<StateKey, { generationId: string; width: number; height: number }> | null>(null);

  const originalUrl = `/api/images/${generationId}`;

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/button-states", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          generationId,
          sessionId: sessionId ?? undefined,
          hoverBrightness,
          hoverSaturation,
          pressedBrightness,
          pressedSaturation,
          pressedScale,
        }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as ApiResult;
      const next = {
        normal: { generationId: data.normal.generationId, width: data.normal.width, height: data.normal.height },
        hover: { generationId: data.hover.generationId, width: data.hover.width, height: data.hover.height },
        pressed: { generationId: data.pressed.generationId, width: data.pressed.width, height: data.pressed.height },
      };
      setResults(next);
      onResult?.(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 슬롯 이미지 URL — 생성 전엔 원본, 생성 후엔 각 상태 결과(/api/images/{id} 로 재구성).
  const slotUrl = (state: StateKey) =>
    results ? `/api/images/${results[state].generationId}` : originalUrl;

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[1200px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Gamepad2 size={14} /> 버튼 상태 생성
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[1200px] flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* 미리보기 — 3개 슬롯 (생성 전: 원본 × 3, 생성 후: 각 상태 결과) */}
        <div className="grid grid-cols-3 gap-3">
          {(["normal", "hover", "pressed"] as StateKey[]).map(state => (
            <div key={state} className="flex flex-col gap-1.5">
              <div className="flex aspect-square items-center justify-center checkerboard overflow-hidden rounded-lg border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={slotUrl(state)}
                  alt={LABELS[state]}
                  className="block max-h-full max-w-full object-contain"
                />
              </div>
              <p className="text-center text-[11px] font-medium text-text-muted">{LABELS[state]}</p>
              {results && onAddOne && (
                <button
                  onClick={() =>
                    onAddOne({
                      generationId: results[state].generationId,
                      width: results[state].width,
                      height: results[state].height,
                      state,
                    })
                  }
                  className="flex h-6 items-center justify-center gap-1 rounded border border-border text-[11px] text-text-muted hover:bg-bg-card hover:text-text-primary"
                  title={`${LABELS[state]} 상태를 채팅에 카드로 추가`}
                >
                  <Plus size={11} /> 채팅에 추가
                </button>
              )}
            </div>
          ))}
        </div>

        {/* 파라미터 슬라이더 */}
        <div className="flex flex-col gap-4 border-t border-border pt-4">
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-muted">Hover</p>
            <Slider label="밝기" min={0.5} max={2.0} value={hoverBrightness} onChange={setHoverBrightness} />
            <Slider label="채도" min={0.5} max={2.0} value={hoverSaturation} onChange={setHoverSaturation} />
          </div>
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-muted">Pressed</p>
            <Slider label="밝기" min={0.5} max={2.0} value={pressedBrightness} onChange={setPressedBrightness} />
            <Slider label="채도" min={0.5} max={2.0} value={pressedSaturation} onChange={setPressedSaturation} />
            <Slider label="축소" min={0.8} max={1.0} value={pressedScale} onChange={setPressedScale} suffix="×" />
          </div>
        </div>
      </div>

      {error && (
        <p className="mx-auto w-full max-w-[1200px] px-4 pb-2 text-[11px] text-[color:var(--danger)]">
          {error}
        </p>
      )}

      <PanelFooter
        busy={busy}
        canSubmit
        onSubmit={run}
        onClose={onClose}
        closeLabel={results ? "닫기" : "취소"}
        busyLabel="생성 중…"
        submitLabel={
          <>
            <Gamepad2 size={14} /> {results ? "다시 생성" : "3종 생성 →"}
          </>
        }
      />
    </aside>
  );
}

/** 0.05 step 슬라이더 — 값 라벨을 우측에 표시. */
function Slider({
  label,
  min,
  max,
  value,
  onChange,
  suffix,
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-text-muted">
      <span className="w-8 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="h-1 flex-1 cursor-pointer accent-[color:var(--accent)]"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-text-primary">
        {value.toFixed(2)}
        {suffix ?? ""}
      </span>
    </label>
  );
}
