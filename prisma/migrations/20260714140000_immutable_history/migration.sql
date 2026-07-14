-- Immutable history, enforced by the database.
--
-- ARCHITECTURE.md §9 and DECISIONS.md D-010 both claim version history is immutable and the
-- operation log is append-only. A claim enforced only by code review is a claim that survives
-- exactly until someone adds a "quick fix" endpoint at 2am. So the database refuses.
--
-- This is deliberately below the ORM: it holds for Prisma, for a psql session, for a migration
-- script, and for a future service written by someone who never read the docs.

CREATE OR REPLACE FUNCTION vellum_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'relation "%" is append-only: % is not permitted (see DECISIONS.md D-010)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- Versions: a snapshot, once written, is a historical fact. Restoring an old version appends a
-- NEW version row (kind = RESTORE, parentVersionId -> the restored one). It never edits the old
-- one. Deleting a version would punch a hole in the lineage DAG that children point into.
CREATE TRIGGER versions_immutable
  BEFORE UPDATE OR DELETE ON versions
  FOR EACH ROW EXECUTE FUNCTION vellum_reject_mutation();

-- Operations: the source of truth. Every derived artefact in the system (document state,
-- snapshots, diffs) is a fold over this table. Mutating a committed operation would silently
-- change the past for every replica that has not yet folded it — divergence with no error and
-- no way to detect it after the fact.
--
-- UPDATE is rejected outright. DELETE is rejected here too; compaction (ARCHITECTURE.md §8)
-- works by advancing the snapshot watermark and *not shipping* old operations, not by deleting
-- them. If a hard-delete path is ever genuinely needed (GDPR erasure), it gets its own explicit,
-- audited migration that drops and recreates this trigger — which is the point: it has to be a
-- decision, not an accident.
CREATE TRIGGER operations_append_only
  BEFORE UPDATE OR DELETE ON operations
  FOR EACH ROW EXECUTE FUNCTION vellum_reject_mutation();

-- Audit logs: an attacker who can erase the record of their access is an attacker who was never
-- there. Append-only is the entire value of the table.
CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION vellum_reject_mutation();

-- NOTE on ON DELETE CASCADE: documents cascade-delete their operations and versions. That is not
-- a contradiction — these triggers protect against *row-level* tampering, while a document hard
-- delete is a whole-aggregate removal. In practice the application never hard-deletes a document
-- (Document.deletedAt is a soft delete); the cascade exists for genuine erasure requests, which
-- are performed deliberately and audited. Row-level triggers do not fire for cascaded deletes'
-- parent statement, but they DO fire for the cascaded child rows — so we must allow that path
-- explicitly rather than have GDPR erasure fail with a restrict_violation.
--
-- The mechanism: a session-local flag that only the erasure routine sets.
CREATE OR REPLACE FUNCTION vellum_reject_mutation() RETURNS trigger AS $$
BEGIN
  IF current_setting('vellum.allow_erasure', true) = 'on' THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  RAISE EXCEPTION
    'relation "%" is append-only: % is not permitted (see DECISIONS.md D-010)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
