// ============================================================
// Watson — H&R AI IT Agent : Data Store
// ------------------------------------------------------------
// Local-dev persistence layer. In-memory collections with
// optional JSON-file persistence. Repository pattern keeps the
// rest of the app decoupled from storage, so this can later be
// swapped for Azure Postgres / Azure SQL without touching
// domain logic. NO native DB drivers => runs anywhere.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import type {
  Ticket,
  TicketMessage,
  TicketEvent,
  ApprovalRequest,
  AuditLog,
  KnowledgeArticle,
  MockM365User,
  MockDevice
} from '../it-agent/types';
import type { WatsonCase } from '../it-agent/watson/cases';

export interface DbShape {
  tickets: Ticket[];
  ticketMessages: TicketMessage[];
  ticketEvents: TicketEvent[];
  approvals: ApprovalRequest[];
  auditLogs: AuditLog[];
  knowledge: KnowledgeArticle[];
  mockUsers: MockM365User[];
  mockDevices: MockDevice[];
  cases: WatsonCase[];
  counters: Record<string, number>;
}

function emptyDb(): DbShape {
  return {
    tickets: [],
    ticketMessages: [],
    ticketEvents: [],
    approvals: [],
    auditLogs: [],
    knowledge: [],
    mockUsers: [],
    mockDevices: [],
    cases: [],
    counters: { ticket: 1000, approval: 1000, audit: 1 }
  };
}

// Data directory is configurable so production can point at a WRITABLE, PERSISTENT
// path (e.g. Azure App Service /home) even when the app bundle itself is a
// read-only run-from-package mount. Defaults to <cwd>/data for local dev.
//
// 021C-1A: these are read PER CALL, never snapshotted into a module-level const.
// ES module imports are hoisted and evaluated BEFORE any statement in the
// importing module's body, so a harness that does
//     process.env.IT_AGENT_PERSIST = 'off';
//     import { ... } from '../src/lib/store/db';
// had this module already evaluated — and the snapshot said "persist". The
// self-test suite therefore wrote its synthetic fixtures, INCLUDING ACTIVE
// watson_role_admin ASSIGNMENTS, into the real local dev store, which then made
// RBAC bootstrap a permanent no-op for every subsequent local run. Reading the
// environment at the point of use removes the ordering hazard entirely.
function dataDir(): string {
  const configured = process.env.WATSON_DATA_DIR?.trim();
  return configured ? configured : path.join(process.cwd(), 'data');
}
function dataFile(): string {
  return path.join(dataDir(), 'watson-store.json');
}

// Persistence is disabled in test/selftest to keep runs hermetic.
function persistEnabled(): boolean {
  return process.env.IT_AGENT_PERSIST !== 'off';
}

// Global singleton so one process shares one store. `__watsonDbMtime` tracks the
// file version this process has loaded, so a store written by another
// process/restart (newer file) is reloaded on the next access — giving correct
// cross-request state without a database. Our own writes update the mtime, so
// they never trigger a mid-request reload (references stay stable within a request).
const g = globalThis as unknown as { __watsonDb?: DbShape; __watsonSeeded?: boolean; __watsonDbMtime?: number };

function readFromFile(): DbShape | null {
  try {
    const file = dataFile();
    if (fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf-8');
      return { ...emptyDb(), ...(JSON.parse(raw) as DbShape) };
    }
  } catch {
    // Corrupt store should not crash the app.
  }
  return null;
}

function load(): DbShape {
  if (!persistEnabled()) {
    if (!g.__watsonDb) g.__watsonDb = emptyDb();
    return g.__watsonDb;
  }
  try {
    const file = dataFile();
    const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    if (!g.__watsonDb || mtime > (g.__watsonDbMtime ?? -1)) {
      g.__watsonDb = readFromFile() ?? g.__watsonDb ?? emptyDb();
      g.__watsonDbMtime = mtime;
    }
  } catch {
    if (!g.__watsonDb) g.__watsonDb = emptyDb();
  }
  return g.__watsonDb;
}

function persist(): void {
  if (!persistEnabled()) return;
  // Write immediately (durable before the response returns) and record the new
  // file mtime as our own so load() does not treat it as a foreign change.
  try {
    const dir = dataDir();
    const file = dataFile();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(g.__watsonDb, null, 2), 'utf-8');
    g.__watsonDbMtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : Date.now();
  } catch {
    // best-effort
  }
}

// Test/diagnostic seam: the resolved store path and whether writes are enabled.
// Reports posture only — never store contents.
export function storagePosture(): { persistEnabled: boolean; dataFile: string } {
  return { persistEnabled: persistEnabled(), dataFile: dataFile() };
}

export function db(): DbShape {
  return load();
}

export function save(): void {
  persist();
}

export function nextId(kind: string): number {
  const d = load();
  d.counters[kind] = (d.counters[kind] ?? 0) + 1;
  return d.counters[kind];
}

export function uuid(): string {
  // Stable, dependency-free unique id.
  return 'x' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function nowIso(): string {
  return new Date().toISOString();
}

// Test helper: wipe everything (used by selftest with a temp store).
export function __resetDbForTests(): void {
  g.__watsonDb = emptyDb();
  g.__watsonSeeded = false;
}

export function isSeeded(): boolean {
  return Boolean(g.__watsonSeeded);
}

export function markSeeded(): void {
  g.__watsonSeeded = true;
}
