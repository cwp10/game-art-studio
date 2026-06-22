"use client";

import { useState } from "react";
import { describePrompt } from "@/lib/api/client";
import { useIsCodex } from "@/lib/context/orchestrator-context";

/**
 * 저장된 프롬프트가 이미 영어 t2i 프롬프트 형태인지 — 한글이 전혀 없고 충분히 서술적이면(≥60자)
 * 비전 재분석 없이 그대로 복사. (한국어 자연어 지시문은 ChatGPT/DALL·E 에 부적합 → 분석 필요.)
 */
function isReadyPrompt(p: string): boolean {
  const hangul = (p.match(/[가-힣]/g) ?? []).length;
  return hangul === 0 && p.trim().length >= 60;
}

/**
 * 이미지 프롬프트 "스마트 복사" 훅 — 결과 카드·갤러리 공용.
 *  - 저장 프롬프트가 이미 영어 t2i 형태면 즉시 그대로 복사
 *  - 한국어 지시문이거나 너무 짧으면 이미지를 비전 분석(describePrompt)해 영어 프롬프트로 복사(수 초)
 * 상태(analyzing/copied/failed)는 버튼 라벨·스피너 피드백에 사용.
 */
export function useCopyPrompt(generationId: string, prompt?: string | null) {
  const [copied, setCopied] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [failed, setFailed] = useState(false);
  const isCodex = useIsCodex();

  // Codex 모드에서 describe(Claude 비전)가 필요한 경우 버튼 비활성화.
  // 이미 영어 t2i 형태면 describe 없이 복사 가능하므로 비활성화하지 않음.
  const disabled = isCodex && !(prompt && isReadyPrompt(prompt));

  async function copy() {
    if (analyzing || disabled) return;
    setFailed(false);
    if (prompt && isReadyPrompt(prompt)) {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      return;
    }
    setAnalyzing(true);
    try {
      const text = await describePrompt(generationId);
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("[describe]", e);
      setFailed(true);
      setTimeout(() => setFailed(false), 2500);
    } finally {
      setAnalyzing(false);
    }
  }

  return { copy, copied, analyzing, failed, disabled };
}
