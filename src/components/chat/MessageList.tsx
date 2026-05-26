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
      | "layer_split",
    payload: {
      prompt?: string;
      generationId?: string;
      width?: number;
      height?: number;
      targetSize?: number;
    },
  ) => void;
};

export function MessageList({ items, onAction }: Props) {
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
        // assistant
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
                    targetSize: opts?.targetSize,
                  })
                }
              />
            )}
            {it.text && <p className="text-sm text-text-primary">{it.text}</p>}
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
