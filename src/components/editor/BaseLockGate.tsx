"use client";

import { Check, Loader2, Lock, LockOpen, X } from "lucide-react";
import { useEffect, useState } from "react";

import { jsonFetch } from "@/lib/api/client";

/**
 * base 잠금 게이트 — sprite-gen 에서 **BLOCKING** 인 유일한 앞단.
 *
 * *"약한 idle 앵커는 모든 상태를 오염시킨다 — 비율·스타일·정체성 드리프트가 모든 행에
 * 누적된다."* 그래서 행 생성 전에 이 이미지를 base 로 **잠글지** y/n 을 답한다.
 *
 * 화면이 드러내야 하는 것 둘:
 *
 *   1. 자동 검사는 6기준 중 **3개뿐**이다. 나머지 셋(비율·스타일, 정체성, 실루엣
 *      가독성)은 기계가 못 본다 — 사람이 눈으로 확인하고 체크해야 잠금이 열린다.
 *   2. `unmeasured` 는 "통과"가 아니라 **"근거 없이 통과로 쳤다"** 이다. 조용히 초록으로
 *      보이면 안 된다.
 *
 * 자동 검사가 전부 통과해도 잠금 버튼은 사람 확인 없이는 열리지 않는다 — 정본이
 * *"'일단 이 정도면 됨' 은 통과가 아니다"* 라고 못박은 자리다.
 */

type BaseCheck = {
  id: "background" | "fullBody" | "pixelArt";
  ok: boolean;
  unmeasured?: boolean;
  detail: string;
};

type Inspection = {
  checks: BaseCheck[];
  autoPass: boolean;
  background: { mode: string; hex?: string };
  softAlpha: number;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  width: number;
  height: number;
};

const AUTO_LABEL: Record<BaseCheck["id"], string> = {
  background: "평면 크로마 배경 (또는 쉽게 키잉 가능)",
  fullBody: "전신 — 잘린 곳 없음",
  pixelArt: "픽셀아트 격자 (픽셀 런일 때만)",
};

/** 기계가 판정할 수 없어 사람이 확인하는 기준. 정본 6기준 중 2·4·5. */
const HUMAN_CRITERIA = [
  {
    id: "style",
    label: "비율·스타일이 이미 목표대로다",
    hint: "SD/치비 등신, 픽셀 느낌, 아웃라인 굵기 — base 가 목표를 정의한다. \"나중에 행에서 고치자\"는 통하지 않는다",
  },
  {
    id: "identity",
    label: "정체성이 캐릭터 시트·참조와 일치한다",
    hint: "얼굴, 머리, 무늬, 팔레트, 소품",
  },
  {
    id: "silhouette",
    label: "단일 명확 idle 포즈이고 작은 크기에서 실루엣이 읽힌다",
    hint: "의도한 카메라를 향한 포즈 하나",
  },
] as const;

