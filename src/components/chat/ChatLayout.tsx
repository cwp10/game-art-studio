"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { chatReducer, initialState } from "./chat-state";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionList } from "./SessionList";
import { LayerCanvas } from "@/components/editor/LayerCanvas";
import { MaskCanvas } from "@/components/editor/MaskCanvas";
import { SpriteCanvas } from "@/components/editor/SpriteCanvas";
import { PromptLibrarySheet } from "@/components/library/PromptLibrarySheet";
import {
  createSession,
  deleteSession,
  listMessages,
  listPresets,
  listSessions,
  streamChat,
  uploadImage,
  uploadLayers,
  uploadMask,
} from "@/lib/api/client";
import type { StylePreset } from "@/types/db";

/**
 * ChatLayout — 3-column shell (좌: 세션 / 중: 대화 / 우: 추후 패널).
 *
 * 단일 useReducer 로 SSE 이벤트와 사용자 입력을 모두 받아 ChatItem 배열을 시간 순으로 누적.
 */
const COLOR_KO: Record<string, string> = {
  red: "빨강", green: "초록", blue: "파랑", yellow: "노랑",
  cyan: "청록", magenta: "자홍", orange: "주황", purple: "보라",
};
function colorKo(k: string): string { return COLOR_KO[k] ?? k; }

type EditTarget = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
};
type Editing =
  | ({ mode: "inpaint" } & EditTarget)
  | ({ mode: "layer" } & EditTarget)
  | ({ mode: "sprite" } & EditTarget)
  | null;

