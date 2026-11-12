'use client';

import { useEffect } from 'react';

// After a new deploy, Server Actions get new IDs. A tab that was opened
// before the deploy still calls the old IDs and Next.js throws
// "Server Action ... was not found on the server". A full page reload
// fetches the new build and fixes it.

const RELOAD_KEY = 'stale-deployment-reloaded-at';
// Don't reload again within this window, so a real server problem with the
// same message can't trap the user in a reload loop.
const RELOAD_COOLDOWN_MS = 60_000;

export function isStaleDeploymentError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return (
    message.includes('failed-to-find-server-action') ||
    (message.includes('Server Action') && message.includes('was not found on the server'))
  );
}

/** Reloads the page once if `error` comes from an outdated deployment. Returns true if it reloaded. */
export function reloadIfStaleDeployment(error: unknown): boolean {
  if (typeof window === 'undefined' || !isStaleDeploymentError(error)) return false;

  try {
    const last = Number(window.sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    // sessionStorage blocked: still reload; worst case the user sees the error after.
  }

  window.location.reload();
  return true;
}

/** For error.tsx boundaries: reloads the page if the error is from an outdated deployment. */
export function useReloadOnStaleDeployment(error: unknown) {
  useEffect(() => {
    reloadIfStaleDeployment(error);
  }, [error]);
}

/** Mount once near the root: catches the error when it comes from an action no boundary sees (e.g. a button click). */
export function StaleDeploymentListener() {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      reloadIfStaleDeployment(event.reason);
    };
    const onError = (event: ErrorEvent) => {
      reloadIfStaleDeployment(event.error ?? event.message);
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, []);
  return null;
}
