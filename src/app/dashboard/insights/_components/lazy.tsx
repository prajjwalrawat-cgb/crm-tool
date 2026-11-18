'use client';

import dynamic from 'next/dynamic';

import { Bone } from './ui';

/** Recharts is loaded on demand; skeletons hold the space meanwhile. */
export const Sparkline = dynamic(() => import('./charts').then((m) => m.Sparkline), { ssr: false, loading: () => <Bone className="h-8 w-full" /> });
export const TrendLine = dynamic(() => import('./charts').then((m) => m.TrendLine), { ssr: false, loading: () => <Bone className="h-56 w-full" /> });
export const DailyBars = dynamic(() => import('./charts').then((m) => m.DailyBars), { ssr: false, loading: () => <Bone className="h-48 w-full" /> });
