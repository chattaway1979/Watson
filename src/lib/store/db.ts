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

export interface DbShape {
  tickets: Ticket[];
  ticketMessages: TicketMessage[];
  ticketEvents: TicketEvent[];
  approvals: ApprovalRequest[];
  auditLogs: AuditLog[];
  knowledge: KnowledgeArticle[];
  mockUsers: MockM365User[];
  mockDevices: MockDevice[];
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
    counters: { ticket: 1000, approval: 1000, audit: 1 }
  };
}

const DATA_DIR = path.join(process.cwd(), 'data');
const DATA_FILE = path.join(DATA_DIR, 'watson-store.json');

// Persistence is disabled in test/selftest to keep runs hermetic.
const PERSIST = process.env.IT_AGENT_PERSIST !== 'off';

// Use a global singleton so Next.js dev hot-reload does not create
// multiple disconnected stores within one process.
const g = globalThis as unknown as { __watsonDb?: DbShape; __watsonSeeded?: boolean };

function load(): DbShape {
  if (g.__watsonDb) return g.__watsonDb;
  let db = emptyDb();
  if (PERSIST) {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        db = { ...emptyDb(), ...(JSON.parse(raw) as DbShape) };
      }
    } catch {
      // Fail safe: corrupt store should not crash the app. Start fresh.
      db = emptyDb();
    }
  }
  g.__watsonDb = db;
  return db;
}

let writeTimer: NodeJS.Timeout | null = null;
function persist(): void {
  if (!PERSIST) return;
  if (writeTimer) clearTimeout(writeTimer);
  // Debounce writes; data integrity here is best-effort dev convenience.
  writeTimer = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(g.__watsonDb, null, 2), 'utf-8');
    } catch {
      // best-effort
    }
  }, 25);
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
