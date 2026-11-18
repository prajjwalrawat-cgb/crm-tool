'use client';

import { useSyncExternalStore } from 'react';

/**
 * Tiny client store: "can this user place calls right now?" The softphone bar
 * (mounted once in the shell) publishes it after loading its state, so list
 * rows can show a call button only when telephony is set up and the user has
 * a mapped phone — without every list page loading telephony data.
 */
let ready = false;
const listeners = new Set<() => void>();

export function setTelephonyReady(v: boolean): void {
  if (v === ready) return;
  ready = v;
  for (const l of listeners) l();
}

export function useTelephonyReady(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => ready,
    () => false,
  );
}
