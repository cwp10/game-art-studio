"use client";

import { Paperclip, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { StylePresetPicker } from "@/components/library/StylePresetPicker";
import { listPresets } from "@/lib/api/client";

/** 다음 메시지의 input image 로 자동 첨부될 generation — 업로드 직후 부모가 set. */
export type ComposerAttachment = { generationId: string; label: string; seq: number };

type Props = {
  disabled: boolean;
  onSend: (
    message: string,
    opts?: { presetId?: string; attachmentGenerationIds?: string[] },
  ) => void;
  onCancel?: () => void;
  generating: boolean;
  /** 부모에서 prefill 요청 — 라이브러리 시트의 [▶ 사용] 등. seq 카운터로 같은 text
   *  여러 번 prefill 시에도 항상 trigger. */
  prefill?: { text: string; seq: number } | null;
  /** 사용자가 [📎] 로 선택한 이미지 — 부모가 base64 변환 + 업로드 처리. */
  onUploadImage?: (file: File) => void;
  /** 업로드/드롭/카드 액션 직후 부모가 자동으로 채움. 사용자가 직접 [X] 로 해제 가능.
   *  seq 카운터로 같은 generationId 도 새 요청처럼 trigger. */
  attachment?: ComposerAttachment | null;
};

export function Composer({
  disabled,
  onSend,
  onCancel,
  generating,
  prefill,
  onUploadImage,
  attachment,
}: Props) {
  const [text, setText] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState<string | null>(null);
  // 내부 attachment state — 부모의 attachment seq 변경 시 sync. 사용자가 [X] 로 해제 가능.
  const [attached, setAttached] = useState<{ id: string; label: string } | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // textarea 자동 높이
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 240) + "px";
  }, [text]);

  // 외부 prefill 반영. seq 변경 시마다 set — 같은 text 도 매번 trigger.
  useEffect(() => {
    if (prefill) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setText(prefill.text);
      setTimeout(() => ref.current?.focus(), 0);
    }
  }, [prefill]);

  // 부모 attachment seq 변경 시 chip 갱신.
  useEffect(() => {
    if (attachment) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttached({ id: attachment.generationId, label: attachment.label });
    }
  }, [attachment]);

  // presetId 변경 시 name 조회 (chip 표시용). list 호출 가벼움.
  useEffect(() => {
    if (!presetId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPresetName(null);
      return;
    }
    listPresets()
      .then(ps => setPresetName(ps.find(p => p.id === presetId)?.name ?? null))
      .catch(() => setPresetName(null));
  }, [presetId]);

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    const opts: { presetId?: string; attachmentGenerationIds?: string[] } = {};
    if (presetId) opts.presetId = presetId;
    if (attached) opts.attachmentGenerationIds = [attached.id];
    onSend(t, Object.keys(opts).length ? opts : undefined);
    setText("");
    // attachment 는 일회용 — submit 후 자동 해제. 다시 reference 하고 싶으면 사용자가 카드의
    // [reference] 또는 새 업로드 필요.
    setAttached(null);
  }

  useHotkeys(
    "mod+enter",
    () => submit(),
    { enableOnFormTags: ["TEXTAREA", "INPUT"], preventDefault: true },
    [text, disabled, presetId, attached],
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
        {(presetId && presetName) || attached ? (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            {presetId && presetName && (
              <span className="flex h-6 items-center gap-1 rounded-full border border-[color:var(--accent)]/40 bg-[color:var(--accent)]/15 px-2 text-[11px] text-text-primary">
                ✨ {presetName}
                <button
                  onClick={() => setPresetId(null)}
                  className="rounded p-0.5 text-text-muted hover:text-text-primary"
                  title="프리셋 해제"
                >
                  <X size={10} />
                </button>
              </span>
            )}
            {attached && (
              <span className="flex h-6 items-center gap-1 overflow-hidden rounded-full border border-[color:var(--accent)]/40 bg-bg-card pl-0.5 pr-2 text-[11px] text-text-primary">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/images/${attached.id}`}
                  alt="reference"
                  className="size-5 rounded-full border border-border object-cover"
                />
                <span className="max-w-[160px] truncate">{attached.label}</span>
                <button
                  onClick={() => setAttached(null)}
                  className="rounded p-0.5 text-text-muted hover:text-text-primary"
                  title="첨부 해제"
                >
                  <X size={10} />
                </button>
              </span>
            )}
            <span className="text-[10px] text-text-muted/60">
              {attached && "이 이미지를 reference 로 변형 · "}{presetId && "prompt suffix 자동 결합"}
            </span>
          </div>
        ) : null}
        <div className="flex items-end gap-2 rounded-xl border border-border bg-bg-card p-3 focus-within:border-[color:var(--accent)]/60">
          <StylePresetPicker value={presetId} onChange={setPresetId} />
          {onUploadImage && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={e => {
                  const f = e.target.files?.[0];
                  if (f) onUploadImage(f);
                  if (e.target) e.target.value = ""; // 같은 파일 재선택 허용
                }}
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={disabled}
                className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted hover:text-text-primary disabled:opacity-40"
                title="이미지 업로드 (PNG/JPEG/WebP)"
              >
                <Paperclip size={12} /> 첨부
              </button>
            </>
          )}
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={generating ? "" : "무엇을 만들고 싶으세요? (Cmd+Enter 전송 · Cmd+K 라이브러리)"}
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
