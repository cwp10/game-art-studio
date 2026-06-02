"use client";

import {
  Columns2,
  Copy,
  Download,
  Edit3,
  Film,
  Grid3x3,
  Layers,
  Link2,
  Loader2,
  Palette,
  RotateCw,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useCopyPrompt } from "@/lib/hooks/useCopyPrompt";

type Action =
  | "duplicate"
  | "download"
  | "copy_prompt"
  | "resize"
  | "remove_bg"
  | "edit"
  | "layer_split"
  | "sprite_split"
  | "reskin"
  | "overlay"
  | "make_sheet"
  | "reference"
  | "compare";

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  /** generation 생성 시각 (epoch ms). 사이즈 옆에 날짜 표시. */
  createdAt?: number;
  /** generation kind — 'spritesheet' 일 때만 [캐릭터 입히기] 단축어 노출. */
  kind?: string;
  prompt?: string;
  /** make_sheet 클릭 시 SpriteGenPanel 에 전달할 초기 모드 (character|object). */
  spriteSubjectMode?: "character" | "object";
  onAction?: (action: Action, opts?: { targetSize?: number; subjectMode?: "character" | "object" }) => void;
};

/** epoch ms → "YYYY.MM.DD HH:mm" (로컬). */
function formatCreatedAt(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ImageResultCard({ generationId, imageUrl, width, height, createdAt, kind, prompt, spriteSubjectMode, onAction }: Props) {
  const { copy: copyPrompt, copied, analyzing, failed } = useCopyPrompt(generationId, prompt);
  const [lightbox, setLightbox] = useState(false);
  const [lightboxLoaded, setLightboxLoaded] = useState(false);
  const [downloading, setDownloading] = useState(false);

  // 라이트박스: Esc 닫기
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // 라이트박스 열기: 큰 이미지 onLoad 전 placeholder 표시를 위해 로딩 상태 리셋
  function openLightbox() {
    setLightboxLoaded(false);
    setLightbox(true);
  }

  function download() {
    // a.click() 다운로드는 동기라 명확한 완료 시점이 없음 → 중복클릭 방지를 위해
    // 짧게 busy 표시(대용량 PNG 에서 연타 방지). 실제 다운로드는 브라우저가 비동기로 진행.
    if (downloading) return;
    setDownloading(true);
    const a = document.createElement("a");
    a.href = imageUrl;
    a.download = `${generationId}.png`;
    a.click();
    onAction?.("download");
    setTimeout(() => setDownloading(false), 1200);
  }

  return (
    <>
    {/* 라이트박스 오버레이 */}
    {lightbox && (
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/85"
        onClick={() => setLightbox(false)}
      >
        <button
          onClick={() => setLightbox(false)}
          className="absolute right-4 top-4 rounded-full bg-black/60 p-2 text-white hover:bg-black/90"
          title="닫기 (Esc)"
        >
          <X size={20} />
        </button>
        {!lightboxLoaded && (
          <Loader2 size={32} className="absolute animate-spin text-white/70" aria-label="이미지 로딩 중" />
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={prompt ?? "generated image"}
          className={`max-h-[90vh] max-w-[90vw] rounded-lg object-contain shadow-2xl transition-opacity ${lightboxLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setLightboxLoaded(true)}
          onClick={e => e.stopPropagation()}
        />
      </div>
    )}
    {/* overflow-hidden 을 figure 에서 빼야 [리사이즈 v] 드롭다운이 figcaption 밖으로
        펼쳐질 수 있음. img 자체에 rounded-t-xl 로 corner 깎임 처리. */}
    <figure className="rounded-xl border border-border bg-bg-card">
      {/* 카드 1개가 viewport 안에 들어가도록 height cap (60vh).
          가로 긴 비율(스프라이트 시트 등) 도 max-w-full 로 자연 fit. 클릭 시 라이트박스. */}
      <div
        className="checkerboard block cursor-zoom-in overflow-hidden rounded-t-xl"
        onClick={openLightbox}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={prompt ?? "generated image"}
          className="mx-auto block h-auto max-h-[60vh] w-auto max-w-full"
          width={width || undefined}
          height={height || undefined}
        />
      </div>
      <figcaption className="space-y-2 px-4 py-3 text-xs">
        {prompt && (
          <div className="flex items-start gap-2">
            <button
              onClick={copyPrompt}
              disabled={analyzing}
              className="mt-0.5 rounded p-1 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:opacity-60"
              title="이미지 분석 → ChatGPT/DALL·E용 영어 프롬프트 복사"
            >
              {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Copy size={12} />}
            </button>
            <p className="flex-1 font-mono text-[11px] leading-relaxed text-text-muted">
              {analyzing
                ? "분석 중… (이미지 → 영어 프롬프트)"
                : failed
                  ? "분석 실패 — 다시 시도"
                  : copied
                    ? "복사됨"
                    : prompt}
            </p>
          </div>
        )}
        {/* dimensions 와 액션 버튼을 두 줄로 분리 — 좁은 영역(편집 패널 열린 메인 420px)에서
            한 줄에 다 안 들어가 글자가 wrap 되던 문제 해결. 버튼들에 `whitespace-nowrap` +
            컨테이너 `flex-wrap` 으로 부족하면 다음 줄로. */}
        <div className="space-y-2 border-t border-border pt-2">
          <div className="text-text-muted/60">
            {width}×{height}
            {createdAt ? <span className="ml-2">· {formatCreatedAt(createdAt)}</span> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            <button
              onClick={() => onAction?.("edit")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="인페인트 — 영역을 brush 로 칠해서 부분 편집"
            >
              <Edit3 size={12} /> 편집
            </button>
            <button
              onClick={() => onAction?.("layer_split")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="레이어 분리 — 부위별로 색을 칠해 색별 PNG 로 추출"
            >
              <Layers size={12} /> 레이어
            </button>
            {kind === "spritesheet" ? (
              <button
                onClick={() => onAction?.("overlay")}
                className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="캐릭터 입히기 — 캐릭터 이미지를 골라 시트의 모든 포즈에 입힘 (오버레이)"
              >
                <UserPlus size={12} /> 캐릭터
              </button>
            ) : (
              <button
                onClick={() => onAction?.("make_sheet", { subjectMode: spriteSubjectMode })}
                className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="이 이미지로 시트 만들기 — 이 이미지를 참조로 방향·프레임 스프라이트시트 생성"
              >
                <Grid3x3 size={12} /> 시트 만들기
              </button>
            )}
            {kind === "spritesheet" && (
              <button
                onClick={() => onAction?.("sprite_split")}
                className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="스프라이트 시트 분할 + GIF 미리보기 + 프레임 zip / GIF 다운로드"
              >
                <Film size={12} /> 스프라이트
              </button>
            )}
            <button
              onClick={() => onAction?.("reskin")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="리스킨 — 색·재질·화풍을 바꾼 새 버전 (외형 교체 / 색만 변경 / 참조 전이)"
            >
              <Palette size={12} /> 리스킨
            </button>
            <button
              onClick={() => onAction?.("compare")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="비교 — 같은 세션의 다른 이미지를 before 로 골라 슬라이더로 전/후 비교"
            >
              <Columns2 size={12} /> 비교
            </button>
            <button
              onClick={() => onAction?.("reference")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="이 이미지를 다음 메시지의 reference 로 첨부 → 자연어로 변형 지시"
            >
              <Link2 size={12} /> 참조
            </button>
            <button
              onClick={() => onAction?.("duplicate")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="같은 프롬프트로 한 번 더 (variation 효과)"
            >
              <RotateCw size={12} /> 복제
            </button>
            <button
              onClick={download}
              disabled={downloading}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
              title="PNG 다운로드"
            >
              {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}{" "}
              {downloading ? "저장 중" : "저장"}
            </button>
          </div>
        </div>
      </figcaption>
    </figure>
    </>
  );
}
