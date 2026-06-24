import { useCallback, useRef, type Dispatch, type MutableRefObject } from "react";

import { friendlyError, type ChatAction } from "@/components/chat/chat-state";
import { listMessages, listPresets, listSessions, streamChat } from "@/lib/api/client";
import type { StylePreset } from "@/types/db";

/**
 * 채팅 SSE 스트림 전송 로직 — ChatLayout 에서 추출.
 * 단일 전송(handleSend) · 배치 전송(handleBatch, handleSend 내부 전용) · 취소(handleCancel)와
 * 전송 전용 ref(presetCache/abortRef)를 캡슐화한다.
 *
 * 공유 ref(streamSeqRef·generatingSessionsRef·activeSessionIdRef·skipNextLoadRef)는
 * ChatLayout 의 다른 핸들러·effect 와 함께 쓰이므로 훅 내부로 옮기지 않고 인자로 받는다.
 */
export function useStreamChat(params: {
  dispatch: Dispatch<ChatAction>;
  activeSessionId: string | null;
  generating: boolean;
  streamSeqRef: MutableRefObject<number>;
  generatingSessionsRef: MutableRefObject<Set<string>>;
  activeSessionIdRef: MutableRefObject<string | null>;
  skipNextLoadRef: MutableRefObject<boolean>;
}) {
  const {
    dispatch,
    activeSessionId,
    generating,
    streamSeqRef,
    generatingSessionsRef,
    activeSessionIdRef,
    skipNextLoadRef,
  } = params;

  const presetCache = useRef<Map<string, StylePreset>>(new Map());
  const abortRef = useRef<AbortController | null>(null);

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
      let curSession = activeSessionId;
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
    [activeSessionId, dispatch, streamSeqRef, skipNextLoadRef],
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
        autoRestore?: boolean;
        presetId?: string;
        count?: number;
      },
    ): Promise<{ generationId: string; width: number; height: number } | null> => {
      if (generating) return null;
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
            autoRestore: opts?.autoRestore,
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
            dispatch({ type: "sse", event: { type: "error", message: friendlyError((e as Error).message) } });
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
    [generating, handleBatch, dispatch, streamSeqRef, generatingSessionsRef, activeSessionIdRef, skipNextLoadRef],
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { handleSend, handleCancel };
}
