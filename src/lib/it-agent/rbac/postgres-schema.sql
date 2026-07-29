-- ============================================================
-- Watson — 021G-3 : RBAC schema (PostgreSQL)
-- ------------------------------------------------------------
-- Constraints do the work wherever a constraint CAN do the work, because a
-- database constraint holds under concurrency and a forgotten application check
-- does not. In particular:
--
--   * a partial UNIQUE index makes two ACTIVE rows for the same principal+role
--     impossible, so "does this person hold this role?" is never ambiguous;
--   * the audit table has no UPDATE/DELETE path in the application and its id is
--     the primary key, so a replayed insert collides instead of duplicating;
--   * a nonce is single-use by construction: consumption is a conditional UPDATE
--     guarded by `consumed_at IS NULL`, so a second confirmation updates 0 rows;
--   * bootstrap uniqueness is enforced by a one-row guard table, so concurrent
--     startup cannot record two bootstraps.
--
-- Object identifiers are TEXT, not UUID: the persistence contract's identifiers
-- are opaque strings (the bootstrap actor is literally 'system:bootstrap'), and
-- the security core -- not the column type -- is what validates a real Entra OID.
--
-- Idempotent: safe to run on every boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS rbac_schema_version (
  version      INTEGER      NOT NULL PRIMARY KEY,
  applied_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rbac_assignment (
  assignment_id           TEXT         NOT NULL PRIMARY KEY,
  principal_object_id     TEXT         NOT NULL,
  role                    TEXT         NOT NULL,
  active                  BOOLEAN      NOT NULL DEFAULT TRUE,
  assignment_source       TEXT         NOT NULL,
  target_display_name     TEXT,
  target_upn              TEXT,
  assigned_by_object_id   TEXT         NOT NULL,
  assigned_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  modified_at             TIMESTAMPTZ  NOT NULL DEFAULT now(),
  modified_by_object_id   TEXT         NOT NULL,
  removed_at              TIMESTAMPTZ,
  removed_by_object_id    TEXT,
  elevated_acknowledged   BOOLEAN,
  version                 INTEGER      NOT NULL DEFAULT 1,
  CONSTRAINT rbac_assignment_role_known CHECK (role IN (
    'watson_employee','watson_technician','watson_support_admin',
    'watson_provisioning_admin','watson_security_admin','watson_role_admin'))
);

-- The uniqueness that matters: at most ONE active row per principal+role.
CREATE UNIQUE INDEX IF NOT EXISTS rbac_assignment_active_uniq
  ON rbac_assignment (principal_object_id, role) WHERE active;

CREATE INDEX IF NOT EXISTS rbac_assignment_principal_idx
  ON rbac_assignment (principal_object_id) WHERE active;
-- Supports the final-administrator lock without scanning the table.
CREATE INDEX IF NOT EXISTS rbac_assignment_admin_idx
  ON rbac_assignment (role) WHERE active AND role = 'watson_role_admin';

CREATE TABLE IF NOT EXISTS rbac_audit (
  audit_id              TEXT         NOT NULL PRIMARY KEY,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  correlation_id        TEXT         NOT NULL,
  actor_object_id       TEXT         NOT NULL,
  actor_upn             TEXT,
  target_object_id      TEXT,
  event_type            TEXT         NOT NULL,
  outcome               TEXT         NOT NULL,
  reason                TEXT         NOT NULL,
  previous_roles        JSONB,
  resulting_roles       JSONB,
  assignment_source     TEXT         NOT NULL,
  elevated_acknowledged BOOLEAN,
  CONSTRAINT rbac_audit_outcome_known CHECK (outcome IN ('success','refused','error'))
);
CREATE INDEX IF NOT EXISTS rbac_audit_target_idx ON rbac_audit (target_object_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rbac_audit_created_idx ON rbac_audit (created_at DESC);

-- Preview nonces. The DIGEST is the key; the raw nonce never reaches the
-- database, so a backup or replica yields nothing usable.
CREATE TABLE IF NOT EXISTS rbac_preview_nonce (
  nonce_digest       TEXT         NOT NULL PRIMARY KEY,
  action             TEXT         NOT NULL,
  actor_object_id    TEXT         NOT NULL,
  target_object_id   TEXT         NOT NULL,
  role               TEXT         NOT NULL,
  state_version      INTEGER      NOT NULL,
  elevated_required  BOOLEAN      NOT NULL DEFAULT FALSE,
  payload            TEXT         NOT NULL,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ  NOT NULL,
  consumed_at        TIMESTAMPTZ,
  CONSTRAINT rbac_nonce_action_known CHECK (action IN ('assign','remove')),
  -- A digest must be exactly a sha256 hex string: nothing shorter can be stored,
  -- so a truncated or raw value is rejected by the database itself.
  CONSTRAINT rbac_nonce_digest_shape CHECK (nonce_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS rbac_nonce_expiry_idx ON rbac_preview_nonce (expires_at);

-- One-row guard: concurrent startup cannot record two bootstraps.
CREATE TABLE IF NOT EXISTS rbac_bootstrap_state (
  singleton          BOOLEAN      NOT NULL PRIMARY KEY DEFAULT TRUE,
  bootstrap_oid      TEXT         NOT NULL,
  completed          BOOLEAN      NOT NULL DEFAULT TRUE,
  completed_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  assignment_source  TEXT         NOT NULL DEFAULT 'bootstrap',
  CONSTRAINT rbac_bootstrap_singleton CHECK (singleton)
);

CREATE TABLE IF NOT EXISTS rbac_migration (
  migration_id   TEXT         NOT NULL PRIMARY KEY,
  source_kind    TEXT         NOT NULL,
  source_checksum TEXT        NOT NULL,
  assignments    INTEGER      NOT NULL,
  audit_rows     INTEGER      NOT NULL,
  applied_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO rbac_schema_version (version) VALUES (1) ON CONFLICT DO NOTHING;
