'use client';

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function api<T = unknown>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store'
    });
    const json = await res.json().catch(() => ({ ok: false, error: 'Invalid response' }));
    return json as ApiResult<T>;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Network error' };
  }
}

export function getCookieRole(): string {
  if (typeof document === 'undefined') return 'employee';
  const m = document.cookie.match(/(?:^|;\s*)watson_role=([^;]+)/);
  return m?.[1] ?? 'employee';
}

export async function setRole(role: string) {
  await api('/api/it-agent/session', { method: 'POST', body: JSON.stringify({ role }) });
}