export function ChatLayout() {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const [editing, setEditing] = useState<Editing>(null);
  const [libOpen, setLibOpen] = useState(false);
  // Composer prefill — seq 카운터로 같은 text 도 매번 새 trigger.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; seq: number } | null>(null);
  // preset cache — handleSend 가 suffix 결합에 사용.
  const presetCache = useRef<Map<string, StylePreset>>(new Map());
  // session 활성화 직후의 listMessages reload 를 건너뜀 — 클라이언트가 dispatch 로
  // 이미 items 를 채운 경우 (예: 업로드 흐름) race 로 items 가 빈 응답에 reset 되는 것 방지.
  const skipNextLoadRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // drag-drop 상태 — child 위를 지나면서 enter/leave 가 번갈아 발화해 깜빡이는 것 방지하려고 counter 사용.
  const dragCounter = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // 초기 세션 목록 로드
  useEffect(() => {
    listSessions().then(sessions => dispatch({ type: "set_sessions", sessions }));
  }, []);

  // 활성 세션 변경 시 메시지 로드
  useEffect(() => {
    if (!state.activeSessionId) {
      dispatch({ type: "reset_items" });
      return;
    }
    // upload 등이 dispatch 로 items 를 채운 직후의 reload 는 skip — 빈 응답이 우리 items 를 덮어쓰는 race 방지.
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }
    listMessages(state.activeSessionId).then(messages =>
      dispatch({ type: "load_messages", messages }),
    );
  }, [state.activeSessionId]);

  // 새 세션
  const handleNew = useCallback(() => {
    dispatch({ type: "set_active", sessionId: null });
  }, []);

  // 세션 선택
  const handleSelect = useCallback((id: string) => {
    dispatch({ type: "set_active", sessionId: id });
  }, []);

  // 세션 삭제
  const handleDelete = useCallback(
    async (id: string) => {
      await deleteSession(id);
      const next = await listSessions();
      dispatch({ type: "set_sessions", sessions: next });
      if (state.activeSessionId === id) dispatch({ type: "set_active", sessionId: null });
    },
    [state.activeSessionId],
  );

  // 메시지 전송. attachmentGenerationIds / maskGenerationId 가 있으면 라우트가
  // user 메시지 본문에 [reference: <id>] / [mask: <id>] marker 로 prefix → Claude 가
  // inputGenerationId / maskGenerationId 로 사용.
  // presetId 가 있으면 client 측에서 prompt_suffix 를 메시지 끝에 결합 (서버는 결합된
  // 형태만 받음 — Claude orchestrator 는 preset 개념 모름).
  const handleSend = useCallback(
    async (
      text: string,
      opts?: {
        attachmentGenerationIds?: string[];
        maskGenerationId?: string;
        presetId?: string;
      },
    ) => {
      if (state.generating) return;
      let finalText = text;
      if (opts?.presetId) {
        let p = presetCache.current.get(opts.presetId);
        if (!p) {
          const all = await listPresets();
          for (const x of all) presetCache.current.set(x.id, x);
          p = presetCache.current.get(opts.presetId);
        }
        if (p?.prompt_suffix) finalText = `${text}, ${p.prompt_suffix}`;
      }
      const tempId = "tmp-" + Math.random().toString(36).slice(2, 8);
      dispatch({ type: "user_send", tempId, text: finalText });

      const abort = new AbortController();
      abortRef.current = abort;
      try {
        await streamChat(
          {
            sessionId: state.activeSessionId ?? undefined,
            message: finalText,
            attachmentGenerationIds: opts?.attachmentGenerationIds,
            maskGenerationId: opts?.maskGenerationId,
          },
          event => dispatch({ type: "sse", event }),
          abort.signal,
        );
        // 응답 끝나면 세션 목록 refresh (새 세션이 만들어졌거나 updated_at 갱신)
        const next = await listSessions();
        dispatch({ type: "set_sessions", sessions: next });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          console.error(e);
          dispatch({
            type: "sse",
            event: { type: "error", message: (e as Error).message },
          });
        }
      } finally {
        dispatch({ type: "set_generating", generating: false });
        abortRef.current = null;
      }
    },
    [state.generating, state.activeSessionId],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // 결과 카드의 액션. plan §S3: "버튼 클릭 시 채팅창에 새 유저 메시지로 자연어가
  // 자동 입력되어 보내짐 — 즉 버튼은 단축어, 실행 경로는 동일하게 자연어 → Claude".
  // resize / remove_bg 는 generationId 를 attach 해서 Claude 가 inputGenerationId 로
  // 사용하도록 한다. edit (인페인트) 는 우측 패널 열어 MaskCanvas 띄움.
  const handleAction = useCallback(
    (
      action:
        | "duplicate"
        | "download"
        | "copy_prompt"
        | "resize"
        | "remove_bg"
        | "edit"
        | "layer_split"
        | "sprite_split",
      payload: {
        prompt?: string;
        generationId?: string;
        width?: number;
        height?: number;
        targetSize?: number;
      },
    ) => {
      if (action === "duplicate" && payload.prompt) {
        handleSend(payload.prompt);
      } else if (action === "resize" && payload.generationId && payload.targetSize) {
        handleSend(`이 이미지를 ${payload.targetSize}×${payload.targetSize} 로 리사이즈해줘.`, {
          attachmentGenerationIds: [payload.generationId],
        });
      } else if (action === "remove_bg" && payload.generationId) {
        handleSend("이 이미지의 배경을 투명하게 제거해줘.", {
          attachmentGenerationIds: [payload.generationId],
        });
      } else if (
        (action === "edit" || action === "layer_split" || action === "sprite_split") &&
        payload.generationId &&
        payload.width &&
        payload.height
      ) {
        const mode =
          action === "edit" ? "inpaint" : action === "layer_split" ? "layer" : "sprite";
        setEditing({
          mode,
          generationId: payload.generationId,
          imageUrl: `/api/images/${payload.generationId}`,
          width: payload.width,
          height: payload.height,
        });
      }
    },
    [handleSend],
  );

  // MaskCanvas 가 submit 한 마스크 PNG → /api/upload → /api/chat 으로 inpaint 호출.
  const handleInpaint = useCallback(
    async ({ maskDataUrl, prompt }: { maskDataUrl: string; prompt: string }) => {
      if (!editing || editing.mode !== "inpaint") return;
      try {
        const maskId = await uploadMask(editing.generationId, maskDataUrl);
        setEditing(null);
        await handleSend(prompt, {
          attachmentGenerationIds: [editing.generationId],
          maskGenerationId: maskId,
        });
      } catch (e) {
        console.error("[inpaint]", e);
        dispatch({
          type: "sse",
          event: { type: "error", message: (e as Error).message },
        });
      }
    },
    [editing, handleSend],
  );

  // LayerCanvas 가 submit 한 결과 처리.
  //  - mode='crop': N개 색별 PNG → /api/layers → N개 generation 행. result list 를 그대로
  //    돌려주면 LayerCanvas 가 result view 로 표시.
  //  - mode='inpaint': N개 색별 binary mask PNG → 색별 1회씩 /api/upload + /api/chat 직렬
  //    호출 (codex inpaint_image 가 가려진 영역을 자연스럽게 복원). LayerCanvas 즉시 닫히고
  //    결과 카드는 chat 에 순차 누적.
  const handleLayerSplit = useCallback(
    async ({
      mode,
      layers,
    }: {
      mode: "crop" | "inpaint";
      layers: Array<{ colorLabel: string; dataUrl: string }>;
    }) => {
      if (!editing || editing.mode !== "layer") return [];
      if (mode === "crop") {
        return uploadLayers(editing.generationId, layers);
      }
      const parentId = editing.generationId;
      setEditing(null); // 패널 닫고 chat 으로 시선 이동
      for (const layer of layers) {
        try {
          const maskId = await uploadMask(parentId, layer.dataUrl);
          await handleSend(
            `${colorKo(layer.colorLabel)} 영역만 남기고 빨간색으로 표시된 다른 부위 영역을 원본의 자연스러운 연속(같은 색·질감)으로 복원해줘.`,
            { attachmentGenerationIds: [parentId], maskGenerationId: maskId },
          );
        } catch (e) {
          console.error("[layer-inpaint]", layer.colorLabel, e);
          dispatch({
            type: "sse",
            event: { type: "error", message: `${layer.colorLabel}: ${(e as Error).message}` },
          });
        }
      }
      return [];
    },
    [editing, handleSend],
  );

  // 사용자가 [📎 첨부] 또는 EmptyState 의 업로드 카드로 파일 선택 → base64 →
  // /api/upload (kind='image'). active session 없으면 신규 생성해서 결과를 그 세션에
  // 누적. dispatch external_upload 로 chat 에 결과 카드 표시.
  const handleUploadImage = useCallback(
    async (file: File) => {
      try {
        const dataUrl = await fileToDataUrl(file);
        // active session 없으면 생성
        let sid = state.activeSessionId;
        if (!sid) {
          const newSession = await createSession(file.name);
          sid = newSession.id;
          const next = await listSessions();
          dispatch({ type: "set_sessions", sessions: next });
          // 이후의 listMessages reload race 회피 — dispatch 로 직접 채울 예정.
          skipNextLoadRef.current = true;
          dispatch({ type: "set_active", sessionId: sid });
        }
        const res = await uploadImage({ dataUrl, sessionId: sid, filename: file.name });
        dispatch({
          type: "external_upload",
          tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
          filename: file.name,
          generationId: res.generationId,
          width: res.width,
          height: res.height,
        });
      } catch (e) {
        console.error("[upload]", e);
        dispatch({ type: "sse", event: { type: "error", message: (e as Error).message } });
      }
    },
    [state.activeSessionId],
  );

  useHotkeys("mod+n", e => {
    e.preventDefault();
    handleNew();
  });
  useHotkeys(
    "mod+k",
    e => { e.preventDefault(); setLibOpen(o => !o); },
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
  );

  const hasItems = state.items.length > 0;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-app">
      <SessionList
        sessions={state.sessions}
        activeId={state.activeSessionId}
        onNew={handleNew}
        onSelect={handleSelect}
        onDelete={handleDelete}
      />
      {/* 편집 패널 열림 시 가운데 메인을 좁게 고정 → 우측 MaskCanvas 가 flex-1 로 남은 공간 차지.
          drag-drop: 가운데 column 어디에 떨어뜨려도 업로드. dragCounter 로 child traversal
          중 enter/leave 깜빡임 방지. dataTransfer.types 에 'Files' 있는 경우만 활성. */}
      <div
        className={`relative ${editing ? "flex w-[420px] shrink-0 flex-col" : "flex flex-1 flex-col"}`}
        onDragEnter={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragCounter.current += 1;
          if (dragCounter.current === 1) setDragOver(true);
        }}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          dragCounter.current = Math.max(0, dragCounter.current - 1);
          if (dragCounter.current === 0) setDragOver(false);
        }}
        onDrop={e => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          dragCounter.current = 0;
          setDragOver(false);
          const f = [...e.dataTransfer.files].find(x => /^image\/(png|jpeg|webp)$/.test(x.type));
          if (f) handleUploadImage(f);
        }}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-bg-app/80 backdrop-blur-sm">
            <div className="rounded-2xl border-2 border-dashed border-[color:var(--accent)] bg-bg-card px-8 py-6 text-center shadow-xl">
              <div className="text-3xl">🖼</div>
              <div className="mt-2 text-sm font-medium text-text-primary">여기에 이미지를 드롭</div>
              <div className="text-xs text-text-muted">PNG · JPEG · WebP</div>
            </div>
          </div>
        )}
        <header className="flex h-14 items-center border-b border-border px-4">
          <h1 className="font-mono text-sm text-text-muted">⌘ image-generator</h1>
          <span className="ml-auto text-xs text-text-muted">개인용 · Codex imagegen</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          {hasItems ? (
            <MessageList items={state.items} onAction={handleAction} />
          ) : (
            <EmptyState onPick={handleSend} onUploadImage={handleUploadImage} />
          )}
        </main>
        <Composer
          disabled={state.generating}
          generating={state.generating}
          onSend={handleSend}
          onCancel={handleCancel}
          prefill={composerPrefill}
          onUploadImage={handleUploadImage}
        />
      </div>
      {editing?.mode === "inpaint" && (
        <MaskCanvas
          parentGenerationId={editing.generationId}
          imageUrl={editing.imageUrl}
          imageWidth={editing.width}
          imageHeight={editing.height}
          busy={state.generating}
          onSubmit={handleInpaint}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.mode === "layer" && (
        <LayerCanvas
          parentGenerationId={editing.generationId}
          imageUrl={editing.imageUrl}
          imageWidth={editing.width}
          imageHeight={editing.height}
          busy={state.generating}
          onSubmit={handleLayerSplit}
          onCancel={() => setEditing(null)}
        />
      )}
      {editing?.mode === "sprite" && (
        <SpriteCanvas
          parentGenerationId={editing.generationId}
          imageUrl={editing.imageUrl}
          imageWidth={editing.width}
          imageHeight={editing.height}
          onCancel={() => setEditing(null)}
        />
      )}
      <PromptLibrarySheet
        open={libOpen}
        onClose={() => setLibOpen(false)}
        onUse={text => setComposerPrefill(prev => ({ text, seq: (prev?.seq ?? 0) + 1 }))}
      />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

const SEED_PROMPTS = [
  "도트 스타일 검사 캐릭터, 정면, 투명 배경",
  "8x8 픽셀 아이콘 세트, 검·방패·포션·코인",
  "보스 몬스터 컨셉 아트, 다크판타지, 풀 바디",
  "평타 이펙트 4프레임, 슬래시, 투명 배경",
];

function EmptyState({
  onPick,
  onUploadImage,
}: {
  onPick: (text: string) => void;
  onUploadImage: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="mx-auto flex h-full max-w-[680px] flex-col items-center justify-center gap-6 px-8 text-center">
      <div className="text-5xl">🎨</div>
      <div>
        <h2 className="text-xl font-medium">무엇을 만들까요?</h2>
        <p className="mt-1 text-sm text-text-muted">
          텍스트로 만들거나, 가진 이미지를 업로드해 편집/레이어/스프라이트로 시작하세요.
        </p>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) onUploadImage(f);
          if (e.target) e.target.value = "";
        }}
      />
      <button
        onClick={() => fileRef.current?.click()}
        className="flex w-full items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-bg-card px-6 py-5 text-sm text-text-muted transition-colors hover:border-[color:var(--accent)]/50 hover:bg-[color:var(--accent)]/5 hover:text-text-primary"
      >
        <span className="text-2xl">🖼</span>
        <span className="text-left">
          <span className="block font-medium text-text-primary">이미지 업로드해서 시작</span>
          <span className="text-xs text-text-muted/70">PNG·JPEG·WebP — 업로드 후 편집/레이어/스프라이트 도구 사용 가능</span>
        </span>
      </button>

      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {SEED_PROMPTS.map(p => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="rounded-xl border border-border bg-bg-card px-4 py-3 text-left text-sm text-text-muted transition-colors hover:border-[color:var(--accent)]/40 hover:text-text-primary"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

/** File → "data:image/...;base64,..." dataUrl. */
function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}
