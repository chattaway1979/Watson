import { NextResponse } from 'next/server';

export function ok(data: unknown, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data }, init);
}
export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false, error: message, ...extra }, { status });
}
export function handle(fn: () => unknown) {
  try {
    return ok(fn());
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unexpected error';
    return fail(msg, 400);
  }
}
