-- Provision passwords separately through psql \password or your secret manager workflow.
DO $$ BEGIN
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gaffer_api') THEN CREATE ROLE gaffer_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gaffer_worker') THEN CREATE ROLE gaffer_worker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
 IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='gaffer_maintenance') THEN CREATE ROLE gaffer_maintenance LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS; END IF;
END $$;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO gaffer_api,gaffer_worker,gaffer_maintenance;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA private TO gaffer_api,gaffer_worker,gaffer_maintenance;
REVOKE ALL ON private.migrations FROM gaffer_api,gaffer_worker;
ALTER TABLE private.games ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.games FORCE ROW LEVEL SECURITY;
ALTER TABLE private.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_games ON private.games;
CREATE POLICY owner_games ON private.games USING (owner_id::text=current_setting('gaffer.actor',true) OR current_user IN ('gaffer_worker','gaffer_maintenance')) WITH CHECK (owner_id::text=current_setting('gaffer.actor',true) OR current_user IN ('gaffer_worker','gaffer_maintenance'));
DROP POLICY IF EXISTS owner_jobs ON private.jobs;
CREATE POLICY owner_jobs ON private.jobs USING (owner_id::text=current_setting('gaffer.actor',true) OR current_user IN ('gaffer_worker','gaffer_maintenance')) WITH CHECK (owner_id::text=current_setting('gaffer.actor',true) OR current_user IN ('gaffer_worker','gaffer_maintenance'));
ALTER TABLE private.feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_feedback ON private.feedback;
CREATE POLICY owner_feedback ON private.feedback USING (owner_id::text=current_setting('gaffer.actor',true) OR current_user='gaffer_maintenance') WITH CHECK (owner_id::text=current_setting('gaffer.actor',true) OR current_user='gaffer_maintenance');
ALTER TABLE private.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS owner_events ON private.events;
CREATE POLICY owner_events ON private.events USING (current_user IN ('gaffer_worker','gaffer_maintenance') OR EXISTS (SELECT 1 FROM private.jobs j WHERE j.id=job_id AND j.owner_id::text=current_setting('gaffer.actor',true)));
