"use client";

import { createContext, useContext } from "react";
import type { ReactNode } from "react";

type OrchestratorCtx = {
  isCodex: boolean;
  toggleOrchestrator: () => void;
};

const OrchestratorContext = createContext<OrchestratorCtx>({
  isCodex: false,
  toggleOrchestrator: () => {},
});

export function OrchestratorProvider({
  isCodex,
  toggleOrchestrator,
  children,
}: {
  isCodex: boolean;
  toggleOrchestrator: () => void;
  children: ReactNode;
}) {
  return (
    <OrchestratorContext.Provider value={{ isCodex, toggleOrchestrator }}>
      {children}
    </OrchestratorContext.Provider>
  );
}

export function useIsCodex(): boolean {
  return useContext(OrchestratorContext).isCodex;
}

export function useOrchestratorContext(): OrchestratorCtx {
  return useContext(OrchestratorContext);
}
