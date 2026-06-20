"use client";

import {
  Columns2,
  Copy,
  Download,
  Edit3,
  Film,
  Gamepad2,
  Grid3x3,
  Layers,
  Link2,
  Loader2,
  Map,
  MoreHorizontal,
  Palette,
  RotateCw,
  Scissors,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useCopyPrompt } from "@/lib/hooks/useCopyPrompt";

type Action =
  | "duplicate"
  | "download"
  | "copy_prompt"
  | "resize"
  | "remove_bg"
  | "edit"
  | "image_tools"
  | "layer_split"
  | "sprite_split"
  | "reskin"
  | "overlay"
  | "make_sheet"
  | "make_normal_map"
  | "add_to_scene"
  | "open_nine_slice"
  | "open_button_states"
  | "canvas_edit"
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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // 라이트박스: Esc 닫기
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(false); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // ⋯ 드롭다운: 바깥 클릭 시 닫기
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

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
            <p
              className="line-clamp-2 flex-1 font-mono text-[11px] leading-relaxed text-text-muted"
              title={prompt}
            >
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
              onClick={() => onAction?.("canvas_edit")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="캔버스 편집 — 레이어 합성·자유 변형·필터·크롭·배경제거·업스케일·여백제거"
            >
              <Wand2 size={12} /> 캔버스
            </button>
            <button
              onClick={() => onAction?.("layer_split")}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
              title="레이어 분리 — 부위별로 색을 칠해 색별 PNG 로 추출"
            >
              <Layers size={12} /> 레이어
            </button>
            {kind !== "spritesheet" && (
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
              onClick={download}
              disabled={downloading}
              className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent disabled:hover:text-text-muted"
              title="PNG 다운로드"
            >
              {downloading ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}{" "}
              {downloading ? "저장 중" : "저장"}
            </button>
            {/* ⋯ 더보기 — 자주 안 쓰는 액션을 위쪽 팝업 메뉴로 숨김 (편집 패널 열린 좁은 카드에서 wrap 방지). */}
            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen(o => !o)}
                className="flex h-7 items-center gap-1 whitespace-nowrap rounded border border-border px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                title="더보기"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
              >
                <MoreHorizontal size={12} />
              </button>
              {menuOpen && (
                <div className="absolute bottom-full right-0 z-50 mb-1 flex min-w-[8rem] flex-col rounded-lg border border-border bg-bg-card p-1 shadow-lg">
                  {kind !== "spritesheet" && (
                    <button
                      onClick={() => { onAction?.("reskin"); setMenuOpen(false); }}
                      className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                      title="리스킨 — 색·재질·화풍을 바꾼 새 버전 (외형 교체 / 색만 변경)"
                    >
                      <Palette size={12} /> 리스킨
                    </button>
                  )}
                  {!["normal_map", "mask", "layer"].includes(kind ?? "") && (
                    <button
                      onClick={() => { onAction?.("make_normal_map"); setMenuOpen(false); }}
                      className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                      title="노멀맵 — 이 이미지의 라이팅용 노멀맵을 생성"
                    >
                      <Map size={12} /> 노멀맵
                    </button>
                  )}
                  <button
                    onClick={() => { onAction?.("compare"); setMenuOpen(false); }}
                    className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                    title="비교 — 같은 세션의 다른 이미지를 before 로 골라 슬라이더로 전/후 비교"
                  >
                    <Columns2 size={12} /> 비교
                  </button>
                  {/* 9-slice 는 단일 일반 이미지에만 — 시트/합성/이미 9-slice 처리된 결과는 제외. */}
                  {!["spritesheet", "composite", "nine_slice", "nine_slice_scaled"].includes(kind ?? "") && (
                    <button
                      onClick={() => { onAction?.("open_nine_slice"); setMenuOpen(false); }}
                      className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                      title="9-slice — 모서리를 유지한 채 늘릴 수 있게 슬라이스 영역 지정 후 리사이즈 출력"
                    >
                      <Scissors size={12} /> 9-slice
                    </button>
                  )}
                  {/* 버튼 상태 — 단일 일반 이미지(버튼/아이콘)에만. 시트/합성/9-slice/이미 버튼상태 결과는 제외. */}
                  {!["spritesheet", "composite", "nine_slice", "nine_slice_scaled", "button_state"].includes(kind ?? "") && (
                    <button
                      onClick={() => { onAction?.("open_button_states"); setMenuOpen(false); }}
                      className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                      title="버튼 상태 — normal/hover/pressed 3종 UI 버튼 상태 이미지를 생성"
                    >
                      <Gamepad2 size={12} /> 버튼 상태
                    </button>
                  )}
                  <button
                    onClick={() => { onAction?.("reference"); setMenuOpen(false); }}
                    className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                    title="이 이미지를 다음 메시지의 reference 로 첨부 → 자연어로 변형 지시"
                  >
                    <Link2 size={12} /> 참조
                  </button>
                  <button
                    onClick={() => { onAction?.("duplicate"); setMenuOpen(false); }}
                    className="flex h-7 items-center gap-2 whitespace-nowrap rounded px-2 text-text-muted hover:bg-bg-panel hover:text-text-primary"
                    title="같은 프롬프트로 한 번 더 (variation 효과)"
                  >
                    <RotateCw size={12} /> 복제
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </figcaption>
    </figure>
    </>
  );
}
