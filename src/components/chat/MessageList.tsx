"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { ChatItem } from "./chat-state";
import { ToolCallBlock } from "./ToolCallBlock";
import { ImageResultCard } from "./ImageResultCard";

type Props = {
  items: ChatItem[];
  /** 생성 진행 중 — orphaned 복구 UI 를 숨겨 중복 전송을 막는다. */
  generating?: boolean;
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
      | "overlay"
      | "make_sheet"
      | "make_normal_map"
      | "open_nine_slice"
      | "open_button_states"
      | "canvas_edit"
      | "reference"
      | "compare",
    payload: {
      prompt?: string;
      generationId?: string;
      width?: number;
      height?: number;
      kind?: string;
      targetSize?: number;
      subjectMode?: "character" | "object";
    },
  ) => void;
  /** suggestions 카드 클릭 → 부모가 Composer prefill + dispatch suggestion_picked. */
  onPickSuggestion?: (suggestId: string, body: string) => void;
  /** 중단된 세션(orphaned user) 재시도 — 부모가 동일 텍스트로 재전송. */
  onRetryOrphaned?: (item: Extract<ChatItem, { kind: "user" }>) => void;
  /** 실패한 도구 호출 재생성 — 직전 user 메시지를 재전송해 Claude 가 동일 도구를 재호출하도록. */
  onRetryToolCall?: (assistantId: string) => void;
};

/** tc.args 에서 subjectType 을 안전하게 추출 — make_sheet 시 SpriteGenPanel 초기 모드 결정.
 *  make_spritesheet: args.subjectType 직접 사용.
 *  generate_image/edit_image: args.prompt 키워드로 추론 (배경·아이템→object, 캐릭터→character).
 */
function extractSpriteSubjectMode(args: unknown): "character" | "object" | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;

  // 1. make_spritesheet 의 subjectType 직접 사용
  if (a.subjectType === "object") return "object";
  if (a.subjectType === "character") return "character";

  // 2. generate_image / edit_image 의 prompt 키워드 추론
  const p = typeof a.prompt === "string" ? a.prompt.toLowerCase() : "";
  if (!p) return undefined;
  if (/배경|background|tileset|tile\s*set|오브젝트|아이템|item|환경|environment|dungeon|동굴|castle|forest|숲|지형|terrain|맵[^핑]|map/.test(p)) return "object";
  if (/캐릭터|character|캐릭|인물|전사|마법사|궁수|기사|영웅|hero|warrior|knight|mage|wizard|archer/.test(p)) return "character";
  return undefined;
}

export function MessageList({ items, generating, onAction, onPickSuggestion, onRetryOrphaned, onRetryToolCall }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  return (
    <div className="mx-auto w-full max-w-full space-y-4 px-4 py-6">
      {items.map((it, i) => {
        if (it.kind === "user") {
          return (
            <div key={`${it.id}-${i}`} className="flex flex-col items-end">
              {it.attachmentIds && it.attachmentIds.length > 0 && (
                <div className="mb-1 flex flex-wrap justify-end gap-1">
                  {it.attachmentIds.map(id => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      key={id}
                      src={`/api/thumbnails/${id}`}
                      alt="첨부"
                      className="h-14 w-14 rounded border border-border object-cover bg-[repeating-conic-gradient(#222_0%_25%,#333_0%_50%)_50%/8px_8px]"
                    />
                  ))}
                </div>
              )}
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-[color:var(--accent)]/20 px-4 py-2 text-sm leading-relaxed">
                {it.text}
              </div>
              {it.orphaned && !generating && (
                <div className="mt-2 flex items-center gap-2 rounded-lg border border-[color:var(--accent)]/30 bg-[color:var(--accent)]/5 px-3 py-2 text-xs text-text-muted">
                  <span>응답이 없습니다</span>
                  <button
                    onClick={() => onRetryOrphaned?.(it)}
                    className="ml-auto rounded border border-[color:var(--accent)]/50 px-2 py-1 text-[color:var(--accent)] hover:bg-[color:var(--accent)]/10"
                  >
                    재시도 ▸
                  </button>
                </div>
              )}
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
        if (it.kind === "batch") {
          return (
            <div key={`${it.id}-${i}`} className="space-y-2">
              <div className="line-clamp-2 font-mono text-[11px] leading-relaxed text-text-muted" title={it.prompt}>
                ×{it.total} 배치 · {it.prompt}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {/* stopped(취소/완료/재로드) 면 채워진 결과만, 진행 중이면 total 만큼 슬롯을
                    그려 미완료 칸에 스피너. */}
                {Array.from({ length: it.stopped ? it.results.length : it.total }).map((_, j) => {
                  const r = it.results[j];
                  if (!r) {
                    return (
                      <div
                        key={j}
                        className="flex aspect-square items-center justify-center rounded-xl border border-border bg-bg-card"
                      >
                        <Loader2 size={20} className="animate-spin text-text-muted/60" />
                      </div>
                    );
                  }
                  if ("error" in r) {
                    return (
                      <div
                        key={j}
                        className="flex aspect-square items-center justify-center rounded-xl border border-[color:var(--danger)]/40 bg-[color:var(--danger)]/10 px-3 text-center text-[11px] text-[color:var(--danger)]"
                      >
                        {r.error}
                      </div>
                    );
                  }
                  return (
                    <ImageResultCard
                      key={r.generationId}
                      generationId={r.generationId}
                      imageUrl={r.imageUrl}
                      width={r.width}
                      height={r.height}
                      prompt={it.prompt}
                      onAction={(a, opts) =>
                        onAction?.(a, {
                          prompt: it.prompt,
                          generationId: r.generationId,
                          width: r.width,
                          height: r.height,
                          targetSize: opts?.targetSize,
                        })
                      }
                    />
                  );
                })}
              </div>
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
              <ToolCallBlock
                key={tc.toolCallId}
                state={tc}
                onRetry={
                  tc.status === "failed" && onRetryToolCall
                    ? () => onRetryToolCall(it.id)
                    : undefined
                }
              />
            ))}
            {lastTool?.result && (
              <ImageResultCard
                generationId={lastTool.result.generationId}
                imageUrl={lastTool.result.imageUrl}
                width={lastTool.result.width}
                height={lastTool.result.height}
                createdAt={lastTool.result.createdAt}
                kind={lastTool.result.kind}
                prompt={userPromptForCard}
                spriteSubjectMode={extractSpriteSubjectMode(lastTool.args)}
                onAction={(a, opts) =>
                  onAction?.(a, {
                    prompt: userPromptForCard,
                    generationId: lastTool.result!.generationId,
                    width: lastTool.result!.width,
                    height: lastTool.result!.height,
                    kind: lastTool.result!.kind,
                    targetSize: opts?.targetSize,
                    subjectMode: opts?.subjectMode,
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
