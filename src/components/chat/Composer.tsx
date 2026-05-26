"use client";

import { Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";

type Props = {
  disabled: boolean;
  onSend: (message: string) => void;
  onCancel?: () => void;
  generating: boolean;
};

export function Composer({ disabled, onSend, onCancel, generating }: Props) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);

  // textarea 자동 높이
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    onSend(t);
    setText("");
  }

  useHotkeys(
    "mod+enter",
    () => submit(),
    { enableOnFormTags: ["TEXTAREA", "INPUT"], preventDefault: true },
    [text, disabled],
  );

  return (
    <div className="border-t border-border bg-bg-panel/40 px-4 py-3">
      <div className="mx-auto max-w-[880px]">
        {generating && (
          <div className="mb-2 flex items-center justify-between rounded-lg border border-border bg-bg-card px-3 py-2 text-xs">
            <span className="shimmer text-text-muted">생성 중…</span>
            <button
              onClick={onCancel}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-text-muted hover:text-text-primary"
            >
              <X size={12} /> 취소
            </button>
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-bg-card p-3 focus-within:border-[color:var(--accent)]/60">
          <button
            type="button"
            disabled
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted opacity-50"
            title="스타일 프리셋은 v1.1"
          >
            <Sparkles size={12} /> 스타일
          </button>
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={generating ? "" : "무엇을 만들고 싶으세요? (Cmd+Enter 로 전송)"}
            disabled={disabled}
            rows={1}
            className="flex-1 resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            onClick={submit}
            disabled={disabled || !text.trim()}
            className="flex h-9 items-center gap-1 rounded-md bg-[color:var(--accent)] px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
