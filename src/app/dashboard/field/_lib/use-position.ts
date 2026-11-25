'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { geolocate, isLowAccuracy, type GeoPosition } from './geolocate';

export type PositionState =
  | { kind: 'idle' }
  | { kind: 'locating' }
  | { kind: 'low'; pos: GeoPosition }
  | { kind: 'error'; message: string };

/**
 * One-shot location read with the low-accuracy gate. `locate()` calls
 * `onReady` with a good fix; a fix worse than 100 m waits in `low` until the
 * rep picks Retry (`locate()` again) or Continue (`accept()`).
 */
export function usePosition(onReady: (pos: GeoPosition) => void) {
  const [state, setState] = useState<PositionState>({ kind: 'idle' });
  const ready = useRef(onReady);
  useEffect(() => {
    ready.current = onReady;
  }, [onReady]);
  const seq = useRef(0);

  const locate = useCallback(async () => {
    const mine = ++seq.current;
    setState({ kind: 'locating' });
    try {
      const pos = await geolocate();
      if (mine !== seq.current) return;
      if (isLowAccuracy(pos.accuracyM)) {
        setState({ kind: 'low', pos });
        return;
      }
      setState({ kind: 'idle' });
      ready.current(pos);
    } catch (e) {
      if (mine !== seq.current) return;
      setState({ kind: 'error', message: e instanceof Error ? e.message : 'Could not get your location.' });
    }
  }, []);

  const accept = useCallback(() => {
    if (state.kind !== 'low') return;
    const { pos } = state;
    setState({ kind: 'idle' });
    ready.current(pos);
  }, [state]);

  const reset = useCallback(() => {
    seq.current++;
    setState({ kind: 'idle' });
  }, []);

  return { state, locate, accept, reset };
}
