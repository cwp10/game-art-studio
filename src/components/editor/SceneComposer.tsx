"use client";

import { Clapperboard, ChevronDown, ChevronUp, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { listGenerations } from "@/lib/api/client";
import type { Generation } from "@/types/db";
import { ZoomPanControls, useZoomPan } from "./useZoomPan";

/**
 * SceneComposer — 여러 generation 이미지를 레이어로 쌓아 한 장의 씬(composite)으로 병합한다.
 *
 * 레이어 순서·불투명도를 조절하고, 해상도 프리셋(또는 레이어 기준 자유)을 골라
 * POST /api/composite 로 서버 합성(sharp)을 요청한다. 결과는 onComposited 로 부모에 전달돼
 * chat 결과 카드로 삽입된다. seedGenerationId 가 주어지면 첫 레이어로 미리 채운다.
 */

const RESOLUTION_PRESETS = [
  { label: "자유 (레이어 기준)", w: 0, h: 0 },
  { label: "HD 1280×720", w: 1280, h: 720 },
  { label: "Full HD 1920×1080", w: 1920, h: 1080 },
  { label: "2K 2560×1440", w: 2560, h: 1440 },
  { label: "모바일 390×844", w: 390, h: 844 },
] as const;

type SceneLayer = {
  generationId: string;
  imageUrl: string; // /api/images/{id}
  thumbUrl: string; // /api/thumbnails/{id}
  prompt: string | null;
  opacity: number; // 0~100
  x: number; // 출력 캔버스 중앙 기준 오프셋 px (기본 0)
  y: number; // 출력 캔버스 중앙 기준 오프셋 px (기본 0)
  scale: number; // 1.0 = contain-fit (기본 1.0)
};

type Props = {
  seedGenerationId?: string;
  sessionId: string | null;
  onClose: () => void;
  onComposited?: (result: { generationId: string; width: number; height: number }) => void;
};

export function SceneComposer({ seedGenerationId, sessionId, onClose, onComposited }: Props) {
  const [presetIdx, setPresetIdx] = useState(0);
  // seed 이미지가 있으면 첫 레이어로 미리채움(lazy init — 마운트 시 1회). prompt 는 null 폴백.
  const [layers, setLayers] = useState<SceneLayer[]>(() =>
    seedGenerationId
      ? [
          {
            generationId: seedGenerationId,
            imageUrl: `/api/images/${seedGenerationId}`,
            thumbUrl: `/api/thumbnails/${seedGenerationId}`,
            prompt: null,
            opacity: 100,
            x: 0,
            y: 0,
            scale: 1.0,
          },
        ]
      : [],
  );
  const [assets, setAssets] = useState<Generation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 선택된 레이어 — 있으면 프리뷰 드래그가 그 레이어의 x/y 를 이동.
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const zp = useZoomPan();

  // 에셋 피커 로드 — composite 결과는 재합성 대상에서 제외.
  useEffect(() => {
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens => setAssets(gens.filter(g => g.kind !== "composite")))
      .catch(() => {});
  }, [sessionId]);

  const addAsset = useCallback((g: Generation) => {
    setLayers(prev => {
      if (prev.some(l => l.generationId === g.id)) return prev;
      return [
        ...prev,
        {
          generationId: g.id,
          imageUrl: `/api/images/${g.id}`,
          thumbUrl: `/api/thumbnails/${g.id}`,
          prompt: g.prompt,
          opacity: 100,
          x: 0,
          y: 0,
          scale: 1.0,
        },
      ];
    });
  }, []);

  const moveLayer = useCallback((i: number, dir: -1 | 1) => {
    const j = i + dir;
    setLayers(prev => {
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
    // selectedIdx 는 위치 인덱스 — 행 순서를 바꾸면 선택이 같은 레이어를 따라가도록 함께 스왑.
    setSelectedIdx(sel => (sel === i ? j : sel === j ? i : sel));
  }, []);

  const setOpacity = useCallback((i: number, opacity: number) => {
    setLayers(prev => prev.map((l, idx) => (idx === i ? { ...l, opacity } : l)));
  }, []);

  const setScale = useCallback((i: number, scale: number) => {
    setLayers(prev => prev.map((l, idx) => (idx === i ? { ...l, scale } : l)));
  }, []);

  // x/y/scale 리셋(↺) — 한 레이어의 배치를 contain-fit 중앙으로 되돌림.
  const resetTransform = useCallback((i: number) => {
    setLayers(prev => prev.map((l, idx) => (idx === i ? { ...l, x: 0, y: 0, scale: 1.0 } : l)));
  }, []);

  const removeLayer = useCallback((i: number) => {
    setLayers(prev => prev.filter((_, idx) => idx !== i));
    setSelectedIdx(sel => (sel === i ? null : sel));
  }, []);

  // 프리뷰 드래그 — 선택된 레이어의 x/y 를 이동. window 이벤트로 프리뷰 밖에서도 추적
  // (SpriteCanvas 의 셀 드래그 패턴 동일). delta 는 zoom 으로 역산해 화면 1:1 이동감 유지.
  // useZoomPan 의 onPanPointer* 는 SceneComposer 에서 어떤 요소에도 연결돼 있지 않아(현재 inert)
  // 패닝과 충돌하지 않는다 — 별도 stopPropagation 불필요.
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const onPreviewMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (selectedIdx === null) return;
      const layer = layers[selectedIdx];
      if (!layer) return;
      e.preventDefault();
      dragRef.current = { sx: e.clientX, sy: e.clientY, ox: layer.x, oy: layer.y };
      const idx = selectedIdx;
      const zoom = zp.zoom;
      const onMove = (ev: MouseEvent) => {
        const d = dragRef.current;
        if (!d) return;
        const nx = d.ox + (ev.clientX - d.sx) / zoom;
        const ny = d.oy + (ev.clientY - d.sy) / zoom;
        setLayers(prev => prev.map((l, j) => (j === idx ? { ...l, x: nx, y: ny } : l)));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [selectedIdx, layers, zp.zoom],
  );

  const handleComposite = async () => {
    if (layers.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const preset = RESOLUTION_PRESETS[presetIdx];
      const body = {
        layers: layers.map(l => ({
          generationId: l.generationId,
          opacity: l.opacity,
          x: l.x,
          y: l.y,
          scale: l.scale,
        })),
        sessionId: sessionId ?? undefined,
        outputWidth: preset.w || undefined,
        outputHeight: preset.h || undefined,
      };
      const res = await fetch("/api/composite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = (await res.json()) as { generationId: string; width: number; height: number };
      onComposited?.(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // 프리뷰 씬 박스 — 선택 프리셋의 종횡비를 고정 영역(300×280)에 contain-fit.
  // 모든 레이어가 absolute 가 되면 i===0 이 주던 크기가 사라지므로 wrapper 에 명시적 px 필요.
  // "자유(레이어 기준)" 프리셋(w=0)은 4:3 기본 박스.
  const BOX_W = 300;
  const BOX_H = 280;
  const preset = RESOLUTION_PRESETS[presetIdx];
  const aspect = preset.w && preset.h ? preset.w / preset.h : 4 / 3;
  const sceneW = aspect >= BOX_W / BOX_H ? BOX_W : Math.round(BOX_H * aspect);
  const sceneH = aspect >= BOX_W / BOX_H ? Math.round(BOX_W / aspect) : BOX_H;

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="mx-auto flex h-12 w-full max-w-[880px] items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Clapperboard size={14} /> 씬 합성
        </span>
        <select
          value={presetIdx}
          onChange={e => setPresetIdx(Number(e.target.value))}
          className="ml-auto h-7 rounded-lg border border-border bg-bg-card px-2 text-xs text-text-primary focus:border-[color:var(--accent)]/60 focus:outline-none"
        >
          {RESOLUTION_PRESETS.map((p, i) => (
            <option key={p.label} value={i}>
              {p.label}
            </option>
          ))}
        </select>
        <button
          onClick={onClose}
          className="rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="mx-auto flex w-full max-w-[880px] flex-1 flex-col gap-4 overflow-y-auto p-4">
        {/* 1. 프리뷰 — 레이어를 아래부터 위로 absolute 로 쌓는다. 레이어 선택 시 드래그로 이동. */}
        <div
          className="relative overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/14px_14px]"
          style={{ height: 320 }}
        >
          <div
            style={{
              position: "absolute",
              top: "50%",
              left: "50%",
              transform: `translate(-50%, -50%) translate(${zp.pan.x}px, ${zp.pan.y}px) scale(${zp.zoom})`,
              transformOrigin: "center",
            }}
          >
            {/* 모든 레이어를 absolute 로 쌓으므로 씬 박스에 명시적 px 크기 부여(컨테이너 붕괴 방지). */}
            <div
              className={`relative ${selectedIdx !== null ? "cursor-move" : ""}`}
              style={{ width: sceneW, height: sceneH }}
              onMouseDown={onPreviewMouseDown}
            >
              {layers.map(layer => (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  key={layer.generationId}
                  src={layer.imageUrl}
                  alt={layer.prompt ?? layer.generationId}
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: "50%",
                    transform: `translate(-50%, -50%) translate(${layer.x}px, ${layer.y}px) scale(${layer.scale})`,
                    opacity: layer.opacity / 100,
                    maxWidth: "100%",
                    maxHeight: "100%",
                    objectFit: "contain",
                  }}
                  draggable={false}
                />
              ))}
              {layers.length === 0 && (
                <div className="flex h-full w-full items-center justify-center text-xs text-text-muted/60">
                  아래에서 에셋을 추가하세요
                </div>
              )}
            </div>
          </div>
          <ZoomPanControls zp={zp} />
        </div>

        {/* 2. 에셋 피커 */}
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-text-muted">에셋 추가</p>
          {assets.length === 0 ? (
            <p className="text-[11px] text-text-muted/50">이 세션에 추가할 수 있는 에셋이 없습니다.</p>
          ) : (
            <div className="grid grid-cols-6 gap-2">
              {assets.map(g => {
                const added = layers.some(l => l.generationId === g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => addAsset(g)}
                    disabled={added}
                    title={g.prompt ?? g.id}
                    className={`overflow-hidden rounded border bg-[repeating-conic-gradient(#1a1a1a_0%_25%,#3a3a3a_0%_50%)_50%/10px_10px] ${
                      added
                        ? "cursor-default border-[color:var(--accent)] opacity-40"
                        : "border-border hover:border-[color:var(--accent)]/60"
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
          )}
        </div>

        {/* 3. 레이어 패널 */}
        {layers.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-medium text-text-muted">레이어 ({layers.length})</p>
            {layers.map((layer, i) => (
              <div
                key={layer.generationId}
                className={`flex flex-col gap-1.5 rounded-lg border bg-bg-card p-2 ${
                  selectedIdx === i ? "border-[color:var(--accent)]" : "border-border"
                }`}
              >
                <div className="flex items-center gap-2">
                  {/* 썸네일+이름 클릭으로 레이어 선택 토글 — 선택 시 프리뷰 드래그로 이동 가능. */}
                  <button
                    onClick={() => setSelectedIdx(sel => (sel === i ? null : i))}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    title="클릭해서 선택 — 프리뷰에서 드래그로 이동"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={layer.thumbUrl}
                      alt={layer.prompt ?? layer.generationId}
                      className="h-6 w-6 shrink-0 rounded border border-border object-cover bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/6px_6px]"
                    />
                    <span className="flex-1 truncate text-xs text-text-primary">
                      {layer.prompt ?? layer.generationId.slice(0, 8)}
                    </span>
                  </button>
                  <button
                    onClick={() => moveLayer(i, -1)}
                    disabled={i === 0}
                    className="rounded p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                    title="위로"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    onClick={() => moveLayer(i, 1)}
                    disabled={i === layers.length - 1}
                    className="rounded p-1 text-text-muted hover:text-text-primary disabled:opacity-30"
                    title="아래로"
                  >
                    <ChevronDown size={13} />
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={layer.opacity}
                    onChange={e => setOpacity(i, Number(e.target.value))}
                    className="w-20 accent-[color:var(--accent)]"
                  />
                  <span className="w-8 text-right text-xs tabular-nums text-text-muted">{layer.opacity}%</span>
                  <button
                    onClick={() => removeLayer(i)}
                    className="rounded p-1 text-text-muted hover:text-text-primary"
                    title="제거"
                  >
                    <X size={12} />
                  </button>
                </div>
                {/* scale 슬라이더 + 위치/배율 리셋(↺). 1.0× = contain-fit. */}
                <div className="flex items-center gap-2 pl-8">
                  <span className="w-10 shrink-0 text-[11px] text-text-muted">배율</span>
                  <input
                    type="range"
                    min={0.1}
                    max={3}
                    step={0.1}
                    value={layer.scale}
                    onChange={e => setScale(i, Number(e.target.value))}
                    className="flex-1 accent-[color:var(--accent)]"
                  />
                  <span className="w-9 text-right text-[11px] tabular-nums text-text-muted">
                    {layer.scale.toFixed(1)}×
                  </span>
                  <button
                    onClick={() => resetTransform(i)}
                    className="rounded p-1 text-text-muted hover:text-text-primary"
                    title="위치·배율 리셋"
                  >
                    <RotateCcw size={12} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {error && <p className="text-[11px] text-[color:var(--danger)]">{error}</p>}
      </div>

      <footer className="mx-auto flex w-full max-w-[880px] gap-2 border-t border-border p-3">
        <button
          onClick={onClose}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        <button
          onClick={handleComposite}
          disabled={layers.length === 0 || busy}
          className="flex h-9 flex-[2] items-center justify-center gap-1.5 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? (
            <>
              <Loader2 size={14} className="animate-spin" /> 합성 중…
            </>
          ) : (
            `씬 병합 (${layers.length}개 레이어)`
          )}
        </button>
      </footer>
    </aside>
  );
}
