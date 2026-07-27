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
const DATA_DIR = (process.env.WATSON_DATA_DIR && process.env.WATSON_DATA_DIR.trim())
  ? process.env.WATSON_DATA_DIR.trim()
  : path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'watson-store.json');

// Persistence is disabled in test/selftest to keep runs hermetic.
const PERSIST = process.env.IT_AGENT_PERSIST !== 'off';

// Global singleton so one process shares one store. `__watsonDbMtime` tracks the
// file version this process has loaded, so a store written by another
// process/restart (newer file) is reloaded on the next access — giving correct
// cross-request state without a database. Our own writes update the mtime, so
// they never trigger a mid-request reload (references stay stable within a request).
const g = globalThis as unknown as { __watsonDb?: DbShape; __watsonSeeded?: boolean; __watsonDbMtime?: number };

function readFromFile(): DbShape | null {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf-8');
      return { ...emptyDb(), ...(JSON.parse(raw) as DbShape) };
    }
  } catch {
    // Corrupt store should not crash the app.
  }
  return null;
}

function load(): DbShape {
  if (!PERSIST) {
    if (!g.__watsonDb) g.__watsonDb = emptyDb();
    return g.__watsonDb;
  }
  try {
    const mtime = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtimeMs : 0;
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
  if (!PERSIST) return;
  // Write immediately (durable before the response returns) and record the new
  // file mtime as our own so load() does not treat it as a foreign change.
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(g.__watsonDb, null, 2), 'utf-8');
    g.__watsonDbMtime = fs.existsSync(DATA_FILE) ? fs.statSync(DATA_FILE).mtimeMs : Date.now();
  } catch {
    // best-effort
  }
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
