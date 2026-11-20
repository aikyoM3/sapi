-- Durable queue metadata for background bulk invoice extraction.
ALTER TABLE invoicesession
  DROP CONSTRAINT IF EXISTS invoicesession_status_check;

ALTER TABLE invoicesession
  ADD COLUMN IF NOT EXISTS source_mode VARCHAR(16) NOT NULL DEFAULT 'SINGLE',
  ADD COLUMN IF NOT EXISTS batch_token VARCHAR(128),
  ADD COLUMN IF NOT EXISTS queue_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS route_index INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prompt_version VARCHAR(16) NOT NULL DEFAULT 'compact',
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ;

ALTER TABLE invoicesession
  ADD CONSTRAINT invoicesession_status_check CHECK (status IN (
    'WAITING_IMAGES', 'UPLOADING', 'READY_TO_PROCESS', 'QUEUED',
    'PROCESSING', 'RETRY_WAIT', 'READY_FOR_REVIEW', 'CONFIRMED', 'FAILED'
  ));

ALTER TABLE invoicesession
  DROP CONSTRAINT IF EXISTS invoicesession_source_mode_check;
ALTER TABLE invoicesession
  ADD CONSTRAINT invoicesession_source_mode_check CHECK (source_mode IN ('SINGLE', 'BATCH'));

ALTER TABLE invoicesession
  DROP CONSTRAINT IF EXISTS invoicesession_queue_attempts_check;
ALTER TABLE invoicesession
  ADD CONSTRAINT invoicesession_queue_attempts_check CHECK (queue_attempts >= 0 AND route_index >= 0);

CREATE INDEX IF NOT EXISTS invoicesession_queue_idx
  ON invoicesession (next_attempt_at, created_at)
  WHERE source_mode = 'BATCH' AND status IN ('QUEUED', 'RETRY_WAIT');

CREATE INDEX IF NOT EXISTS invoicesession_batch_token_idx
  ON invoicesession (user_id, batch_token) WHERE batch_token IS NOT NULL;
