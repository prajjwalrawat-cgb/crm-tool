-- 0076_call_transcription.sql
--
-- Call transcription (speech-to-text) state on `calls`, and the per-workspace
-- switch + recording-consent confirmation on `telephony_settings`.
--
-- Columns only, no new tables. Both tables already have ENABLE + FORCE RLS
-- with the four tenant policies (0073); row policies cover every column, so
-- nothing changes for isolation. verify-rls checks this.
--
-- transcript_status: NULL (never attempted) | pending | done | failed | skipped.
-- transcript_segments: [{speaker: agent|customer|unknown, startMs, endMs,
--   text, confidence, label?}], ordered by startMs.
--
-- Idempotent: safe to replay on every deploy.

ALTER TABLE "calls"
  ADD COLUMN IF NOT EXISTS "transcript_segments" jsonb,
  ADD COLUMN IF NOT EXISTS "transcript_language" text,
  ADD COLUMN IF NOT EXISTS "transcript_provider" text,
  ADD COLUMN IF NOT EXISTS "transcript_model" text,
  ADD COLUMN IF NOT EXISTS "transcript_status" text,
  ADD COLUMN IF NOT EXISTS "transcript_error" text,
  ADD COLUMN IF NOT EXISTS "transcript_attempts" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "transcript_started_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "transcript_completed_at" timestamptz;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'calls_transcript_status_check') THEN
    ALTER TABLE "calls" ADD CONSTRAINT "calls_transcript_status_check"
      CHECK ("transcript_status" IS NULL OR "transcript_status" IN ('pending', 'done', 'failed', 'skipped'));
  END IF;
END $$;
--> statement-breakpoint
-- Transcripts written before 0076 (none expected) count as done.
UPDATE "calls" SET "transcript_status" = 'done'
WHERE "transcript" IS NOT NULL AND "transcript_status" IS NULL;
--> statement-breakpoint
-- Partial index for the retry / stale-claim sweep and the "transcribing" UI.
CREATE INDEX IF NOT EXISTS "calls_transcript_pending_idx"
  ON "calls" ("tenant_id", "transcript_started_at")
  WHERE "transcript_status" = 'pending';
--> statement-breakpoint
ALTER TABLE "telephony_settings"
  ADD COLUMN IF NOT EXISTS "transcription_enabled" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "transcription_consent_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "transcription_consent_by" text,
  -- Which speech-to-text provider this workspace uses: 'deepgram' | 'sarvam'.
  -- NULL = none chosen = no transcription. Chosen by an admin in Settings >
  -- Telephony; the provider's API key still lives in the server environment.
  ADD COLUMN IF NOT EXISTS "transcription_provider" text;