export function BaseLockGate({
  generationId,
  imageUrl,
  sessionId,
  pixelArt,
  onClose,
  onLocked,
}: {
  generationId: string;
  imageUrl: string;
  sessionId?: string | null;
  pixelArt?: boolean;
  onClose: () => void;
  onLocked?: (id: string) => void;
}) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [locked, setLocked] = useState<{ id: string; isThis?: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const qs = new URLSearchParams({ generationId });
      if (sessionId) qs.set("sessionId", sessionId);
      if (pixelArt) qs.set("pixelArt", "true");
      try {
        const res = await fetch(`/api/sprite/base-gate?${qs}`);
        const d = (await res.json()) as {
          inspection?: Inspection;
          locked?: { id: string; isThis?: boolean } | null;
          error?: string;
        };
        if (cancelled) return;
        if (!res.ok) throw new Error(d.error ?? `검사 실패 (${res.status})`);
        setInspection(d.inspection ?? null);
        setLocked(d.locked ?? null);
        setError(null);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generationId, sessionId, pixelArt]);

  const allConfirmed = HUMAN_CRITERIA.every(c => confirmed[c.id]);

  async function lock() {
    setBusy(true);
    setError(null);
    try {
      const res = await jsonFetch("/api/sprite/base-gate", "POST", {
        generationId,
        sessionId: sessionId ?? null,
      });
      const d = (await res.json()) as { locked?: { id: string }; error?: string };
      if (!res.ok) throw new Error(d.error ?? `잠금 실패 (${res.status})`);
      setLocked(d.locked ? { id: d.locked.id, isThis: d.locked.id === generationId } : null);
      onLocked?.(generationId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isLockedHere = locked?.id === generationId;

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-bg-panel">
      <header className="flex h-[50px] flex-none items-center justify-between border-b border-border px-3.5">
        <span className="flex items-center gap-2 text-sm font-medium text-text-primary">
          <Lock size={15} /> base 잠금 게이트
        </span>
        <button onClick={onClose} className="text-text-muted hover:text-text-primary" aria-label="닫기">
          <X size={16} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <p className="mb-3 rounded-lg border border-border bg-bg-card p-2.5 text-[11px] leading-relaxed text-text-muted">
          약한 base 는 <b className="text-text-primary">모든 행을 오염시킵니다</b> — 비율·스타일·정체성
          드리프트가 상태마다 누적됩니다. 잠근 뒤에는 이 이미지가 정체성의 기준이 되고, 방향 앵커가
          만들어지면 행 생성에서 빠집니다.
        </p>

        <div className="checkerboard mb-3 flex items-center justify-center overflow-hidden rounded-lg border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="base 후보" className="block max-h-[34vh] max-w-full object-contain" />
        </div>

        {error && (
          <p className="mb-3 rounded-lg border border-[color:var(--danger)]/40 p-2 text-xs text-[color:var(--danger)]">
            {error}
          </p>
        )}

        <h3 className="mb-1.5 text-xs font-medium text-text-primary">자동 검사</h3>
        {!inspection ? (
          <p className="flex items-center gap-1.5 text-xs text-text-muted">
            <Loader2 size={13} className="animate-spin" /> 검사 중…
          </p>
        ) : (
          <ul className="mb-3 space-y-1">
            {inspection.checks.map(c => (
              <li key={c.id} className="flex gap-2 rounded-lg border border-border p-2 text-[11px]">
                <span
                  className={
                    c.unmeasured
                      ? "text-[color:var(--warning,#d59f0f)]"
                      : c.ok
                        ? "text-[color:var(--accent)]"
                        : "text-[color:var(--danger)]"
                  }
                >
                  {c.unmeasured ? "?" : c.ok ? "✓" : "✕"}
                </span>
                <span className="min-w-0">
                  <span className="text-text-primary">{AUTO_LABEL[c.id]}</span>
                  <span className="block text-text-muted">{c.detail}</span>
                  {c.unmeasured && (
                    <span className="block text-[color:var(--warning,#d59f0f)]">
                      근거 없이 통과로 쳤습니다 — 사람이 확인해야 합니다
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        <h3 className="mb-1.5 text-xs font-medium text-text-primary">
          사람이 확인 <span className="font-normal text-text-muted">— 기계가 볼 수 없는 기준</span>
        </h3>
        <ul className="space-y-1">
          {HUMAN_CRITERIA.map(c => (
            <li key={c.id}>
              <label className="flex cursor-pointer gap-2 rounded-lg border border-border p-2 text-[11px] hover:bg-bg-card">
                <input
                  type="checkbox"
                  checked={!!confirmed[c.id]}
                  onChange={e => setConfirmed(p => ({ ...p, [c.id]: e.target.checked }))}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  <span className="text-text-primary">{c.label}</span>
                  <span className="block text-text-muted">{c.hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="flex-none border-t border-border p-3">
        {isLockedHere ? (
          <p className="flex items-center justify-center gap-1.5 text-xs text-[color:var(--accent)]">
            <Check size={14} /> 이 이미지가 base 로 잠겼습니다
          </p>
        ) : (
          <>
            <button
              onClick={() => void lock()}
              disabled={!allConfirmed || busy}
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-[color:var(--accent)] text-sm font-medium text-[color:var(--accent)] disabled:border-border disabled:text-text-muted disabled:opacity-50"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Lock size={14} />}
              base 로 잠그기
            </button>
            <p className="mt-1.5 text-center text-[11px] text-text-muted">
              {allConfirmed
                ? inspection && !inspection.autoPass
                  ? "자동 검사에 실패한 항목이 있습니다 — 그래도 잠그려면 위 버튼을 누르세요"
                  : "확인 완료 — 잠글 수 있습니다"
                : "사람 확인 3개를 모두 체크해야 잠글 수 있습니다"}
            </p>
          </>
        )}
        {locked && !isLockedHere && (
          <p className="mt-1.5 flex items-center justify-center gap-1 text-[11px] text-text-muted">
            <LockOpen size={12} /> 현재 잠긴 base 는 다른 이미지입니다 ({locked.id.slice(0, 8)}…)
          </p>
        )}
      </div>
    </div>
  );
}
