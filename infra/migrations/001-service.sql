CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE IF NOT EXISTS private.migrations (version integer PRIMARY KEY);
CREATE TABLE IF NOT EXISTS private.members (
 id uuid PRIMARY KEY, email_hash text UNIQUE NOT NULL, active boolean NOT NULL DEFAULT true,
 role text NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.invites (
 token_hash text PRIMARY KEY, email_hash text NOT NULL, expires_at timestamptz NOT NULL,
 accepted_by uuid REFERENCES private.members(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.sessions (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.games (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id), revision integer NOT NULL DEFAULT 0,
 snapshot_key text, snapshot_hash text, summary jsonb NOT NULL DEFAULT '{}',
 active_job uuid, client_epoch integer NOT NULL DEFAULT 0, client_id text,
 deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(octet_length(summary::text) <= 8192)
);
CREATE TABLE IF NOT EXISTS private.jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id), game_id uuid NOT NULL REFERENCES private.games(id),
 request_key text NOT NULL, payload_hash text NOT NULL, path text NOT NULL, method text NOT NULL,
 payload jsonb NOT NULL, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','expired','dead')),
 base_revision integer NOT NULL, client_epoch integer NOT NULL, attempt integer NOT NULL DEFAULT 0,
 lease_until timestamptz, deadline timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 result_key text, error text, next_seq integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,request_key), CHECK(octet_length(payload::text) <= 262144)
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_game ON private.jobs(game_id) WHERE status IN ('queued','running');
CREATE UNIQUE INDEX IF NOT EXISTS one_active_owner ON private.jobs(owner_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS private.outbox (
 job_id uuid PRIMARY KEY REFERENCES private.jobs(id), generation integer NOT NULL DEFAULT 0,
 sent_at timestamptz, next_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.events (
 job_id uuid NOT NULL REFERENCES private.jobs(id), seq integer NOT NULL, attempt integer NOT NULL,
 body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(job_id,seq),
 CHECK(octet_length(body::text) <= 16384)
);
CREATE TABLE IF NOT EXISTS private.objects (
 key text PRIMARY KEY, game_id uuid REFERENCES private.games(id), checksum text NOT NULL,
 state text NOT NULL DEFAULT 'uploading' CHECK(state IN ('uploading','committed')), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.feedback (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id), game_id uuid REFERENCES private.games(id),
 job_id uuid REFERENCES private.jobs(id), category text NOT NULL, message text NOT NULL,
 game_version text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), CHECK(length(message) BETWEEN 1 AND 4000)
);
CREATE TABLE IF NOT EXISTS private.analytics (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id), name text NOT NULL,
 game_id uuid, job_id uuid, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.usage (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES private.members(id), job_id uuid NOT NULL REFERENCES private.jobs(id),
 provider text NOT NULL, model text NOT NULL, price_version text NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros >= 0), actual_micros bigint,
 input_tokens integer, output_tokens integer, status text NOT NULL DEFAULT 'reserved',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS usage_day ON private.usage(created_at,owner_id);
CREATE TABLE IF NOT EXISTS private.tombstones (owner_id uuid PRIMARY KEY, deleted_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS private.operations (key text PRIMARY KEY, value jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS jobs_recovery ON private.jobs(status,lease_until);
CREATE INDEX IF NOT EXISTS events_expiry ON private.events(created_at);
INSERT INTO private.migrations VALUES (1) ON CONFLICT DO NOTHING;

ALTER TABLE private.analytics ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE private.usage ADD COLUMN IF NOT EXISTS token_bound bigint NOT NULL DEFAULT 0;
ALTER TABLE private.games ADD COLUMN IF NOT EXISTS view_key text;
ALTER TABLE private.games ADD COLUMN IF NOT EXISTS view_hash text;
ALTER TABLE private.jobs ADD COLUMN IF NOT EXISTS work_key text;
DROP INDEX IF EXISTS private.one_active_game;
DROP INDEX IF EXISTS private.one_active_owner;
CREATE UNIQUE INDEX one_active_game ON private.jobs(game_id) WHERE status IN ('queued','running') AND path <> '/internal/lorebook';
CREATE UNIQUE INDEX one_active_owner ON private.jobs(owner_id) WHERE status IN ('queued','running') AND path <> '/internal/lorebook';
ALTER TABLE private.games ADD COLUMN IF NOT EXISTS match_build text;
ALTER TABLE private.members ADD COLUMN IF NOT EXISTS analytics_consent boolean NOT NULL DEFAULT false;
ALTER TABLE private.games ADD COLUMN IF NOT EXISTS diagnostics_consent boolean NOT NULL DEFAULT false;
ALTER TABLE private.tombstones ADD COLUMN IF NOT EXISTS auth_deleted_at timestamptz;
ALTER TABLE private.feedback ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'new';
ALTER TABLE private.feedback ADD COLUMN IF NOT EXISTS operator_note text NOT NULL DEFAULT '';
ALTER TABLE private.feedback ADD COLUMN IF NOT EXISTS revision integer;
ALTER TABLE private.feedback ADD COLUMN IF NOT EXISTS release text;
CREATE TABLE IF NOT EXISTS private.usage_daily (
 day date NOT NULL, owner_id uuid NOT NULL, provider text NOT NULL, model text NOT NULL,
 price_version text NOT NULL, calls bigint NOT NULL, cost_micros bigint NOT NULL,
 input_tokens bigint NOT NULL, output_tokens bigint NOT NULL,
 PRIMARY KEY(day,owner_id,provider,model,price_version)
);
CREATE TABLE IF NOT EXISTS private.audit (
 id uuid PRIMARY KEY, action text NOT NULL, subject text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS private.diagnostics (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL, game_id uuid NOT NULL,
 job_id uuid NOT NULL, object_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '7 days'
);
ALTER TABLE private.tombstones ADD COLUMN IF NOT EXISTS analytics_deletion_requested_at timestamptz;
ALTER TABLE private.jobs ADD COLUMN IF NOT EXISTS lore_failures integer NOT NULL DEFAULT 0;
ALTER TABLE private.jobs ADD COLUMN IF NOT EXISTS committed_revision integer;

ALTER TABLE private.feedback DROP CONSTRAINT IF EXISTS feedback_message_check;
ALTER TABLE private.feedback ADD CONSTRAINT feedback_message_check CHECK(length(message)<=4000);
ALTER TABLE private.feedback ADD COLUMN IF NOT EXISTS turn_index integer;
ALTER TABLE private.usage ADD COLUMN IF NOT EXISTS job_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE private.usage ADD COLUMN IF NOT EXISTS agent text NOT NULL DEFAULT 'unknown';
ALTER TABLE private.usage ADD COLUMN IF NOT EXISTS call_id uuid;
ALTER TABLE private.usage ADD COLUMN IF NOT EXISTS game_version text NOT NULL DEFAULT 'unknown';
-- Google OIDC identity: members are keyed by Google's stable subject, not by email.
ALTER TABLE private.members ADD COLUMN IF NOT EXISTS google_sub text;
CREATE UNIQUE INDEX IF NOT EXISTS members_google_sub ON private.members(google_sub);
ALTER TABLE private.sessions DROP COLUMN IF EXISTS refresh_cipher;
ALTER TABLE private.sessions DROP COLUMN IF EXISTS access_until;
ALTER TABLE private.sessions DROP COLUMN IF EXISTS refresh_claim;
ALTER TABLE private.sessions DROP COLUMN IF EXISTS refresh_until;
