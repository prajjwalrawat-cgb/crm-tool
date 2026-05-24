'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Dashboard Edit Mode — global on/off toggle exposed via React
 * context. The provider lives at the dashboard layout level so every
 * widget on the page can read the same flag and adapt its chrome
 * (drag-handle affordance, delete/duplicate buttons, grid overlay).
 *
 * Activation:
 *   - Cmd/Ctrl + Shift + E    toggle from anywhere on the page
 *   - Escape                  exits when active
 *   - Click the X on the
 *     bottom-right pill       exits when active
 *
 * Why not URL-state: we deliberately avoid persisting "I'm in edit
 * mode" across reloads. It's a transient, intentional mode — a fresh
 * dashboard load should always start in view mode so users don't
 * accidentally see drag handles after closing and reopening the tab.
 *
 * Why not server-state: same reason. Plus, edit mode is per-tab
 * (you might be reading on one tab and editing on another).
 */

type EditModeContextValue = {
  editMode: boolean;
  toggle: () => void;
  enter: () => void;
  exit: () => void;
};

const EditModeContext = createContext<EditModeContextValue | null>(null);

export function EditModeProvider({ children }: { children: ReactNode }) {
  const [editMode, setEditMode] = useState(false);

  // Cmd/Ctrl + Shift + E toggles globally. We capture at the window
  // level (not inside any chart-frame) because edit mode is
  // page-scoped, not chart-scoped.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Toggle: Cmd/Ctrl + Shift + E
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        (e.key === 'e' || e.key === 'E')
      ) {
        const target = e.target as HTMLElement | null;
        if (target?.isContentEditable) return;
        if (
          target &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.tagName === 'SELECT')
        ) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        setEditMode((prev) => !prev);
        return;
      }
      // Escape exits when active.
      if (e.key === 'Escape' && editMode) {
        // Don't steal Escape if a dialog/modal is also listening —
        // only handle when no other interactive element is focused
        // inside an input-like target.
        const target = e.target as HTMLElement | null;
        if (
          target?.isContentEditable ||
          target?.tagName === 'INPUT' ||
          target?.tagName === 'TEXTAREA'
        ) {
          return;
        }
        setEditMode(false);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [editMode]);

  const value: EditModeContextValue = {
    editMode,
    toggle: () => setEditMode((prev) => !prev),
    enter: () => setEditMode(true),
    exit: () => setEditMode(false),
  };

  return (
    <EditModeContext.Provider value={value}>
      {children}
    </EditModeContext.Provider>
  );
}

/**
 * Safe getter: returns the view-mode default when called outside an
 * EditModeProvider so legacy callers don't crash. Edit mode is
 * additive — the rest of the app continues to work without it.
 */
export function useEditMode(): EditModeContextValue {
  const ctx = useContext(EditModeContext);
  if (!ctx) {
    return {
      editMode: false,
      toggle: () => {},
      enter: () => {},
      exit: () => {},
    };
  }
  return ctx;
}
