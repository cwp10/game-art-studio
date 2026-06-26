"use client";

import { ArrowLeft, Gamepad2, Layers, Scissors } from "lucide-react";
import { useState } from "react";
import { ButtonStateEditor } from "@/components/editor/ButtonStateEditor";
import { NineSliceEditor } from "@/components/editor/NineSliceEditor";
import { NormalMapPanel } from "@/components/editor/NormalMapPanel";

type Tab = "normal_map" | "nine_slice" | "button_states";

const TAB_META: Array<{ id: Tab; label: string; icon: typeof Layers; hideFor: string[] }> = [
  { id: "normal_map",    label: "노멀맵",    icon: Layers,   hideFor: ["normal_map", "mask", "layer"] },
  { id: "nine_slice",    label: "9-Slice",   icon: Scissors, hideFor: ["spritesheet", "composite", "nine_slice", "nine_slice_scaled", "nine_slice_trimmed"] },
  { id: "button_states", label: "버튼 생성", icon: Gamepad2, hideFor: ["spritesheet", "composite", "nine_slice", "nine_slice_scaled", "nine_slice_trimmed", "button_state"] },
];

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  kind?: string;
  sessionId: string | null;
  onClose: () => void;
  onGeneratingChange?: (generating: boolean) => void;
  onNormalMapResult: (res: { generationId: string; imageUrl: string; width: number; height: number }) => void;
  onNineSliceResult: (res: { generationId: string; width: number; height: number; kind: string }) => void;
  onButtonStateResult: (res: {
    normal: { generationId: string; width: number; height: number };
    hover: { generationId: string; width: number; height: number };
    pressed: { generationId: string; width: number; height: number };
  }) => void;
  onButtonStateAddOne: (res: { generationId: string; width: number; height: number; state: "normal" | "hover" | "pressed" }) => void;
};

export function ImageToolsPanel({
  generationId, imageUrl, width, height, kind, sessionId,
  onClose, onGeneratingChange, onNormalMapResult, onNineSliceResult, onButtonStateResult, onButtonStateAddOne,
}: Props) {
  const tabs = TAB_META.filter(t => !t.hideFor.includes(kind ?? ""));
  const [active, setActive] = useState<Tab>(tabs[0]?.id ?? "normal_map");

  return (
    <aside className="flex h-full min-w-[480px] flex-1 flex-col border-l border-border bg-bg-panel">
      {/* 행 1: 뒤로 + 제목·설명 */}
      <header className="flex h-[50px] flex-none items-center gap-3 border-b border-border px-3.5">
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-panel hover:text-text-primary"
          title="대화로 돌아가기"
        >
          <ArrowLeft size={14} /> 대화로 돌아가기
        </button>
        <div className="flex flex-col leading-tight">
          <span className="text-sm font-medium text-text-primary">이미지 도구</span>
          <span className="text-[11px] text-text-muted">노멀맵 · 9-Slice · 버튼 상태를 생성합니다</span>
        </div>
      </header>

      {/* 행 2: 탭 바 */}
      <div className="flex flex-none items-center gap-2 border-b border-border px-3.5 py-2 text-xs">
        <div className="flex gap-1 rounded-lg border border-border bg-bg-card p-0.5">
          {tabs.map(t => {
            const Icon = t.icon;
            const isActive = t.id === active;
            return (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={`flex h-7 items-center gap-1.5 rounded-md px-3 transition-colors ${
                  isActive
                    ? "bg-[color:var(--accent)]/20 text-text-primary"
                    : "text-text-muted hover:text-text-primary"
                }`}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* 탭 콘텐츠 — 서브 패널의 자체 헤더는 숨김(hideHeader) */}
      <div className="flex min-h-0 flex-1">
        {active === "normal_map" && (
          <NormalMapPanel
            generationId={generationId}
            imageUrl={imageUrl}
            width={width}
            height={height}
            hideHeader
            onBusyChange={onGeneratingChange}
            onResult={onNormalMapResult}
            onClose={onClose}
          />
        )}
        {active === "nine_slice" && (
          <NineSliceEditor
            generationId={generationId}
            sessionId={sessionId}
            hideHeader
            onBusyChange={onGeneratingChange}
            onResult={onNineSliceResult}
            onClose={onClose}
          />
        )}
        {active === "button_states" && (
          <ButtonStateEditor
            generationId={generationId}
            sessionId={sessionId}
            hideHeader
            onBusyChange={onGeneratingChange}
            onResult={onButtonStateResult}
            onAddOne={onButtonStateAddOne}
            onClose={onClose}
          />
        )}
      </div>
    </aside>
  );
}
