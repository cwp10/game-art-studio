"use client";

import { useEffect, useRef } from "react";
import type { ChatItem } from "./chat-state";
import { ToolCallBlock } from "./ToolCallBlock";
import { ImageResultCard } from "./ImageResultCard";

type Props = {
  items: ChatItem[];
  onAction?: (
    action:
      | "duplicate"
      | "download"
      | "copy_prompt"
      | "resize"
      | "remove_bg"
      | "edit"
      | "layer_split"
      | "sprite_split"
      | "reskin"
      | "reference",
    payload: {
      prompt?: string;
      generationId?: string;
      width?: number;
      height?: number;
      kind?: string;
      targetSize?: number;
    },
  ) => void;
  /** suggestions 카드 클릭 → 부모가 Composer prefill + dispatch suggestion_picked. */
  onPickSuggestion?: (suggestId: string, body: string) => void;
};

export function MessageList({ items, onAction, onPickSuggestion }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-[880px] space-y-4 px-4 py-6">
      {items.map((it, i) => {
        if (it.kind === "user") {
          return (
            <div key={`${it.id}-${i}`} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[color:var(--accent)]/20 px-4 py-2 text-sm leading-relaxed">
                {it.text}
              </div>
            </div>
          );
        }
        if (it.kind === "suggestions") {
          return (
            <div key={`${it.id}-${i}`} className="space-y-2">
              <div className="text-xs text-text-muted">
                ✨ 제안된 prompt — 카드를 클릭하면 입력란에 적용돼요. 스타일·방향·첨부는 별도로 골라 전송.
              </div>
              {it.pending && (
                <div className="rounded-xl border border-border bg-bg-card px-4 py-3 text-xs text-text-muted">
                  <span className="shimmer">Claude 가 후보를 생각 중… (~30~60초)</span>
                </div>
              )}
              {it.error && (
                <div className="rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-4 py-3 text-xs text-[color:var(--danger)]">
                  {it.error}
                </div>
              )}
              {!it.pending && !it.error && (
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {it.items.map((s, j) => {
                    const picked = it.pickedBody === s.body;
                    return (
                      <button
                        key={j}
                        onClick={() => onPickSuggestion?.(it.id, s.body)}
                        className={`rounded-xl border p-3 text-left transition-colors ${
                          picked
                            ? "border-[color:var(--accent)] bg-[color:var(--accent)]/15"
                            : "border-border bg-bg-card hover:border-[color:var(--accent)]/40"
                        }`}
                      >
                        <div className="text-sm font-medium text-text-primary">
                          {picked && "✓ "}
                          {s.label}
                        </div>
                        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-text-muted">
                          {s.body}
                        </p>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        }
        // assistant
        if (it.kind !== "assistant") return null;
        const lastTool = it.toolCalls[it.toolCalls.length - 1];
        const userPromptForCard = findUserPromptForAssistant(items, i);

        return (
          <div key={`${it.id}-${i}`} className="space-y-3">
            {it.toolCalls.map(tc => (
              <ToolCallBlock key={tc.toolCallId} state={tc} />
            ))}
            {lastTool?.result && (
              <ImageResultCard
                generationId={lastTool.result.generationId}
                imageUrl={lastTool.result.imageUrl}
                width={lastTool.result.width}
                height={lastTool.result.height}
                prompt={userPromptForCard}
                onAction={(a, opts) =>
                  onAction?.(a, {
                    prompt: userPromptForCard,
                    generationId: lastTool.result!.generationId,
                    width: lastTool.result!.width,
                    height: lastTool.result!.height,
                    kind: lastTool.result!.kind,
                    targetSize: opts?.targetSize,
                  })
                }
              />
            )}
            {it.text && (
              <p
                className={
                  it.text.startsWith("⚠️")
                    ? "rounded-lg border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 py-2 text-sm text-[color:var(--danger)]"
                    : "text-sm text-text-primary"
                }
              >
                {it.text}
              </p>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

function findUserPromptForAssistant(items: ChatItem[], assistantIdx: number): string | undefined {
  for (let i = assistantIdx - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === "user") return it.text;
  }
  return undefined;
}
