'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * Studio-open tracker. Each chart that opens its Chart Studio
 * registers via `useStudioRegistration(open)`; the count is exposed
 * so other UI (CopilotPanel) can hide while ANY chart is being
 * customized.
 *
 * Historical note: this file briefly hosted a global "Dashboard Edit
 * Mode" toggled by Cmd/Ctrl+Shift+E with drag/resize chrome. That
 * surface was rolled back to last-known-stable; the studio-tracking
 * bits are what survived because the Copilot auto-hide depends on
 * them. If a real layout-editing engine returns, it should live in
 * its own dedicated context — not piggyback on this one.
 */

type ChartStudioContextValue = {
  studioOpenCount: number;
  registerStudioOpen: () => () => void;
  /** True if any chart Studio is currently open. */
  anyEditingActive: boolean;
};

const ChartStudioContext = createContext<ChartStudioContextValue | null>(null);

export function EditModeProvider({ children }: { children: ReactNode }) {
  const [studioOpenCount, setStudioOpenCount] = useState(0);

  const registerStudioOpen = useCallback(() => {
    setStudioOpenCount((n) => n + 1);
    return () => setStudioOpenCount((n) => Math.max(0, n - 1));
  }, []);

  const value: ChartStudioContextValue = {
    studioOpenCount,
    registerStudioOpen,
    anyEditingActive: studioOpenCount > 0,
  };

  return (
    <ChartStudioContext.Provider value={value}>
      {children}
    </ChartStudioContext.Provider>
  );
}

/**
 * Safe getter: returns the inactive default when called outside a
 * provider so legacy callers don't crash.
 */
export function useEditMode(): ChartStudioContextValue {
  const ctx = useContext(ChartStudioContext);
  if (!ctx) {
    return {
      studioOpenCount: 0,
      registerStudioOpen: () => () => {},
      anyEditingActive: false,
    };
  }
  return ctx;
}

/**
 * Hook used by chart studios — call with the panel's open state.
 * Increments the global counter on open, decrements on close /
 * unmount. Drives the CopilotPanel auto-hide.
 */
export function useStudioRegistration(open: boolean): void {
  const { registerStudioOpen } = useEditMode();
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (open) {
      cleanupRef.current = registerStudioOpen();
      return () => {
        cleanupRef.current?.();
        cleanupRef.current = null;
      };
    }
  }, [open, registerStudioOpen]);
}
