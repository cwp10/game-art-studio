"use client";

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

/**
 * PanelFooter — editor 우측 패널(ReskinPanel / SpriteGenPanel)의 공통 하단 footer.
 *
 * 좌: 취소(busy 시 "생성 취소" → onCancel) / 우: 실행 버튼(busy 시 스피너 + busyLabel).
 * 라벨·아이콘·title 등 패널마다 다른 부분만 props 로 받고, 레이아웃·busy 분기는 공통화한다.
 */
type Props = {
  busy?: boolean;
  /** 실행 가능 여부. busy 와 무관하게 입력 유효성만 표현 — busy 잠금은 내부에서 합산. */
  canSubmit: boolean;
  onSubmit: () => void;
  onClose: () => void;
  onCancel?: () => void;
  /** 비-busy 상태의 실행 버튼 라벨. 아이콘과 함께 쓰려면 ReactNode 로 전달. */
  submitLabel?: ReactNode;
  /** busy 상태의 실행 버튼 라벨. 미지정 시 "실행 중…". */
  busyLabel?: string;
  /** 실행 버튼 title (비활성 사유 안내 등). */
  submitTitle?: string;
  /** 비-busy 좌측 버튼 라벨(✕ 자동 prefix). 기본 "취소". 결과 확인 후 닫기 등 패널별 의미 구분용. */
  closeLabel?: string;
};

export function PanelFooter({
  busy = false,
  canSubmit,
  onSubmit,
  onClose,
  onCancel,
  submitLabel = "실행 ▸",
  busyLabel = "실행 중…",
  submitTitle,
  closeLabel = "취소",
}: Props) {
  return (
    <footer className="mx-auto flex w-full max-w-[1200px] gap-2 border-t border-border p-3">
      <button
        onClick={busy ? (onCancel ?? onClose) : onClose}
        className="h-9 flex-1 rounded-lg border border-border text-sm text-text-muted hover:text-text-primary"
      >
        {busy ? "■ 생성 취소" : `✕ ${closeLabel}`}
      </button>
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
