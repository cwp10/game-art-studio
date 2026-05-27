"use client";

import { Palette, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listGenerations } from "@/lib/api/client";
import type { Generation } from "@/types/db";

/**
 * ReskinPanel — 결과 카드의 [🎨 리스킨] 단축어가 여는 패널.
 *
 * 3개 모드(외형 교체 / 색만 변경 / 참조 전이)를 상단 세그먼트 토글로 전환.
 * 실행은 기존 단축어와 동일 — 모드별 자연어 메시지 + attachmentGenerationIds 를
 * onSubmit 으로 부모(ChatLayout)에 넘기면 부모가 handleSend 로 Claude → reskin_image 라우팅.
 *
 * 자연어 문구는 system-orchestrator.md 라우팅과 정합:
 *  - (a) "…로 리스킨해줘" → prompt 모드
 *  - (b) "색 팔레트만 …로 바꿔줘. 형태는 그대로 유지." → paletteOnly 모드
 *  - (c) "첫 번째 이미지 + 두 번째 이미지의 화풍" + 두 첨부 → styleReferenceId 모드
 */

type Mode = "a" | "b" | "c";

export type ReskinSubmit =
  | { mode: "a"; prompt: string }
  | { mode: "b"; prompt: string }
  | { mode: "c"; styleReferenceId: string; extra: string };

type Props = {
  /** 리스킨 대상 generationId. */
  generationId: string;
  /** 원본 이미지 URL — 미리보기용. */
  imageUrl: string;
  width: number;
  height: number;
  /** 시트면 셀 정렬·투명 후처리 안내 배너 표시. 미지정 시 치수로 추정. */
  kind?: string;
  /** 현재 세션 — 모드 c 의 참조 썸네일 그리드 조회용. */
  sessionId: string | null;
  onSubmit: (payload: ReskinSubmit) => void;
  onClose: () => void;
};

const MODE_LABELS: Record<Mode, string> = {
  a: "외형 교체",
  b: "색만 변경",
  c: "참조 전이",
};

// 썸네일 그리드에서 제외할 비-이미지 kind.
const NON_IMAGE_KINDS = new Set(["mask"]);

