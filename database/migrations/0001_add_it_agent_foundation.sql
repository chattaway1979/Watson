-- ============================================================
-- Watson — H&R AI IT Agent : Foundation schema (ADDITIVE)
-- Target: PostgreSQL (Azure Database for PostgreSQL) / Azure SQL-compatible.
-- ------------------------------------------------------------
-- SAFETY: This migration is ADDITIVE ONLY. It creates new tables
-- under the it_* namespace. It does NOT alter or drop any existing
-- table or column. It is NOT applied automatically by this build —
-- the local MVP uses a JSON file store. Apply only in a controlled
-- environment with explicit authorization.
-- ============================================================

CREATE TABLE IF NOT EXISTS it_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'employee',  -- employee|manager|admin|owner
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS it_tickets (
  id                  TEXT PRIMARY KEY,
  short_id            TEXT NOT NULL UNIQUE,
  subject             TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  category            TEXT NOT NULL,           -- see app TICKET_CATEGORIES
  status              TEXT NOT NULL DEFAULT 'open',
  priority            TEXT NOT NULL DEFAULT 'normal',
  requester_id        TEXT NOT NULL,
  requester_email     TEXT NOT NULL,
  requester_name      TEXT,
  assignee_id         TEXT,
  assignee_name       TEXT,
  ai_diagnosis        JSONB,
  recommended_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  linked_approval_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags                JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  triaged_at          TIMESTAMPTZ,
  resolved_at         TIMESTAMPTZ,
  closed_at           TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_it_tickets_status   ON it_tickets(status);
CREATE INDEX IF NOT EXISTS idx_it_tickets_category ON it_tickets(category);
CREATE INDEX IF NOT EXISTS idx_it_tickets_requester ON it_tickets(requester_id);

CREATE TABLE IF NOT EXISTS it_ticket_messages (
  id           TEXT PRIMARY KEY,
  ticket_id    TEXT NOT NULL REFERENCES it_tickets(id) ON DELETE CASCADE,
  author_type  TEXT NOT NULL,    -- user|admin|agent|system
  author_id    TEXT NOT NULL,
  author_name  TEXT,
  body         TEXT NOT NULL,
  internal     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_it_ticket_messages_ticket ON it_ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS it_ticket_events (
  id          TEXT PRIMARY KEY,
  ticket_id   TEXT NOT NULL REFERENCES it_tickets(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  actor_type  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  data        JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_it_ticket_events_ticket ON it_ticket_events(ticket_id);

-- Registry is code-owned; this table optionally mirrors it for reporting.
CREATE TABLE IF NOT EXISTS it_agent_actions (
  key              TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  category         TEXT NOT NULL,
  description      TEXT,
  risk_level       TEXT NOT NULL,         -- low|medium|high|critical
  required_role    TEXT NOT NULL,
  requires_approval BOOLEAN NOT NULL,
  mock_executable  BOOLEAN NOT NULL,
  live_executable  BOOLEAN NOT NULL DEFAULT false,  -- MUST stay false in this build
  exec_mode        TEXT NOT NULL,
  connector_target TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS it_action_approvals (
  id                 TEXT PRIMARY KEY,
  short_id           TEXT NOT NULL UNIQUE,
  action_key         TEXT NOT NULL,
  action_display_name TEXT NOT NULL,
  risk_level         TEXT NOT NULL,
  ticket_id          TEXT REFERENCES it_tickets(id) ON DELETE SET NULL,
  requested_by_type  TEXT NOT NULL,
  requested_by_id    TEXT NOT NULL,
  requested_by_name  TEXT,
  target_type        TEXT NOT NULL,
  target_id          TEXT NOT NULL,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  status             TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|cancelled
  decided_by_type    TEXT,
  decided_by_id      TEXT,
  decided_by_name    TEXT,
  decision_note      TEXT,
  mock_executed      BOOLEAN NOT NULL DEFAULT false,
  mock_result        JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_it_action_approvals_status ON it_action_approvals(status);

CREATE TABLE IF NOT EXISTS it_audit_logs (
  id           TEXT PRIMARY KEY,
  actor_type   TEXT NOT NULL,            -- user|admin|agent|system
  actor_id     TEXT NOT NULL,
  action       TEXT NOT NULL,
  target_type  TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  before_state JSONB,
  after_state  JSONB,
  metadata     JSONB,
  ip           TEXT,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_it_audit_logs_action ON it_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_it_audit_logs_target ON it_audit_logs(target_type, target_id);

CREATE TABLE IF NOT EXISTS it_knowledge_articles (
  id          TEXT PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  category    TEXT NOT NULL,
  summary     TEXT NOT NULL,
  body        TEXT NOT NULL,
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
  visibility  TEXT NOT NULL DEFAULT 'public', -- public|internal
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mock connector data (development/test only; real data comes from Graph/RMM later).
CREATE TABLE IF NOT EXISTS it_mock_users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  job_title      TEXT,
  department     TEXT,
  account_enabled BOOLEAN NOT NULL DEFAULT true,
  licenses       JSONB NOT NULL DEFAULT '[]'::jsonb,
  mfa_enabled    BOOLEAN NOT NULL DEFAULT false,
  mfa_methods    JSONB NOT NULL DEFAULT '[]'::jsonb,
  mailbox_type   TEXT NOT NULL DEFAULT 'user',
  mailbox_size_gb NUMERIC,
  mailbox_quota_gb NUMERIC,
  groups         JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_sign_in   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS it_mock_devices (
  id             TEXT PRIMARY KEY,
  owner_email    TEXT NOT NULL,
  device_name    TEXT NOT NULL,
  os             TEXT,
  os_version     TEXT,
  serial_number  TEXT,
  last_check_in  TIMESTAMPTZ,
  disk_free_gb   NUMERIC,
  disk_total_gb  NUMERIC,
  antivirus_status TEXT,
  patch_status   TEXT,
  compliance_status TEXT,
  remote_support_available BOOLEAN NOT NULL DEFAULT false,
  managed_by     TEXT NOT NULL DEFAULT 'unmanaged'
);

-- ============================================================
-- DOWN (manual, controlled rollback — NOT auto-run)
-- DROP TABLE IF EXISTS it_mock_devices, it_mock_users, it_knowledge_articles,
--   it_audit_logs, it_action_approvals, it_agent_actions,
--   it_ticket_events, it_ticket_messages, it_tickets, it_users CASCADE;
-- ============================================================
