"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useHotkeys } from "react-hotkeys-hook";
import { chatReducer, initialState } from "./chat-state";
import { Composer, type ComposerAttachment } from "./Composer";
import { MessageList } from "./MessageList";
import { SessionList } from "./SessionList";
import { StatusButton } from "./StatusButton";
import { LayerCanvas } from "@/components/editor/LayerCanvas";
import { MaskCanvas } from "@/components/editor/MaskCanvas";
import { NormalMapPanel } from "@/components/editor/NormalMapPanel";
import { ReskinPanel, type ReskinSubmit } from "@/components/editor/ReskinPanel";
import { SpriteCanvas } from "@/components/editor/SpriteCanvas";
import { SpriteGenPanel } from "@/components/editor/SpriteGenPanel";
import { CompareSheet } from "@/components/library/CompareSheet";
import { GallerySheet } from "@/components/library/GallerySheet";
import { LogsPanel } from "@/components/library/LogsPanel";
import { PromptLibrarySheet } from "@/components/library/PromptLibrarySheet";
import {
  createSession,
  deleteSession,
  galleryInsert,
  listMessages,
  listPresets,
  listSessions,
  recolorImage,
  renameSession,
  streamChat,
  suggestPrompts,
  uploadImage,
  uploadMask,
} from "@/lib/api/client";
import type { StylePreset } from "@/types/db";

/**
 * ChatLayout — 3-column shell (좌: 세션 / 중: 대화 / 우: 추후 패널).
 *
 * 단일 useReducer 로 SSE 이벤트와 사용자 입력을 모두 받아 ChatItem 배열을 시간 순으로 누적.
 */
/** 사용자 프롬프트에서 캐릭터/오브젝트 모드를 추론 — args 추출이 실패했을 때 2차 fallback. */
function inferSubjectModeFromPrompt(prompt?: string): "character" | "object" | undefined {
  if (!prompt) return undefined;
  const p = prompt.toLowerCase();
  if (/배경|background|tileset|tile\s*set|오브젝트|아이템|item|환경|environment|dungeon|동굴|castle|forest|숲|지형|terrain|맵[^핑]|map/.test(p)) return "object";
  if (/캐릭터|character|캐릭|인물|전사|마법사|궁수|기사|영웅|hero|warrior|knight|mage|wizard|archer/.test(p)) return "character";
  return undefined;
}

type EditTarget = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  kind?: string;
  prompt?: string;
};
type Editing =
  | ({ mode: "inpaint" } & EditTarget)
  | ({ mode: "layer" } & EditTarget)
  | ({ mode: "sprite" } & EditTarget)
  | ({ mode: "reskin"; initialMode?: "a" | "b" | "c" } & EditTarget)
  | ({ mode: "normal_map" } & EditTarget)
  | null;

