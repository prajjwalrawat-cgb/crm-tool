'use client';

import Link from 'next/link';
import type { ComponentProps } from 'react';
import { useState } from 'react';

/**
 * A `<Link>` that defers prefetching until the user shows intent
 * (hover, touch, or keyboard focus) instead of prefetching as soon as
 * it enters the viewport.
 *
 * Why this exists: automatic prefetch runs *only in production* (see
 * `node_modules/next/dist/docs/01-app/02-guides/prefetching.md`), which
 * is why the app feels fine in `next dev` and slow when deployed. The
 * dashboard sidebar renders 19-23 nav links, all in the viewport on
 * every page, and the deals table renders one link per row. On load the
 * router fires an `?_rsc=` request for each of them at once. Every one
 * of those is a real server render that re-enters the dashboard layout
 * and its queries, and each RLS-scoped query costs four network round
 * trips to Postgres (BEGIN + app_set_ctx + query + COMMIT). The result
 * is dozens of concurrent renders contending for a 10-connection pool
 * while the page the user actually asked for is still streaming — the
 * page's own data lands late, which the browser reports as a long
 * "Content Download" even though almost nothing is being downloaded.
 *
 * Deferring to intent keeps navigation instant for the link the user is
 * about to click (the prefetch fires on hover, well before mousedown)
 * while removing the fan-out. `prefetch={null}` is the documented way
 * to restore default behavior once intent is shown; `false` means "do
 * not prefetch on viewport entry".
 *
 * Behavior is otherwise identical to `<Link>` — same props, same
 * navigation, same markup.
 */
type PrefetchProp = ComponentProps<typeof Link>['prefetch'];

/**
 * The prefetch decision, extracted so it can be asserted directly
 * (see `scripts/selftest-prefetch.ts`).
 *
 *   `false` — do not prefetch on viewport entry (the whole point)
 *   `null`  — restore Next's default prefetch, now that intent is shown
 *
 * An explicit `prefetch` from the caller always wins: this component
 * changes the *default*, it does not override a deliberate choice.
 */
export function resolvePrefetch(
  explicit: PrefetchProp | undefined,
  intent: boolean,
): PrefetchProp {
  if (explicit !== undefined) return explicit;
  return intent ? null : false;
}

export function HoverPrefetchLink({
  prefetch,
  onMouseEnter,
  onTouchStart,
  onFocus,
  ...rest
}: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  const effective = resolvePrefetch(prefetch, intent);

  return (
    <Link
      {...rest}
      prefetch={effective}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
      onFocus={(e) => {
        setIntent(true);
        onFocus?.(e);
      }}
    />
  );
}
