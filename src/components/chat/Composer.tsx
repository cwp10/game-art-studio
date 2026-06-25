"use client";

import { LayoutGrid, Send, Sparkles, User, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { StylePresetPicker } from "@/components/library/StylePresetPicker";
import { listPresets } from "@/lib/api/client";

const FRAME_COUNTS = [4, 9, 16, 25] as const;
const BATCH_COUNTS = [1, 2, 4] as const;

const DIRECTIONS: Array<{ key: string; label: string }> = [
  { key: "auto", label: "자유" },
  { key: "정면", label: "정면" },
  { key: "측면", label: "측면" },
  { key: "3/4 측면", label: "3/4" },
  { key: "후면", label: "후면" },
];

/** 다음 메시지의 input image 로 자동 첨부될 generation — 업로드 직후 부모가 set. */
export type ComposerAttachment = { generationId: string; label: string; seq: number };

type Props = {
  disabled: boolean;
  onSend: (
    message: string,
    opts?: { presetId?: string; attachmentGenerationIds?: string[]; count?: number },
  ) => void;
  onCancel?: () => void;
  generating: boolean;
  /** 부모에서 prefill 요청 — 라이브러리 시트의 [▶ 사용] 등. seq 카운터로 같은 text
   *  여러 번 prefill 시에도 항상 trigger. */
  prefill?: { text: string; seq: number } | null;
  /** 업로드/드롭/카드 액션 직후 부모가 자동으로 채움. 사용자가 직접 [X] 로 해제 가능.
   *  seq 카운터로 같은 generationId 도 새 요청처럼 trigger.
   *  업로드 entry 는 EmptyState 카드 + drag-drop 으로만 제공 — Composer 의 [📎] 제거. */
  attachment?: ComposerAttachment | null;
  /** [✨ 제안] 클릭 시 부모에게 현재 text 위임. 부모가 chat 에 카드 그리드 표시.
   *  첨부 이미지가 있으면 generationId 도 함께 위임 → 비전 분석 반영. */
  onAskSuggestions?: (text: string, attachedGenerationIds?: string[]) => void;
  /** 입력창에 이미지 파일을 드롭하면 업로드 → 다음 메시지의 reference 로 자동 첨부. */
  onUploadImage?: (file: File) => void;
};

export function Composer({
  disabled,
  onSend,
  onCancel,
  generating,
  prefill,
  attachment,
  onAskSuggestions,
  onUploadImage,
}: Props) {
  const [text, setText] = useState("");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [direction, setDirection] = useState<string>("auto");
  const [frames, setFrames] = useState<number | null>(null);
  // 배치 생성 장수 (×1/×2/×4). attached/frames 사용 시엔 단일 생성만 — count 무시(강제 1).
  const [count, setCount] = useState<number>(1);
  // 내부 attachment state — 부모의 attachment seq 변경 시 sync. 사용자가 [X] 로 해제 가능.
  const [attached, setAttached] = useState<{ id: string; label: string }[]>([]);
  const ref = useRef<HTMLTextAreaElement>(null);
  // 입력창 드래그-드롭 업로드 — child(텍스트영역/버튼) 위 enter/leave 깜빡임 방지에 counter 사용.
  // 이벤트는 stopPropagation 으로 가둬, 중앙 컬럼 전역 드롭과 이중 업로드되지 않게 한다.
  const [dragOver, setDragOver] = useState(false);
  const dragCounter = useRef(0);

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
      // 같은 ID면 label 갱신, 없으면 추가(중복 방지).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setAttached(prev => {
        const without = prev.filter(a => a.id !== attachment.generationId);
        return [...without, { id: attachment.generationId, label: attachment.label }];
      });
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

  function askSuggestions() {
    const t = text.trim();
    if (!t || !onAskSuggestions) return;
    const ids = attached.length ? attached.map(a => a.id) : undefined;
    onAskSuggestions(t, ids);
    setText("");
  }

  function submit() {
    const t = text.trim();
    if (!t || disabled) return;
    // 방향이 'auto' 아니면 메시지 끝에 결합 (preset suffix 결합 흐름과 같은 패턴).
    // 이미 사용자가 직접 "정면" 같은 단어 입력했어도 중복 무해.
    const withDir = direction === "auto" ? t : `${t}, ${direction}`;
    const opts: { presetId?: string; attachmentGenerationIds?: string[]; count?: number } = {};
    if (presetId) opts.presetId = presetId;
    if (attached.length) opts.attachmentGenerationIds = attached.map(a => a.id);
    // attached 있고 frames 선택 시 sprite sheet suffix 결합.
    const withFrames = (() => {
      if (!attached.length || frames === null) return withDir;
      const side = Math.round(Math.sqrt(frames));
      const grid = `${side}×${side}`;
      return `${withDir}, ${frames}프레임 sprite sheet, ${grid} grid`;
    })();
    // 배치: 첨부/스프라이트가 아니고 count>1 일 때만. 그 외엔 단일 생성 흐름 유지.
    if (!attached.length && frames === null && count > 1) opts.count = count;
    onSend(withFrames, Object.keys(opts).length ? opts : undefined);
    setText("");
    // attachment 는 일회용 — submit 후 자동 해제. 다시 reference 하고 싶으면 사용자가 카드의
    // [reference] 또는 새 업로드 필요.
    setAttached([]);
    setFrames(null);
  }

  useHotkeys(
    "mod+enter",
    () => submit(),
    { enableOnFormTags: ["TEXTAREA", "INPUT"], preventDefault: true },
    [text, disabled, presetId, attached, frames, count],
  );

  return (
    <div className="border-t border-border bg-bg-panel/40 px-4 py-3">
      <div className="mx-auto max-w-[880px]">
        {(presetId && presetName) || attached.length > 0 ? (
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
            {attached.map(a => (
              <span key={a.id} className="flex h-6 items-center gap-1 overflow-hidden rounded-full border border-[color:var(--accent)]/40 bg-bg-card pl-0.5 pr-2 text-[11px] text-text-primary">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/api/images/${a.id}`}
                  alt="reference"
                  className="size-5 rounded-full border border-border object-cover"
                />
                <span className="max-w-[160px] truncate">{a.label}</span>
                <button
                  onClick={() => setAttached(prev => prev.filter(x => x.id !== a.id))}
                  className="rounded p-0.5 text-text-muted hover:text-text-primary"
                  title="첨부 해제"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
            <span className="text-[10px] text-text-muted/60">
              {attached.length > 0 && "이 이미지를 reference 로 변형 · "}{presetId && "prompt suffix 자동 결합"}
            </span>
          </div>
        ) : null}
        {/* 상단: textarea (전체 폭). 하단: 좌측 modifier (스타일/방향) + 우측 액션 (제안/전송).
            가로 한 줄 배치 → 좁은 화면에서 textarea 가 비좁아지던 것 해소. */}
        <div
          className={`relative flex flex-col gap-2 rounded-xl border bg-bg-card p-3 transition-colors ${
            dragOver
              ? "border-[color:var(--accent)] bg-[color:var(--accent)]/5"
              : "border-border focus-within:border-[color:var(--accent)]/60"
          }`}
          onDragEnter={e => {
            if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            dragCounter.current += 1;
            setDragOver(true);
          }}
          onDragOver={e => {
            if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = "copy";
          }}
          onDragLeave={e => {
            if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
            e.stopPropagation();
            dragCounter.current = Math.max(0, dragCounter.current - 1);
            if (dragCounter.current === 0) setDragOver(false);
          }}
          onDrop={e => {
            if (!onUploadImage || !e.dataTransfer.types.includes("Files")) return;
            e.preventDefault();
            e.stopPropagation();
            dragCounter.current = 0;
            setDragOver(false);
            const f = [...e.dataTransfer.files].find(x => /^image\/(png|jpeg|webp)$/.test(x.type));
            if (f) onUploadImage(f);
          }}
        >
          {dragOver && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-[color:var(--accent)] bg-bg-card/85 text-xs font-medium text-text-primary">
              🖼 이미지를 드롭해 첨부 (PNG · JPEG · WebP)
            </div>
          )}
          <textarea
            ref={ref}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={generating ? "" : "무엇을 만들고 싶으세요? (Cmd+Enter 전송 · Cmd+K 라이브러리)"}
            disabled={disabled}
            rows={1}
            className="w-full resize-none bg-transparent text-sm text-text-primary placeholder:text-text-muted focus:outline-none disabled:opacity-50"
          />
          <div className="flex items-center gap-2">
            <StylePresetPicker value={presetId} onChange={setPresetId} />
            <label className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted hover:text-text-primary" title="캐릭터 방향">
              <User size={12} />
              <select
                value={direction}
                onChange={e => setDirection(e.target.value)}
                className="bg-transparent text-xs text-text-muted focus:outline-none"
              >
                {DIRECTIONS.map(d => (
                  <option key={d.key} value={d.key}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            {!attached.length && (
              <div
                className="flex h-7 items-center overflow-hidden rounded-md border border-border text-xs"
                title="배치 생성 — 같은 프롬프트로 N장을 한 번에"
              >
                {BATCH_COUNTS.map(n => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setCount(n)}
                    className={`flex h-full items-center px-2 leading-none transition-colors ${
                      count === n
                        ? "bg-[color:var(--accent)]/20 text-text-primary"
                        : "text-text-muted hover:text-text-primary"
                    }`}
                  >
                    ×{n}
                  </button>
                ))}
              </div>
            )}
            {attached.length > 0 && (
              <label className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-text-muted hover:text-text-primary" title="sprite sheet 프레임 수">
                <LayoutGrid size={12} />
                <select
                  value={frames ?? ""}
                  onChange={e => setFrames(e.target.value === "" ? null : Number(e.target.value))}
                  className="bg-transparent text-xs text-text-muted focus:outline-none"
                >
                  <option value="">없음</option>
                  {FRAME_COUNTS.map(n => (
                    <option key={n} value={n}>{n}프레임</option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              onClick={askSuggestions}
              disabled={disabled || !text.trim() || !onAskSuggestions}
              className="ml-auto flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs leading-none text-text-muted hover:border-[color:var(--accent)]/40 hover:text-text-primary disabled:opacity-40"
              title="입력 맥락을 LLM 으로 분석해 3-4개 컨셉 제안 (~30~60초). 결과는 chat 에 카드로."
            >
              <Sparkles size={12} /> 제안
            </button>
            {generating ? (
              <button
                type="button"
                onClick={onCancel}
                className="flex h-7 items-center gap-1 rounded-md border border-border px-3 text-xs text-text-muted hover:text-text-primary"
              >
                <X size={12} /> 취소
              </button>
            ) : (
              <button
                type="button"
                onClick={submit}
                disabled={disabled || !text.trim()}
                className="flex h-7 items-center gap-1 rounded-md bg-[color:var(--accent)] px-3 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-30"
              >
                <Send size={12} />
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}
