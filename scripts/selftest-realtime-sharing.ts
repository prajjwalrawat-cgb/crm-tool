/**
 * Unit self-test for SSE connection sharing. No DB, no network.
 *   pnpm tsx scripts/selftest-realtime-sharing.ts
 *
 * Guards the invariant that a tab opens ONE EventSource per tenant no
 * matter how many components subscribe.
 *
 * Why this is worth a test: each SSE stream is a long-lived server
 * invocation. On Vercel's Fluid compute the function instance stays
 * provisioned for the entire life of the response, so the connection count
 * is a direct multiplier on provisioned-memory GB-hours, on Postgres LISTEN
 * registrations, and on presence broadcast volume. The regression is
 * completely invisible locally — everything still works, it just quietly
 * costs N times as much — so only an assertion catches it.
 *
 * The globals are stubbed before importing the module under test, because
 * the registry reads `document` when the first subscriber attaches.
 */

// `export {}` gives this file module scope. Without it TypeScript treats a
// script with no top-level import/export as a global, and its `const`s
// collide with the other selftest scripts in the same tsconfig include.
export {};

/* ------------------------- stubbed browser env ------------------------- */

let created = 0;
// Not `closed` — that shadows the DOM `window.closed` global (a boolean),
// which makes every numeric comparison below a type error.
let closedCount = 0;
const openSources: FakeEventSource[] = [];

class FakeEventSource {
  static readonly CLOSED = 2;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 1;
  constructor(public url: string) {
    created++;
    openSources.push(this);
  }
  close(): void {
    closedCount++;
    this.readyState = FakeEventSource.CLOSED;
    const i = openSources.indexOf(this);
    if (i >= 0) openSources.splice(i, 1);
  }
}

const g = globalThis as unknown as Record<string, unknown>;
g.EventSource = FakeEventSource;
g.document = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
};

/* --------------------------- test harness ----------------------------- */

let exitCode = 0;
const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  if (!ok) exitCode = 1;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Push an envelope through the single live connection. */
function emit(tenantId: string, id: string, type = 'deal.updated'): void {
  const payload = JSON.stringify({
    id,
    emittedAt: new Date().toISOString(),
    event: { type, tenantId },
  });
  for (const s of openSources) s.onmessage?.({ data: payload });
}

async function main(): Promise<void> {
  const { subscribeToRealtimeChannel } = await import(
    '../src/hooks/use-realtime-events'
  );

  const TENANT = 'tenant-a';

  /* 1. Many subscribers, one connection ------------------------------- */
  const seen = [0, 0, 0, 0, 0, 0];
  const unsubs = seen.map((_, i) =>
    subscribeToRealtimeChannel(TENANT, () => {
      seen[i]!++;
    }),
  );

  check(
    '6 subscribers open exactly 1 EventSource',
    created === 1,
    `created=${created}`,
  );

  /* 2. Every subscriber receives every event -------------------------- */
  emit(TENANT, 'evt-1');
  check(
    'one envelope reaches all 6 subscribers exactly once',
    seen.every((n) => n === 1),
    `counts=${seen.join(',')}`,
  );

  /* 3. Dedup is central, not per-subscriber --------------------------- */
  emit(TENANT, 'evt-1');
  check(
    'a replayed envelope id is dropped for everyone',
    seen.every((n) => n === 1),
    `counts=${seen.join(',')}`,
  );

  emit(TENANT, 'evt-2');
  check(
    'a fresh envelope still fans out',
    seen.every((n) => n === 2),
    `counts=${seen.join(',')}`,
  );

  /* 4. Cross-tenant envelopes are dropped ----------------------------- */
  const before = seen[0]!;
  const foreign = JSON.stringify({
    id: 'evt-foreign',
    emittedAt: new Date().toISOString(),
    event: { type: 'deal.updated', tenantId: 'tenant-b' },
  });
  for (const s of openSources) s.onmessage?.({ data: foreign });
  check(
    "an envelope for another tenant is not delivered",
    seen[0] === before,
    `count=${seen[0]}`,
  );

  /* 5. A throwing subscriber does not starve the others --------------- */
  let afterThrower = 0;
  const unsubThrower = subscribeToRealtimeChannel(TENANT, () => {
    throw new Error('subscriber boom');
  });
  const unsubTail = subscribeToRealtimeChannel(TENANT, () => {
    afterThrower++;
  });
  emit(TENANT, 'evt-3');
  check(
    'a throwing subscriber does not block later subscribers',
    afterThrower === 1,
    `count=${afterThrower}`,
  );
  unsubThrower();
  unsubTail();

  /* 6. Connection survives while any subscriber remains --------------- */
  for (const u of unsubs.slice(1)) u();
  check(
    'connection stays open while 1 of 6 subscribers remains',
    closedCount === 0 && openSources.length === 1,
    `closed=${closedCount} open=${openSources.length}`,
  );

  /* 7. Navigation reuses the connection instead of cycling it --------- */
  unsubs[0]!(); // last subscriber leaves — teardown is now pending
  const revive = subscribeToRealtimeChannel(TENANT, () => {});
  await sleep(3_400); // outlive LINGER_MS (3s)
  check(
    'resubscribing during the linger window reuses the connection',
    created === 1 && closedCount === 0,
    `created=${created} closed=${closedCount}`,
  );

  /* 8. Genuine teardown does close it --------------------------------- */
  revive();
  await sleep(3_400);
  check(
    'the connection closes once the last subscriber is really gone',
    closedCount === 1 && openSources.length === 0,
    `closed=${closedCount} open=${openSources.length}`,
  );

  /* 9. A later mount opens a fresh connection ------------------------- */
  const again = subscribeToRealtimeChannel(TENANT, () => {});
  check(
    'subscribing after teardown opens a new connection',
    created === 2,
    `created=${created}`,
  );
  again();
  await sleep(3_400);

  /* ----------------------------- report ------------------------------ */
  for (const r of results) {
    const detail = r.detail ? `  (${r.detail})` : '';
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${detail}`);
  }
  const passed = results.filter((r) => r.ok).length;
  console.log(`${passed}/${results.length} passed.`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
