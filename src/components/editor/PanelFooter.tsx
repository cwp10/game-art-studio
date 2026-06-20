"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * PanelFooter — editor 패널의 공통 하단 실행 footer.
 *
 * 닫기는 헤더의 "대화로 돌아가기" 버튼이 담당(캔버스 에디터와 일관) — footer 에는 닫기/취소 버튼이 없다.
 * 평소: 실행 버튼만 전체폭. 생성 중(busy)이고 abort 가능(onCancel)할 때만 좌측에 "■ 생성 취소" 노출.
 * 라벨·아이콘·title 등 패널마다 다른 부분만 props 로 받고, 레이아웃·busy 분기는 공통화한다.
 */
type Props = {
  busy?: boolean;
  /** 실행 가능 여부. busy 와 무관하게 입력 유효성만 표현 — busy 잠금은 내부에서 합산. */
  canSubmit: boolean;
  onSubmit: () => void;
  /** 생성 중 abort(중단). 미지정 시 생성 중에도 중단 버튼을 띄우지 않는다. */
  onCancel?: () => void;
  /** 비-busy 상태의 실행 버튼 라벨. 아이콘과 함께 쓰려면 ReactNode 로 전달. */
  submitLabel?: ReactNode;
  /** busy 상태의 실행 버튼 라벨. 미지정 시 "실행 중…". */
  busyLabel?: string;
  /** 실행 버튼 title (비활성 사유 안내 등). */
  submitTitle?: string;
};

export function PanelFooter({
  busy = false,
  canSubmit,
  onSubmit,
  onCancel,
  submitLabel = "실행 ▸",
  busyLabel = "실행 중…",
  submitTitle,
}: Props) {
  return (
    <footer className="mx-auto flex w-full max-w-[1200px] gap-2 border-t border-border p-3">
      {busy && onCancel && (
        <button
          onClick={onCancel}
          className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
        >
          ■ 생성 취소
        </button>
      )}
      <button
        onClick={onSubmit}
        disabled={!canSubmit || busy}
        className="flex h-9 flex-[2] items-center justify-center gap-1 rounded-lg bg-[color:var(--accent)] text-sm font-medium text-white disabled:opacity-40"
        title={submitTitle}
      >
        {busy ? (
          <><Loader2 size={14} className="animate-spin" /> {busyLabel}</>
        ) : (
          submitLabel
        )}
      </button>
    </footer>
  );
}