export function ReskinPanel({
  generationId,
  imageUrl,
  width,
  height,
  kind,
  sessionId,
  onSubmit,
  onClose,
}: Props) {
  const [mode, setMode] = useState<Mode>("a");
  const [prompt, setPrompt] = useState("");
  const [extra, setExtra] = useState("");
  const [styleRefId, setStyleRefId] = useState<string | null>(null);
  const [refs, setRefs] = useState<Generation[] | null>(null);

  // 시트 여부: kind 우선, 없으면 치수에서 grid 감지(SpriteCanvas 와 동일 GCD 역산).
  const isSheet = kind === "spritesheet" || (!kind && detectSpriteGrid(width, height) !== null);
  const grid = detectSpriteGrid(width, height);

  // 모드 c 진입 시 세션 이미지 목록 로드 — 원본 자신·마스크 제외.
  useEffect(() => {
    if (mode !== "c" || refs !== null) return;
    listGenerations({ sessionId: sessionId ?? undefined, limit: 60 })
      .then(gens =>
        setRefs(gens.filter(g => g.id !== generationId && !NON_IMAGE_KINDS.has(g.kind))),
      )
      .catch(() => setRefs([]));
  }, [mode, refs, sessionId, generationId]);

  const canSubmit = useMemo(() => {
    if (mode === "a" || mode === "b") return prompt.trim().length > 0;
    return styleRefId !== null;
  }, [mode, prompt, styleRefId]);

  function submit() {
    if (!canSubmit) return;
    if (mode === "a") onSubmit({ mode: "a", prompt: prompt.trim() });
    else if (mode === "b") onSubmit({ mode: "b", prompt: prompt.trim() });
    else if (styleRefId) onSubmit({ mode: "c", styleReferenceId: styleRefId, extra: extra.trim() });
  }

  const styleRefUrl = styleRefId ? `/api/images/${styleRefId}` : null;

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      <header className="flex h-12 items-center gap-2 border-b border-border px-3 text-sm">
        <span className="flex items-center gap-1 font-medium text-text-primary">
          <Palette size={14} /> 리스킨
        </span>
        <span className="text-xs text-text-muted/60">
          {width}×{height} · parent {generationId.slice(0, 6)}…
        </span>
        <button
          onClick={onClose}
          className="ml-auto rounded p-1 text-text-muted hover:bg-bg-card hover:text-text-primary"
          title="닫기"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
        {/* 모드 세그먼트 토글 */}
        <div className="flex shrink-0 gap-1 rounded-lg border border-border bg-bg-card p-1 text-xs">
          {(["a", "b", "c"] as const).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`flex h-8 flex-1 items-center justify-center rounded border px-2 ${
                mode === m
                  ? "border-[color:var(--accent)] bg-[color:var(--accent)]/20 text-text-primary"
                  : "border-transparent text-text-muted hover:text-text-primary"
              }`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {/* 원본 미리보기 + kind 배지 */}
        <div className="flex shrink-0 items-start gap-3 rounded-lg border border-border bg-bg-card p-2">
          <div className="h-24 w-24 shrink-0 overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/12px_12px]">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={imageUrl} alt="원본" className="h-full w-full object-contain" />
          </div>
          <div className="flex flex-col gap-1 pt-1 text-xs">
            <span className="text-text-muted/80">원본</span>
            <span className="text-text-primary">{width}×{height}</span>
            {isSheet && (
              <span className="inline-flex w-fit items-center rounded bg-[color:var(--accent)]/15 px-1.5 py-0.5 text-[10px] text-text-primary">
                스프라이트시트{grid ? ` · ${grid.rows}×${grid.cols}` : ""}
              </span>
            )}
          </div>
        </div>

        {/* 모드별 입력 */}
        {mode === "a" && (
          <div className="shrink-0 space-y-1">
            <label className="text-xs text-text-muted">새 스킨 설명</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="예: 파란 갑옷의 기사, 은빛 검"
              rows={3}
              className="block min-h-[78px] w-full shrink-0 resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
            />
            <p className="text-[11px] text-text-muted/70">
              포즈·실루엣·구도는 유지하고 색·재질·테마만 교체됩니다.
            </p>
          </div>
        )}

        {mode === "b" && (
          <div className="shrink-0 space-y-1">
            <label className="text-xs text-text-muted">원하는 색 팔레트</label>
            <textarea
              value={prompt}
              onChange={e => setPrompt(e.target.value)}
              placeholder="예: 빨강→파랑, 금색 장식은 은색으로"
              rows={3}
              className="block min-h-[78px] w-full shrink-0 resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
            />
            <p className="text-[11px] text-text-muted/70">형태·선은 그대로 두고 색 팔레트만 바꿉니다.</p>
            <p className="text-[11px] text-[color:var(--danger)]/90">
              ⚠ img2img 특성상 형태가 미세하게 틀어질 수 있어요.
            </p>
          </div>
        )}

        {mode === "c" && (
          <div className="shrink-0 space-y-2">
            <label className="text-xs text-text-muted">스타일 참조 이미지</label>
            {refs === null ? (
              <p className="text-[11px] text-text-muted/60">세션 이미지를 불러오는 중…</p>
            ) : refs.length === 0 ? (
              <p className="text-[11px] text-text-muted/60">
                이 세션에 참조로 쓸 다른 이미지가 없어요. 먼저 이미지를 생성/업로드하세요.
              </p>
            ) : (
              <div className="grid grid-cols-4 gap-1">
                {refs.map(g => {
                  const sel = styleRefId === g.id;
                  return (
                    <button
                      key={g.id}
                      onClick={() => setStyleRefId(sel ? null : g.id)}
                      className={`relative aspect-square overflow-hidden rounded border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px] ${
                        sel
                          ? "border-[color:var(--accent)] ring-2 ring-[color:var(--accent)]"
                          : "border-border hover:border-[color:var(--accent)]/50"
                      }`}
                      title={g.prompt ?? g.id}
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={`/api/images/${g.id}`}
                        alt={g.prompt ?? "참조"}
                        className="h-full w-full object-contain"
                      />
                      {sel && (
                        <span className="absolute right-0.5 top-0.5 rounded-full bg-[color:var(--accent)] px-1 text-[9px] font-bold text-white">
                          ✓
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* 선택 시 원본 + 참조 나란히 미리보기 */}
            {styleRefUrl && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-card p-2">
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={imageUrl} alt="원본" className="h-full w-full object-contain" />
                </div>
                <span className="text-text-muted">→</span>
                <div className="h-16 w-16 shrink-0 overflow-hidden rounded border border-border bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/10px_10px]">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={styleRefUrl} alt="참조" className="h-full w-full object-contain" />
                </div>
                <span className="text-[11px] text-text-muted/70">이 참조의 화풍·팔레트를 입힙니다.</span>
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs text-text-muted">(선택) 추가 지시</label>
              <textarea
                value={extra}
                onChange={e => setExtra(e.target.value)}
                placeholder="예: 더 어둡고 차분하게"
                rows={2}
                className="block w-full resize-none rounded-lg border border-border bg-bg-card px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted/40 focus:border-[color:var(--accent)]/60"
              />
            </div>
          </div>
        )}

        {/* 시트 후처리 안내 — 시트일 때만 */}
        {isSheet && (
          <div className="shrink-0 rounded-lg border border-border bg-bg-card p-2 text-[11px] text-text-muted/70">
            ⓘ 스프라이트시트는 셀 정렬·투명 후처리가 자동 적용됩니다.
          </div>
        )}
      </div>

      <footer className="flex gap-2 border-t border-border p-3">
        <button
          onClick={onClose}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ✕ 취소
        </button>
        <button
          onClick={submit}
          disabled={!canSubmit}
          className="h-9 flex-[2] rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
          title={canSubmit ? "" : mode === "c" ? "참조 이미지 선택 필요" : "설명 입력 필요"}
        >
          리스킨 실행 ▸
        </button>
      </footer>
    </aside>
  );
}

// SpriteCanvas 와 동일한 GCD 역산으로 시트 여부·grid 추정 (kind 미지정 시 폴백).
function detectSpriteGrid(width: number, height: number): { rows: number; cols: number } | null {
  if (!width || !height) return null;
  const g = gcd(width, height);
  const divs: number[] = [];
  for (let d = 1; d * d <= g; d++) {
    if (g % d === 0) {
      divs.push(d);
      if (d !== g / d) divs.push(g / d);
    }
  }
  divs.sort((a, b) => b - a);
  for (const d of divs) {
    if (d < 64 || d > 512) continue;
    const c = width / d;
    const r = height / d;
    if (c >= 1 && c <= 16 && r >= 1 && r <= 16 && Number.isInteger(c) && Number.isInteger(r)) {
      // 1×1 은 시트로 보지 않음 (단일 이미지).
      if (r === 1 && c === 1) return null;
      return { rows: r, cols: c };
    }
  }
  return null;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
