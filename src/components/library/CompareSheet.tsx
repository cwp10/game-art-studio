"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { listGenerations } from "@/lib/api/client";
import type { Generation } from "@/types/db";

/**
 * 비교 시트 — 같은 세션의 다른 이미지를 "before", 현재 이미지를 "after" 로 놓고
 * 드래그 가능한 before/after 슬라이더로 겹쳐 비교. 편집 전/후 확인용.
 *
 * - 세션 후보 목록은 listGenerations({ sessionId, limit }) 로 로드 후 mask/layer kind 제외
 *   (generations API 는 sessionId 지정 시 noise 행을 안 거름 → 클라이언트에서 제외).
 * - 기본 before: afterId 의 input_image_ids[0] (편집 원본) → 없으면 후보 첫 번째.
 * - 슬라이더 정렬: clip 컨테이너 width:pos% + overflow-hidden, 내부 before img 는 박스
 *   전체 폭(width: 박스 px) 고정 → after 와 픽셀 정렬 일치.
 */

type Props = {
  open: boolean;
  afterId: string;
  sessionId: string | null;
  onClose: () => void;
};

const EXCLUDED_KINDS = new Set(["mask", "layer"]);

export function CompareSheet({ open, afterId, sessionId, onClose }: Props) {
  const [candidates, setCandidates] = useState<Generation[]>([]);
  const [beforeId, setBeforeId] = useState<string | null>(null);
  const [pos, setPos] = useState(50);
  const [aspect, setAspect] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    if (!open) return;
    /* eslint-disable react-hooks/set-state-in-effect */
    setErr(null);
    setPos(50);
    setAspect(null);
    /* eslint-enable react-hooks/set-state-in-effect */
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(all => {
        const usable = all.filter(g => !EXCLUDED_KINDS.has(g.kind) && g.id !== afterId);
        setCandidates(usable);
        const after = all.find(g => g.id === afterId);
        if (after?.width && after?.height) setAspect(after.width / after.height);
        const original = after?.input_image_ids?.[0];
        const defaultBefore =
          original && usable.some(g => g.id === original)
            ? original
            : (usable[0]?.id ?? null);
        setBeforeId(defaultBefore);
      })
      .catch(e => setErr((e as Error).message));
  }, [open, afterId, sessionId]);

  useHotkeys("esc", () => { if (open) onClose(); }, { enableOnFormTags: true, preventDefault: true }, [open, onClose]);

  const updatePos = useCallback((clientX: number) => {
    const box = boxRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    setPos(Math.min(100, Math.max(0, ratio)));
  }, []);

  function onPointerDown(e: React.PointerEvent) {
    dragging.current = true;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    updatePos(e.clientX);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragging.current) return;
    updatePos(e.clientX);
  }
  function onPointerUp(e: React.PointerEvent) {
    dragging.current = false;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-8 pt-16">
      <div
        role="dialog"
        aria-label="비교"
        className="flex max-h-[85vh] w-full max-w-[880px] flex-col overflow-hidden rounded-2xl border border-border bg-bg-panel shadow-2xl"
      >
        <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
          <span className="font-medium text-text-primary">비교</span>
          <span className="ml-2 text-xs text-text-muted/60">before / after 슬라이더 · Esc 닫기</span>
          <button
            onClick={onClose}
            className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
            title="닫기"
          >
            <X size={14} />
          </button>
        </header>

        {err && <p className="border-b border-border px-3 py-2 text-xs text-[color:var(--danger)]">{err}</p>}

        {candidates.length === 0 ? (
          <p className="py-16 text-center text-sm text-text-muted/60">비교할 다른 이미지가 없어요.</p>
        ) : (
          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
            {/* before 후보 썸네일 스트립 */}
            <div className="flex gap-2 overflow-x-auto pb-1">
              {candidates.map(g => (
                <button
                  key={g.id}
                  onClick={() => setBeforeId(g.id)}
                  className={`shrink-0 overflow-hidden rounded-lg border bg-bg-card transition-colors ${
                    beforeId === g.id
                      ? "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]/60"
                      : "border-border hover:border-[color:var(--accent)]/50"
                  }`}
                  title={g.prompt ?? g.id}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={`/api/images/${g.id}`}
                    alt={g.prompt ?? "before 후보"}
                    className="block h-16 w-16 object-cover"
                    loading="lazy"
                  />
                </button>
              ))}
            </div>

            {/* 슬라이더 영역 — after 이미지 비율(aspect)로 박스 고정. 체커 배경.
                박스가 after 비율과 동일하므로 after/before 모두 박스를 꽉 채워(object-contain)
                동일 좌표계에 그려진다 → clip 정렬 일치. */}
            <div
              className="mx-auto flex w-full max-w-full items-center justify-center"
              style={{ maxHeight: "60vh" }}
            >
              <div
                ref={boxRef}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                className="relative max-h-[60vh] max-w-full cursor-ew-resize select-none overflow-hidden rounded-lg border border-border"
                style={{
                  aspectRatio: aspect ?? 1,
                  width: aspect ? `min(100%, calc(60vh * ${aspect}))` : "min(100%, 60vh)",
                  backgroundColor: "#1a1a1a",
                  backgroundImage:
                    "linear-gradient(45deg,#2a2a2a 25%,transparent 25%),linear-gradient(-45deg,#2a2a2a 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#2a2a2a 75%),linear-gradient(-45deg,transparent 75%,#2a2a2a 75%)",
                  backgroundSize: "16px 16px",
                  backgroundPosition: "0 0,0 8px,8px -8px,-8px 0",
                }}
              >
                {/* after — 박스를 꽉 채움 */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/images/${afterId}`}
                  alt="after"
                  className="pointer-events-none absolute inset-0 block h-full w-full object-contain"
                  draggable={false}
                  onLoad={e => {
                    if (aspect) return;
                    const img = e.currentTarget;
                    if (img.naturalWidth && img.naturalHeight) setAspect(img.naturalWidth / img.naturalHeight);
                  }}
                />

                {/* before — 좌측 pos% 만 보이도록 clip(컨테이너 width:pos%, overflow-hidden).
                    내부 img 는 컨테이너의 (100/pos)% = 박스 전체 폭과 동일하게 → after 와 좌표 정렬 일치.
                    pos→0 일 때 분모 0 방지로 하한 0.5%. */}
                {beforeId && (
                  <div
                    className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden"
                    style={{ width: `${pos}%` }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={`/api/images/${beforeId}`}
                      alt="before"
                      className="absolute inset-y-0 left-0 block h-full max-w-none object-contain"
                      style={{ width: `${(100 / Math.max(pos, 0.5)) * 100}%` }}
                      draggable={false}
                    />
                  </div>
                )}

                {/* 드래그 핸들 */}
                <div
                  className="pointer-events-none absolute inset-y-0 z-10 w-0.5 bg-white/80"
                  style={{ left: `${pos}%` }}
                >
                  <div className="absolute top-1/2 left-1/2 flex h-7 w-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white text-black shadow">
                    <ChevronLeft size={12} className="-mr-1" />
                    <ChevronRight size={12} className="-ml-1" />
                  </div>
                </div>

                {/* 라벨 */}
                <span className="pointer-events-none absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  Before
                </span>
                <span className="pointer-events-none absolute right-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                  After
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
