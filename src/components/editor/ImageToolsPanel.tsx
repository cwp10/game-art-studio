"use client";

import { Gamepad2, Layers, Scissors } from "lucide-react";
import { useState } from "react";
import { ButtonStateEditor } from "@/components/editor/ButtonStateEditor";
import { NineSliceEditor } from "@/components/editor/NineSliceEditor";
import { NormalMapPanel } from "@/components/editor/NormalMapPanel";

/**
 * ImageToolsPanel — 노멀맵 / 9-Slice / 버튼 상태 세 도구를 하나의 탭 컨테이너로 통합.
 *
 * 각 탭은 기존 편집기 컴포넌트를 그대로 재사용한다(개별 헤더·뒤로 버튼 포함).
 * kind 에 따라 의미 없는 탭은 숨기고, 활성 탭만 마운트한다(이미지 중복 fetch 회피).
 */

type Tab = "normal_map" | "nine_slice" | "button_states";

type Props = {
  generationId: string;
  imageUrl: string;
  width: number;
  height: number;
  kind?: string;
  sessionId: string | null;
  onClose: () => void;
  onNormalMapResult: (res: { generationId: string; width: number; height: number }) => void;
  onNineSliceResult: (res: { generationId: string; width: number; height: number; kind: string }) => void;
  onButtonStateResult: (res: {
    normal: { generationId: string; width: number; height: number };
    hover: { generationId: string; width: number; height: number };
    pressed: { generationId: string; width: number; height: number };
  }) => void;
  onButtonStateAddOne: (res: { generationId: string; width: number; height: number; state: "normal" | "hover" | "pressed" }) => void;
};

const TAB_META: Array<{ id: Tab; label: string; icon: typeof Layers; hideFor: string[] }> = [
  { id: "normal_map", label: "노멀맵", icon: Layers, hideFor: ["normal_map", "mask", "layer"] },
  { id: "nine_slice", label: "9-Slice", icon: Scissors, hideFor: ["spritesheet", "composite", "nine_slice", "nine_slice_scaled", "nine_slice_trimmed"] },
  { id: "button_states", label: "버튼 상태", icon: Gamepad2, hideFor: ["spritesheet", "composite", "nine_slice", "nine_slice_scaled", "nine_slice_trimmed", "button_state"] },
];

export function ImageToolsPanel({
  generationId,
  imageUrl,
  width,
  height,
  kind,
  sessionId,
  onClose,
  onNormalMapResult,
  onNineSliceResult,
  onButtonStateResult,
  onButtonStateAddOne,
}: Props) {
  const tabs = TAB_META.filter(t => !t.hideFor.includes(kind ?? ""));
  const [active, setActive] = useState<Tab>(tabs[0].id);

  return (
    <div className="flex h-full w-full flex-col bg-bg-panel">
      {/* 탭 바 — 사용 가능한 도구만. 각 탭 콘텐츠(편집기)는 자체 헤더·뒤로 버튼을 가진다. */}
      <div className="flex flex-none items-center gap-1 border-b border-border px-3.5 py-2">
        {tabs.map(t => {
          const Icon = t.icon;
          const isActive = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm ${
                isActive
                  ? "bg-[color:var(--accent)]/10 text-[color:var(--accent)]"
                  : "text-text-muted hover:bg-bg-card hover:text-text-primary"
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      <div className="flex min-h-0 flex-1">
        {active === "normal_map" && (
          <NormalMapPanel
            generationId={generationId}
            imageUrl={imageUrl}
            width={width}
            height={height}
            onResult={onNormalMapResult}
            onClose={onClose}
          />
        )}
        {active === "nine_slice" && (
          <NineSliceEditor
            generationId={generationId}
            sessionId={sessionId}
            onResult={onNineSliceResult}
            onClose={onClose}
          />
        )}
        {active === "button_states" && (
          <ButtonStateEditor
            generationId={generationId}
            sessionId={sessionId}
            onResult={onButtonStateResult}
            onAddOne={onButtonStateAddOne}
            onClose={onClose}
          />
        )}
      </div>
    </div>
  );
}
