"use client";

import { ButtonStateEditor } from "@/components/editor/ButtonStateEditor";

type Props = {
  generationId: string;
  sessionId: string | null;
  onClose: () => void;
  onButtonStateResult: (res: {
    normal: { generationId: string; width: number; height: number };
    hover: { generationId: string; width: number; height: number };
    pressed: { generationId: string; width: number; height: number };
  }) => void;
  onButtonStateAddOne: (res: { generationId: string; width: number; height: number; state: "normal" | "hover" | "pressed" }) => void;
};

export function ImageToolsPanel({ generationId, sessionId, onClose, onButtonStateResult, onButtonStateAddOne }: Props) {
  return (
    <ButtonStateEditor
      generationId={generationId}
      sessionId={sessionId}
      onResult={onButtonStateResult}
      onAddOne={onButtonStateAddOne}
      onClose={onClose}
    />
  );
}