export function ChatLayout() {
  const [state, dispatch] = useReducer(chatReducer, initialState);
  const [editing, setEditing] = useState<Editing>(null);
  // 스프라이트시트 생성 패널 — fresh 생성은 EditTarget(기존 generation) 불필요해 별도 상태.
  // 비null 이면 열림. reference 있으면 결과카드 단축어로 들어온 캐릭터 참조.
  const [spriteGen, setSpriteGen] = useState<{ reference?: EditTarget; initialSubjectMode?: "character" | "object" } | null>(null);
  // 비교 오버레이 — afterId(현재 이미지) + 활성 세션. null 이면 닫힘.
  const [comparing, setComparing] = useState<{ afterId: string } | null>(null);
  const [libOpen, setLibOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  // Composer prefill — seq 카운터로 같은 text 도 매번 새 trigger.
  const [composerPrefill, setComposerPrefill] = useState<{ text: string; seq: number } | null>(null);
  // Composer attachment — 업로드/카드 액션 직후 set. seq 카운터로 동일 generationId 도 새로 trigger.
  const [composerAttachment, setComposerAttachment] = useState<ComposerAttachment | null>(null);
  // 레이어 분리 패널의 누적 추출 결과 — LayerCanvas 결과 그리드에 표시. layer 편집 진입 시 초기화.
  const [layerResults, setLayerResults] = useState<Array<{ id: string; url: string; prompt: string }>>([]);
  // preset cache — handleSend 가 suffix 결합에 사용.
  const presetCache = useRef<Map<string, StylePreset>>(new Map());
  // 항상 최신 activeSessionId 를 가리킴 — handleSend 클로저 스테일 방지.
  const activeSessionIdRef = useRef<string | null>(null);
  // session 활성화 직후의 listMessages reload 를 건너뜀 — 클라이언트가 dispatch 로
  // 이미 items 를 채운 경우 (예: 업로드 흐름) race 로 items 가 빈 응답에 reset 되는 것 방지.
  const skipNextLoadRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 진행 중 스트림 토큰. 세션 전환·새 전송 시 증가시켜, 이전(고아) 스트림의 SSE 콜백이
  // 현재 세션 items 에 dispatch 하는 것을 차단(다른 세션 메시지 누수 방지). 서버 생성은
  // 계속 진행되어 결과는 DB 에 저장됨 — 해당 세션 복귀 시 load_messages 로 표시.
  const streamSeqRef = useRef(0);
  // 진행 중인 세션 ID 집합 — 세션 전환 후 복귀 시 "생성 중..." 복원에 사용
  const generatingSessionsRef = useRef<Set<string>>(new Set());
  // drag-drop 상태 — child 위를 지나면서 enter/leave 가 번갈아 발화해 깜빡이는 것 방지하려고 counter 사용.
  const dragCounter = useRef(0);
  const [dragOver, setDragOver] = useState(false);

  // 세션 목록 로드 — search 변경 시 reload (debounce 200ms).
  useEffect(() => {
    const t = setTimeout(() => {
      listSessions({ search: sessionSearch || undefined }).then(sessions =>
        dispatch({ type: "set_sessions", sessions }),
      );
    }, sessionSearch ? 200 : 0);
    return () => clearTimeout(t);
  }, [sessionSearch]);

  // activeSessionIdRef 항상 최신 동기화
  activeSessionIdRef.current = state.activeSessionId;

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
    // 세션 빠른 연속 전환 race 가드 — 이전 세션 fetch 를 abort 해서 늦게 온 응답이
    // 현재 세션 items 를 덮어쓰지 못하게 한다.
    const loadAbort = new AbortController();
    listMessages(state.activeSessionId, loadAbort.signal)
      .then(messages => {
        dispatch({ type: "load_messages", messages });
        // 이 세션의 생성이 아직 진행 중이면 pending assistant 아이템 복원
        if (generatingSessionsRef.current.has(state.activeSessionId!)) {
          dispatch({ type: "restore_in_progress" });
        }
      })
      .catch(e => {
        if ((e as Error).name !== "AbortError") console.error("[load-messages]", e);
      });
    return () => loadAbort.abort();
  }, [state.activeSessionId]);

  // 새 세션 — 생성 중에는 차단 (UI 잠금 외 키보드 단축키 등 모든 경로 방어)
  const handleNew = useCallback(() => {
    if (state.generating) return;
    streamSeqRef.current++;
    dispatch({ type: "set_active", sessionId: null });
  }, [state.generating]);

  // 세션 선택 — 생성 중에는 차단
  const handleSelect = useCallback((id: string) => {
    if (state.generating) return;
    streamSeqRef.current++;
    dispatch({ type: "set_active", sessionId: id });
  }, [state.generating]);

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

  // 세션 제목 변경 — 낙관적 업데이트 후 PATCH. 실패 시 listSessions 로 롤백/refresh.
  const handleRename = useCallback(async (id: string, title: string) => {
    dispatch({ type: "rename_session", id, title });
    try {
      await renameSession(id, title);
    } catch (e) {
      console.error("[rename-session]", e);
      const next = await listSessions();
      dispatch({ type: "set_sessions", sessions: next });
    }
  }, []);

  // 배치 생성 — 같은 프롬프트로 N장을 순차 생성해 하나의 batch 그리드로 모음.
  // 핵심: 첫 생성이 만든 세션 id 를 캡처해 나머지 N-1 개를 같은 세션으로 보낸다(흩어짐 방지).
  // 일반 sse 리듀서를 거치지 않고 streamChat 을 직접 호출 — 콜백에서 session_started.sessionId 와
  // tool_call_finished.result 만 캡처해 batch_result 로 dispatch.
  const handleBatch = useCallback(
    async (text: string, count: number, presetId?: string) => {
      let finalText = text;
      if (presetId) {
        let p = presetCache.current.get(presetId);
        if (!p) {
          const all = await listPresets();
          for (const x of all) presetCache.current.set(x.id, x);
          p = presetCache.current.get(presetId);
        }
        if (p?.prompt_suffix) finalText = `${text}, ${p.prompt_suffix}`;
      }
      const userTempId = "tmp-" + Math.random().toString(36).slice(2, 8);
      const batchId = "batch-" + Math.random().toString(36).slice(2, 8);
      dispatch({ type: "batch_start", userTempId, text: finalText, batchId, total: count });

      // 스트림 토큰 — 세션 전환 시 무효화되어 배치 결과가 다른 세션에 누수되지 않게 한다.
      const myToken = ++streamSeqRef.current;
      const isCurrent = () => streamSeqRef.current === myToken;

      // 첫 회 새 세션이면 session_started 후의 listMessages reload race 를 1회 skip.
      let curSession = state.activeSessionId;
      if (!curSession) skipNextLoadRef.current = true;
      let refreshedSessions = false;

      const abort = new AbortController();
      abortRef.current = abort;
      try {
        for (let i = 0; i < count; i++) {
          let result:
            | { generationId: string; imageUrl: string; width: number; height: number }
            | { error: string }
            | null = null;
          try {
            await streamChat(
              {
                sessionId: curSession ?? undefined,
                message: finalText,
                batch: { id: batchId, index: i, total: count },
              },
              event => {
                if (!isCurrent()) return; // 세션 전환됨 — 이 배치는 더 이상 화면 주인이 아님
                if (event.type === "session_started") {
                  curSession = event.sessionId;
                  if (!refreshedSessions) {
                    refreshedSessions = true;
                    listSessions().then(sessions => dispatch({ type: "set_sessions", sessions }));
                  }
                } else if (event.type === "tool_call_finished") {
                  if ("error" in event.result) {
                    result = { error: event.result.error };
                  } else {
                    result = {
                      generationId: event.result.generationId,
                      imageUrl: `/api/images/${event.result.generationId}`,
                      width: event.result.width,
                      height: event.result.height,
                    };
                  }
                } else if (event.type === "error") {
                  result = { error: event.message };
                }
              },
              abort.signal,
            );
          } catch (e) {
            if ((e as Error).name === "AbortError") {
              dispatch({ type: "batch_result", batchId, result: { error: "취소되었습니다." } });
              // 남은 슬롯에 스피너가 무한히 도는 것을 막는다(취소된 그리드 확정).
              dispatch({ type: "batch_stopped", batchId });
              break;
            }
            result = { error: (e as Error).message };
          }
          // 세션이 전환됐으면 남은 배치 멤버를 더 보내지 않고, 결과도 dispatch 하지 않는다.
          if (!isCurrent()) break;
          dispatch({
            type: "batch_result",
            batchId,
            result: result ?? { error: "결과를 받지 못했어요." },
          });
        }
      } finally {
        if (isCurrent()) dispatch({ type: "set_generating", generating: false });
        if (abortRef.current === abort) abortRef.current = null;
        const next = await listSessions();
        dispatch({ type: "set_sessions", sessions: next });
      }
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
        extractObject?: boolean;
        presetId?: string;
        count?: number;
      },
    ): Promise<{ generationId: string; width: number; height: number } | null> => {
      if (state.generating) return null;
      // 배치(count>1): preset suffix 결합까지 포함해 전용 순차 흐름으로 위임. 단일 생성 회귀 없음.
      if (opts?.count && opts.count > 1) {
        await handleBatch(text, opts.count, opts.presetId);
        return null;
      }
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
      // 새 세션 전송: session_started 가 activeSessionId 를 바꾸면 세션 로드 effect 가
      // 발동해 아직 메시지가 저장되지 않은 빈 세션을 listMessages 로 읽어와 방금 만든
      // user/assistant 아이템을 덮어쓴다(→ 이후 SSE 이벤트가 전부 드롭). 그 1회 reload 를 skip.
      // activeSessionIdRef 는 렌더 사이클과 무관하게 항상 최신값 — 스테일 클로저 방지.
      const currentSessionId = activeSessionIdRef.current;
      if (!currentSessionId) skipNextLoadRef.current = true;
      dispatch({ type: "user_send", tempId, text: finalText });

      // 이 스트림의 토큰 — 세션 전환·다음 전송이 streamSeqRef 를 올리면 아래 콜백이
      // 무효화돼 더 이상 현재 items 를 건드리지 않는다(다른 세션 누수 방지).
      const myToken = ++streamSeqRef.current;
      const isCurrent = () => streamSeqRef.current === myToken;

      // 진행 중 세션 추적 — 알려진 세션이면 즉시, 새 세션이면 session_started 후 추가
      let trackedSessionId: string | null = currentSessionId;
      if (currentSessionId) generatingSessionsRef.current.add(currentSessionId);

      // 생성 결과(generationId/치수)를 캡처해 호출자에 반환 — 편집 패널의 연속 편집에 사용.
      let sendResult: { generationId: string; width: number; height: number } | null = null;
      const abort = new AbortController();
      abortRef.current = abort;
      try {
        await streamChat(
          {
            sessionId: currentSessionId ?? undefined,
            message: finalText,
            attachmentGenerationIds: opts?.attachmentGenerationIds,
            maskGenerationId: opts?.maskGenerationId,
            extractObject: opts?.extractObject,
          },
          event => {
            // 세션이 전환됐거나 새 전송이 시작됐으면 이 스트림은 더 이상 화면 주인이 아님 — 무시.
            if (!isCurrent()) return;
            dispatch({ type: "sse", event });
            // 새 세션이 만들어지는 즉시(생성 시작 시점) 사이드바 갱신 — 응답 완료까지 기다리지 않음.
            if (event.type === "session_started") {
              // 새 세션 케이스: 이제 실제 sessionId 를 알았으므로 추적 업데이트
              if (!currentSessionId) {
                trackedSessionId = event.sessionId;
                generatingSessionsRef.current.add(event.sessionId);
              }
              listSessions().then(sessions => dispatch({ type: "set_sessions", sessions }));
            }
            if (event.type === "tool_call_finished" && "generationId" in event.result) {
              sendResult = {
                generationId: event.result.generationId,
                width: event.result.width,
                height: event.result.height,
              };
            }
          },
          abort.signal,
        );
        // 응답 끝나면 세션 목록 refresh (새 세션이 만들어졌거나 updated_at 갱신)
        const next = await listSessions();
        dispatch({ type: "set_sessions", sessions: next });
      } catch (e) {
        if (isCurrent()) {
          if ((e as Error).name === "AbortError") {
            dispatch({ type: "sse", event: { type: "error", message: "취소되었습니다." } });
          } else {
            console.error(e);
            dispatch({ type: "sse", event: { type: "error", message: (e as Error).message } });
          }
        }
      } finally {
        // 내 스트림이 여전히 현재일 때만 generating 해제 — 전환 후엔 새 컨텍스트 상태를 건드리지 않음.
        if (isCurrent()) dispatch({ type: "set_generating", generating: false });
        if (abortRef.current === abort) abortRef.current = null;

        // 진행 중 추적 정리
        if (trackedSessionId) generatingSessionsRef.current.delete(trackedSessionId);

        // 스트림이 완료됐을 때 사용자가 이미 이 세션으로 돌아와 있으면 messages 를
        // reload 해 완료된 결과를 표시하고, restore 로 켜둔 generating 을 내린다
        // (isCurrent()=false 라 위 set_generating 이 스킵되므로 여기서 명시 해제).
        if (!isCurrent() && trackedSessionId && activeSessionIdRef.current === trackedSessionId) {
          listMessages(trackedSessionId)
            .then(messages => {
              dispatch({ type: "load_messages", messages });
              dispatch({ type: "set_generating", generating: false });
            })
            .catch(() => {});
        }
      }
      return sendResult;
    },
    [state.generating, handleBatch],
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
        | "sprite_split"
        | "reskin"
        | "overlay"
        | "make_sheet"
        | "make_normal_map"
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
    ) => {
      if (action === "compare" && payload.generationId) {
        setComparing({ afterId: payload.generationId });
      } else if (action === "duplicate" && payload.prompt) {
        handleSend(payload.prompt);
      } else if (action === "reference" && payload.generationId) {
        // 이 결과를 다음 메시지의 reference 로 attach.
        const label = payload.prompt?.slice(0, 32) ?? payload.generationId.slice(0, 8);
        setComposerAttachment(prev => ({
          generationId: payload.generationId!,
          label,
          seq: (prev?.seq ?? 0) + 1,
        }));
      } else if (action === "resize" && payload.generationId && payload.targetSize) {
        handleSend(`이 이미지를 ${payload.targetSize}×${payload.targetSize} 로 리사이즈해줘.`, {
          attachmentGenerationIds: [payload.generationId],
        });
      } else if (action === "remove_bg" && payload.generationId) {
        handleSend("이 이미지의 배경을 투명하게 제거해줘.", {
          attachmentGenerationIds: [payload.generationId],
        });
      } else if (action === "make_normal_map" && payload.generationId && payload.width && payload.height) {
        setSpriteGen(null);
        setEditing({
          mode: "normal_map",
          generationId: payload.generationId,
          imageUrl: `/api/images/${payload.generationId}`,
          width: payload.width,
          height: payload.height,
          kind: payload.kind,
        });
      } else if (action === "overlay" && payload.generationId && payload.width && payload.height) {
        // 캐릭터 오버레이 = 리스킨 모드 c(참조 전이)를 시트 베이스로 바로 오픈.
        // 백엔드 동일 — 패널이 시트+모드c 일 때 "캐릭터 오버레이"로 리프레이밍.
        setSpriteGen(null);
        setEditing({
          mode: "reskin",
          initialMode: "c",
          generationId: payload.generationId,
          imageUrl: `/api/images/${payload.generationId}`,
          width: payload.width,
          height: payload.height,
          kind: payload.kind,
        });
      } else if (action === "make_sheet" && payload.generationId && payload.width && payload.height) {
        setEditing(null);
        setSpriteGen({
          reference: {
            generationId: payload.generationId,
            imageUrl: `/api/images/${payload.generationId}`,
            width: payload.width,
            height: payload.height,
            kind: payload.kind,
            prompt: payload.prompt,
          },
          initialSubjectMode:
            payload.subjectMode ??
            inferSubjectModeFromPrompt(payload.prompt),
        });
      } else if (
        (action === "edit" ||
          action === "layer_split" ||
          action === "sprite_split" ||
          action === "reskin") &&
        payload.generationId &&
        payload.width &&
        payload.height
      ) {
        const mode =
          action === "edit"
            ? "inpaint"
            : action === "layer_split"
              ? "layer"
              : action === "sprite_split"
                ? "sprite"
                : "reskin";
        setSpriteGen(null);
        setEditing({
          mode,
          generationId: payload.generationId,
          imageUrl: `/api/images/${payload.generationId}`,
          width: payload.width,
          height: payload.height,
          kind: payload.kind,
        });
        if (mode === "layer") setLayerResults([]);
      }
    },
    [handleSend],
  );

  // 편집 패널 '실행' — 인페인트 / 리사이즈(긴 변 기준, 비율 유지) / 배경 제거를 설정된 것만
  // 순차 적용한다. 각 단계 결과를 다음 단계 입력으로 이어받고, 최종 결과를 패널의 새 베이스로
  // 띄워 연속 편집. 각 단계는 handleSend 를 거쳐 채팅 타임라인에 그대로 누적된다.
  const handleInpaint = useCallback(
    async ({
      maskDataUrl,
      prompt,
      resizeTarget,
      removeBg,
      referenceGenerationId,
    }: {
      maskDataUrl: string | null;
      prompt: string;
      resizeTarget: number | null;
      removeBg: boolean;
      referenceGenerationId: string | null;
    }) => {
      if (!editing || editing.mode !== "inpaint") return;
      let curId = editing.generationId;
      let curW = editing.width;
      let curH = editing.height;
      try {
        // 1. 인페인트 (마스크 + 프롬프트가 있을 때만)
        if (maskDataUrl && prompt) {
          const maskId = await uploadMask(curId, maskDataUrl);
          // 참조 이미지가 있으면 첫=입력 둘째=참조 순서로 attachment 에 포함.
          const attachments = referenceGenerationId
            ? [curId, referenceGenerationId]
            : [curId];
          const r = await handleSend(prompt, {
            attachmentGenerationIds: attachments,
            maskGenerationId: maskId,
          });
          if (r) ({ generationId: curId, width: curW, height: curH } = r);
        }
        // 2. 리사이즈 — 긴 변(가로·세로 중 큰 쪽)을 선택 크기로, 비율 유지.
        if (resizeTarget) {
          const r = await handleSend(
            `이 이미지의 긴 변(가로·세로 중 큰 쪽)을 ${resizeTarget}px 로 리사이즈해줘. 가로세로 비율은 그대로 유지.`,
            { attachmentGenerationIds: [curId] },
          );
          if (r) ({ generationId: curId, width: curW, height: curH } = r);
        }
        // 3. 배경 제거
        if (removeBg) {
          const r = await handleSend("이 이미지의 배경을 투명하게 제거해줘.", {
            attachmentGenerationIds: [curId],
          });
          if (r) ({ generationId: curId, width: curW, height: curH } = r);
        }
        // 최종 결과를 새 베이스로 (변경이 있었을 때만)
        if (curId !== editing.generationId) {
          setEditing({
            mode: "inpaint",
            generationId: curId,
            imageUrl: `/api/images/${curId}`,
            width: curW,
            height: curH,
          });
        }
      } catch (e) {
        console.error("[edit]", e);
        dispatch({
          type: "sse",
          event: { type: "error", message: (e as Error).message },
        });
      }
    },
    [editing, handleSend],
  );

  // ReskinPanel 이 submit 한 payload → 모드별 자연어 메시지 + attachments 로 handleSend.
  // 자연어 문구·첨부 순서는 system-orchestrator.md 의 reskin_image 라우팅과 정합:
  //  - (a) "…로 리스킨해줘"           → prompt 모드
  //  - (b) "색 팔레트만 …로 바꿔줘. 형태는 그대로 유지." → paletteOnly 인식
  //  - (c) 첫=inputGenerationId, 둘째=styleReferenceId — route.ts 가 첨부 순서대로 [reference] 주입.
  const handleReskin = useCallback(
    async (payload: ReskinSubmit) => {
      if (!editing || editing.mode !== "reskin") return;
      const genId = editing.generationId;
      // 시트 베이스 + 모드 c = 캐릭터 오버레이 → 메시지 문구를 오버레이 맥락으로.
      const isSheetBase = editing.kind === "spritesheet";
      setEditing(null);
      if (payload.mode === "b-precise") {
        // 결정적 색교체 — codex/Claude 우회, 전용 API 직접 호출 후 합성 결과 카드 삽입.
        try {
          const res = await recolorImage({
            parentGenerationId: genId,
            mappings: payload.mappings,
            includeGrays: payload.includeGrays,
          });
          dispatch({
            type: "add_result_card",
            tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
            userText: "🎨 정밀 색교체",
            generationId: res.generationId,
            width: res.width,
            height: res.height,
            kind: "reskin",
          });
        } catch (e) {
          console.error("[reskin-precise]", e);
        }
        return;
      }
      if (payload.mode === "a") {
        handleSend(`이 이미지를 ${payload.prompt} 로 리스킨해줘.`, {
          attachmentGenerationIds: [genId],
        });
      } else if (payload.mode === "b") {
        handleSend(`이 이미지의 색 팔레트만 ${payload.prompt} 로 바꿔줘. 형태는 그대로 유지.`, {
          attachmentGenerationIds: [genId],
        });
      } else {
        const msg = isSheetBase
          ? `베이스 시트(첫 번째 이미지)의 모든 포즈에 두 번째 이미지의 캐릭터를 입혀줘. 포즈·프레임 구성은 그대로 유지.${payload.extra ? ` ${payload.extra}` : ""}`
          : `이 캐릭터(첫 번째 이미지)에 두 번째 이미지의 화풍·스타일을 입혀줘.${payload.extra ? ` ${payload.extra}` : ""}`;
        handleSend(msg, { attachmentGenerationIds: [genId, payload.styleReferenceId] });
      }
    },
    [editing, handleSend],
  );

  // SpriteGenPanel 이 submit 한 완성 메시지 배열 → 순차 handleSend.
  // 패널이 마커 directive + 자연어 + 스타일 suffix 해석까지 끝낸 메시지를 넘긴다.
  // 마커는 오케스트레이터가 그대로 make_spritesheet 에 전달(rows/cols/subjectType/
  // anchorStrategy/directions/seamlessLoop). 참조는 attachmentGenerationIds 로 → inputGenerationId.
  // 순차 await 는 layer-split 와 동일한 검증된 패턴(각 완료 후 다음, generating 충돌 없음).
  const handleSpriteGen = useCallback(
    async (messages: Array<{ message: string; attachmentGenerationIds: string[] }>) => {
      setSpriteGen(null);
      for (const m of messages) {
        await handleSend(m.message, { attachmentGenerationIds: m.attachmentGenerationIds });
      }
    },
    [handleSend],
  );

  // LayerCanvas 가 submit 한 부위 이름들 → 부위별로 텍스트 기반 추출을 직렬 호출.
  // 각 부위마다 handleSend(extractObject:true, 마스크 없음) → 라우트가 [extract] 마커 주입 →
  // Claude 가 inpaint_image(extractObject=true, prompt=부위명) 호출 → 투명 배경 PNG 추출.
  // 처리 중 LayerCanvas 는 busy 상태로 유지. 완료 후 사용자가 직접 닫는다.
  const handleLayerSplit = useCallback(
    async ({ parts }: { parts: string[] }) => {
      if (!editing || editing.mode !== "layer") return;
      const parentId = editing.generationId;
      for (const part of parts) {
        try {
          const r = await handleSend(
            `${part} 레이어 추출`,
            {
              attachmentGenerationIds: [parentId],
              extractObject: true,
              // maskGenerationId 없음 — 텍스트 기반 추출
            },
          );
          if (r) {
            setLayerResults(prev => [
              ...prev,
              { id: r.generationId, url: `/api/images/${r.generationId}`, prompt: part },
            ]);
          }
        } catch (e) {
          console.error("[layer-extract]", part, e);
          dispatch({
            type: "sse",
            event: { type: "error", message: `${part}: ${(e as Error).message}` },
          });
        }
      }
    },
    [editing, handleSend],
  );

  // LayerCanvas "브러쉬로 분리" — 사용자가 칠한 마스크를 업로드한 뒤 부위명과 함께 추출.
  // 마스크 기반(maskGenerationId)이라는 점만 handleLayerSplit 과 다르며, 결과 수집은 동일.
  const handleLayerBrush = useCallback(
    async ({ maskDataUrl, prompt }: { maskDataUrl: string; prompt: string }) => {
      if (!editing || editing.mode !== "layer") return;
      const parentId = editing.generationId;
      try {
        const maskId = await uploadMask(parentId, maskDataUrl);
        const r = await handleSend(
          `${prompt} 레이어 추출`,
          { attachmentGenerationIds: [parentId], maskGenerationId: maskId, extractObject: true },
        );
        if (r) {
          setLayerResults(prev => [
            ...prev,
            { id: r.generationId, url: `/api/images/${r.generationId}`, prompt },
          ]);
        }
      } catch (e) {
        console.error("[layer-brush]", e);
        dispatch({ type: "sse", event: { type: "error", message: (e as Error).message } });
      }
    },
    [editing, handleSend],
  );

  // [✨ 제안] — 사용자 입력을 LLM 으로 다양화한 3-4개 컨셉을 chat 에 카드로 표시.
  // active session 없으면 신규 생성. dispatch suggestions_requested → API 호출 →
  // suggestions_received. 카드 클릭은 onPickSuggestion 으로 Composer prefill.
  const handleAskSuggestions = useCallback(
    async (text: string) => {
      try {
        let sid = state.activeSessionId;
        if (!sid) {
          const newSession = await createSession(text.slice(0, 40));
          sid = newSession.id;
          const next = await listSessions();
          dispatch({ type: "set_sessions", sessions: next });
          skipNextLoadRef.current = true;
          dispatch({ type: "set_active", sessionId: sid });
        }
        const userTempId = "tmp-" + Math.random().toString(36).slice(2, 8);
        const suggestId = "sug-" + Math.random().toString(36).slice(2, 8);
        dispatch({ type: "suggestions_requested", userTempId, suggestId, text });
        try {
          const items = await suggestPrompts(text);
          dispatch({ type: "suggestions_received", suggestId, items });
        } catch (e) {
          dispatch({ type: "suggestions_failed", suggestId, error: (e as Error).message });
        }
      } catch (e) {
        console.error("[suggest]", e);
        dispatch({ type: "sse", event: { type: "error", message: (e as Error).message } });
      }
    },
    [state.activeSessionId],
  );

  const handlePickSuggestion = useCallback((suggestId: string, body: string) => {
    setComposerPrefill(prev => ({ text: body, seq: (prev?.seq ?? 0) + 1 }));
    dispatch({ type: "suggestion_picked", suggestId, body });
  }, []);

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
        // 다음 메시지가 이 이미지를 reference 로 자연 사용. seq 카운터로 같은 id 도 재트리거.
        setComposerAttachment(prev => ({
          generationId: res.generationId,
          label: file.name,
          seq: (prev?.seq ?? 0) + 1,
        }));
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
  useHotkeys(
    "mod+g",
    e => { e.preventDefault(); setGalleryOpen(o => !o); },
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
  );
  useHotkeys(
    "mod+shift+l",
    e => { e.preventDefault(); setLogsOpen(o => !o); },
    { enableOnFormTags: ["TEXTAREA", "INPUT"] },
  );

  // 갤러리에서 [첨부] — 이 이미지를 현재 대화에 결과 카드로 삽입해 카드의 모든 기능
  // (편집/레이어/스프라이트/리스킨/캐릭터/비교/참조/복제/저장)을 바로 쓸 수 있게 한다.
  // DB 에 message 쌍을 저장해 앱 재실행 후에도 세션에서 복원 가능.
  const handleGalleryInsert = useCallback(
    async (payload: { generationId: string; prompt?: string; width: number; height: number; kind?: string }) => {
      // 활성 세션이 없으면(새 세션 상태) 새 세션을 만들어 활성화 — 이후 이 카드에서 한 작업이 이 세션에 쌓인다.
      // 업로드 흐름과 동일: set_active 가 유발하는 listMessages reload 가 합성 카드를 덮지 않도록 1회 skip.
      let sid = state.activeSessionId;
      if (!sid) {
        const title = (payload.prompt?.slice(0, 40) || "갤러리에서 추가").trim();
        const newSession = await createSession(title);
        sid = newSession.id;
        const next = await listSessions();
        dispatch({ type: "set_sessions", sessions: next });
        skipNextLoadRef.current = true;
        dispatch({ type: "set_active", sessionId: sid });
      }
      // 재실행 후 복원을 위해 메시지 쌍을 DB 에 저장 (fire-and-forget).
      galleryInsert(sid, payload.generationId).catch(e => console.error("[gallery-insert]", e));
      dispatch({
        type: "add_result_card",
        tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
        // gallery-insert API(route.ts)의 영속화와 동일하게 80자 요약 — 라이브/리로드 일관.
        userText: payload.prompt?.slice(0, 80) || "🖼 갤러리에서 추가",
        generationId: payload.generationId,
        width: payload.width,
        height: payload.height,
        kind: payload.kind,
      });
    },
    [state.activeSessionId],
  );

  const hasItems = state.items.length > 0;
  // 편집/레이어/스프라이트/리스킨/시트 패널이 열리면 세션 리스트를 숨기고
  // 대화창을 좁혀(1/3) 우측 2/3 패널과 화면을 분할한다.
  const editorPanelOpen = editing !== null || spriteGen !== null;

  return (
    <div className="flex h-screen w-full overflow-hidden bg-bg-app">
      {!editorPanelOpen && (
        <SessionList
          sessions={state.sessions}
          activeId={state.activeSessionId}
          search={sessionSearch}
          onSearch={setSessionSearch}
          onNew={handleNew}
          onSelect={handleSelect}
          onDelete={handleDelete}
          onRename={handleRename}
          onOpenGallery={() => setGalleryOpen(true)}
          generating={state.generating}
        />
      )}
      {/* 편집 패널 열림 시 가운데 메인을 좁게 고정 → 우측 MaskCanvas 가 flex-1 로 남은 공간 차지.
          drag-drop: 가운데 column 어디에 떨어뜨려도 업로드. dragCounter 로 child traversal
          중 enter/leave 깜빡임 방지. dataTransfer.types 에 'Files' 있는 경우만 활성. */}
      <div
        className={`relative flex flex-col ${editorPanelOpen ? "w-1/2" : "flex-1"}`}
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
          <h1 className="font-mono text-sm text-text-muted">⌘ Sprite Forge</h1>
          <span className="ml-auto mr-2 text-xs text-text-muted">개인용 · Codex imagegen</span>
          <StatusButton />
        </header>
        <main className="flex-1 overflow-y-auto">
          {hasItems ? (
            <MessageList
              items={state.items}
              onAction={handleAction}
              onPickSuggestion={handlePickSuggestion}
            />
          ) : (
            <EmptyState
              onPick={text => setComposerPrefill(prev => ({ text, seq: (prev?.seq ?? 0) + 1 }))}
              onUploadImage={handleUploadImage}
            />
          )}
        </main>
        <Composer
          disabled={state.generating}
          generating={state.generating}
          onSend={handleSend}
          onCancel={handleCancel}
          prefill={composerPrefill}
          attachment={composerAttachment}
          onAskSuggestions={handleAskSuggestions}
          onUploadImage={handleUploadImage}
        />
      </div>
      {editing?.mode === "inpaint" && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <MaskCanvas
            key={editing.generationId}
            parentGenerationId={editing.generationId}
            imageUrl={editing.imageUrl}
            imageWidth={editing.width}
            imageHeight={editing.height}
            sessionId={state.activeSessionId}
            busy={state.generating}
            onSubmit={handleInpaint}
            onCancel={() => setEditing(null)}
            onCancelGeneration={handleCancel}
          />
        </div>
      )}
      {editing?.mode === "layer" && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <LayerCanvas
            parentGenerationId={editing.generationId}
            imageUrl={editing.imageUrl}
            imageWidth={editing.width}
            imageHeight={editing.height}
            busy={state.generating}
            results={layerResults}
            onSubmit={handleLayerSplit}
            onBrushSubmit={handleLayerBrush}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
      {editing?.mode === "sprite" && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <SpriteCanvas
            key={editing.generationId}
            parentGenerationId={editing.generationId}
            imageUrl={editing.imageUrl}
            imageWidth={editing.width}
            imageHeight={editing.height}
            sessionId={state.activeSessionId}
            sheetGenerationId={editing.generationId}
            onSheetUpdated={res => {
              // 셀 재생성 결과를 chat 카드로 삽입 + 패널을 새 시트로 re-point. key=generationId 가
              // 바뀌면서 SpriteCanvas 가 새 시트 픽셀로 깨끗이 remount → 연속 재생성이 누적된다.
              dispatch({
                type: "add_result_card",
                tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
                userText: "✏️ 프레임 재생성",
                generationId: res.generationId,
                width: res.width,
                height: res.height,
                kind: "spritesheet",
              });
              setEditing({
                mode: "sprite",
                generationId: res.generationId,
                imageUrl: `/api/images/${res.generationId}`,
                width: res.width,
                height: res.height,
              });
            }}
            onSaved={res => {
              // 보정본을 결과 카드로 chat 에 삽입(reskin b-precise 패턴). 패널은 계속 열린 채로
              // 유지 — 사용자가 추가 방향 보정을 이어갈 수 있게.
              dispatch({
                type: "add_result_card",
                tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
                userText: "🎞️ 보정된 스프라이트시트",
                generationId: res.generationId,
                width: res.width,
                height: res.height,
                kind: "spritesheet",
              });
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}
      {editing?.mode === "reskin" && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <ReskinPanel
            generationId={editing.generationId}
            imageUrl={editing.imageUrl}
            width={editing.width}
            height={editing.height}
            kind={editing.kind}
            initialMode={editing.initialMode}
            sessionId={state.activeSessionId}
            onSubmit={handleReskin}
            onClose={() => setEditing(null)}
          />
        </div>
      )}
      {editing?.mode === "normal_map" && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <NormalMapPanel
            generationId={editing.generationId}
            imageUrl={editing.imageUrl}
            width={editing.width}
            height={editing.height}
            onResult={res => {
              dispatch({
                type: "add_result_card",
                tempId: "tmp-" + Math.random().toString(36).slice(2, 8),
                userText: "🗺️ 노멀맵",
                generationId: res.generationId,
                width: res.width,
                height: res.height,
                kind: "normal_map",
              });
              setEditing(null);
            }}
            onClose={() => setEditing(null)}
          />
        </div>
      )}
      {spriteGen && (
        <div className="fixed inset-y-0 right-0 z-40 w-1/2">
          <SpriteGenPanel
            referenceId={spriteGen.reference?.generationId}
            referenceImageUrl={spriteGen.reference?.imageUrl}
            referencePrompt={spriteGen.reference?.prompt}
            initialSubjectMode={spriteGen.initialSubjectMode}
            onSubmit={handleSpriteGen}
            onClose={() => setSpriteGen(null)}
          />
        </div>
      )}
      <PromptLibrarySheet
        open={libOpen}
        onClose={() => setLibOpen(false)}
        onUse={text => setComposerPrefill(prev => ({ text, seq: (prev?.seq ?? 0) + 1 }))}
      />
      <GallerySheet
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onInsert={handleGalleryInsert}
        generating={state.generating}
      />
      {comparing && (
        <CompareSheet
          open
          afterId={comparing.afterId}
          sessionId={state.activeSessionId}
          onClose={() => setComparing(null)}
        />
      )}
      <LogsPanel open={logsOpen} onClose={() => setLogsOpen(false)} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────

// 칸 순서 고정: [캐릭터, 배경, 이펙트, 오브젝트]. 각 칸 내용은 새 세션 진입마다
// 해당 카테고리 풀에서 랜덤 1개씩 제시(고퀄 일러스트 톤). EmptyState 참고.
const SEED_POOLS: string[][] = [
  // 캐릭터 — 어울리는 배경과 함께 생성 (서버 배경 보존 키워드 "배경" 포함)
  [
    "달빛 아래 은빛 머리 엘프 검사, 고퀄리티 판타지 캐릭터 일러스트, 달빛 내리는 고성 배경",
    "붉은 망토를 두른 여마법사, 디테일한 캐릭터 일러스트, 신비로운 마법 도서관 배경",
    "기계 의수를 단 사이버펑크 현상금 사냥꾼, 고퀄 일러스트, 빗내리는 네온 사이버도시 배경",
    "꽃밭에 앉은 동양풍 소녀, 부드러운 수채 일러스트, 만개한 봄꽃 정원 배경",
  ],
  // 배경 — "배경" 키워드로 서버가 투명화하지 않도록
  [
    "노을 지는 해안 절벽의 외딴 등대, 시네마틱 배경 일러스트, 따뜻한 색감",
    "안개 낀 고대 숲속 폐허, 판타지 배경 일러스트, 신비로운 빛줄기",
    "비 내리는 네온 사이버펑크 도시 거리, 시네마틱 배경 일러스트, 젖은 노면 반사광",
    "구름 위에 떠 있는 천공의 성, 장엄한 판타지 배경 일러스트, 황금빛 노을",
  ],
  // 이펙트
  [
    "화염 폭발 마법 이펙트, 역동적인 일러스트, 강렬한 빛과 불티",
    "푸른 회복 마법 오라, 빛나는 입자 이펙트, 환상적인 일러스트",
    "번개 마법 임팩트, 역동적인 전기 이펙트, 시네마틱 일러스트",
    "흩날리는 벚꽃잎과 바람 이펙트, 부드러운 일러스트, 봄 감성",
  ],
  // 오브젝트
  [
    "빛나는 고대 마법 검, 디테일한 판타지 오브젝트 일러스트, 어두운 배경",
    "보석이 박힌 황금 왕관, 정교한 일러스트, 부드러운 스튜디오 조명",
    "낡은 가죽 표지의 마법서, 분위기 있는 오브젝트 일러스트, 촛불 조명",
    "신비로운 빛을 내는 마법 물약 병, 디테일한 일러스트, 어두운 배경",
  ],
];

function EmptyState({
  onPick,
  onUploadImage,
}: {
  onPick: (text: string) => void;
  onUploadImage: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  // 서버/첫 렌더는 결정적(각 카테고리 첫 항목)으로 두고, 마운트 후 랜덤 교체 — hydration mismatch 방지.
  const [picks, setPicks] = useState<string[]>(() => SEED_POOLS.map(pool => pool[0]));
  useEffect(() => {
    setPicks(SEED_POOLS.map(pool => pool[Math.floor(Math.random() * pool.length)]));
  }, []);
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
        {picks.map(p => (
          <button
            key={p}
            onClick={() => onPick(p)}
            className="rounded-xl border border-border bg-bg-card px-4 py-3 text-left text-xs text-text-muted transition-colors hover:border-[color:var(--accent)]/40 hover:text-text-primary"
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
