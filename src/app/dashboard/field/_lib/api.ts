/**
 * Browser-side caller for /api/field/*. Never throws: a dropped connection
 * (common in the field) comes back as `{ ok: false, offline: true }` so the UI
 * can offer a retry instead of a crash.
 */

export type FieldApiError = {
  ok: false;
  status: number;
  offline: boolean;
  error: string;
  code?: string;
  body: Record<string, unknown>;
};
export type FieldApiResult<T> = { ok: true; data: T } | FieldApiError;

const OFFLINE = 'No connection. Check your signal and try again.';

export async function fieldApi<T = unknown>(
  path: string,
  init: { method?: 'POST' | 'PATCH' | 'GET'; body?: unknown; keepalive?: boolean } = {},
): Promise<FieldApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api/field${path}`, {
      method: init.method ?? 'POST',
      headers: init.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
      keepalive: init.keepalive,
    });
  } catch {
    return { ok: false, status: 0, offline: true, error: OFFLINE, body: {} };
  }
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON (proxy error page, etc.): fall through to a generic message.
  }
  if (res.ok) return { ok: true, data: json as T };
  const issues = Array.isArray(json.issues) ? (json.issues as Array<{ message?: string }>) : [];
  const detail = issues.map((i) => i.message).filter(Boolean)[0];
  return {
    ok: false,
    status: res.status,
    offline: false,
    error:
      typeof json.error === 'string'
        ? detail
          ? `${json.error} ${detail}`
          : json.error
        : res.status >= 500
          ? 'Something went wrong. Try again.'
          : `Request failed (${res.status}).`,
    code: typeof json.code === 'string' ? json.code : undefined,
    body: json,
  };
}
