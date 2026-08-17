ALTER TABLE "playback_sessions" RENAME COLUMN "play_session_id" TO "session_id";--> statement-breakpoint
DROP INDEX "playback_sessions_identity_uniq";--> statement-breakpoint
CREATE UNIQUE INDEX "playback_sessions_identity_uniq" ON "playback_sessions" USING btree ("session_id","item_id") WHERE "playback_sessions"."ended_at" is null;