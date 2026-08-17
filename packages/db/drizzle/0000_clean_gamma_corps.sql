CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"client" text,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" text PRIMARY KEY NOT NULL,
	"library_id" text,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"series_id" text,
	"season_id" text,
	"production_year" integer,
	"runtime_ticks" bigint,
	"image_tag" text,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jellyfin_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_admin" boolean DEFAULT false NOT NULL,
	"last_seen_at" timestamp with time zone,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "libraries" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"collection_type" text,
	"item_count" integer DEFAULT 0 NOT NULL,
	"archived" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "playback_rollup_daily" (
	"day" date NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"library_id" text,
	"play_count" integer DEFAULT 0 NOT NULL,
	"watch_ms" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "playback_rollup_daily_day_user_id_item_id_pk" PRIMARY KEY("day","user_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "playback_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"play_session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text NOT NULL,
	"device_id" text,
	"client" text,
	"play_method" text,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"position_ticks" bigint DEFAULT 0 NOT NULL,
	"watch_ms" bigint DEFAULT 0 NOT NULL,
	"is_paused" boolean DEFAULT false NOT NULL,
	"completed" boolean DEFAULT false NOT NULL,
	"remote_endpoint" text
);
--> statement-breakpoint
CREATE INDEX "items_library_idx" ON "items" USING btree ("library_id");--> statement-breakpoint
CREATE INDEX "items_series_idx" ON "items" USING btree ("series_id");--> statement-breakpoint
CREATE INDEX "rollup_day_idx" ON "playback_rollup_daily" USING btree ("day");--> statement-breakpoint
CREATE INDEX "rollup_user_day_idx" ON "playback_rollup_daily" USING btree ("user_id","day");--> statement-breakpoint
CREATE INDEX "rollup_item_day_idx" ON "playback_rollup_daily" USING btree ("item_id","day");--> statement-breakpoint
CREATE INDEX "rollup_library_day_idx" ON "playback_rollup_daily" USING btree ("library_id","day");--> statement-breakpoint
CREATE UNIQUE INDEX "playback_sessions_identity_uniq" ON "playback_sessions" USING btree ("play_session_id","item_id");--> statement-breakpoint
CREATE INDEX "playback_sessions_open_idx" ON "playback_sessions" USING btree ("ended_at");--> statement-breakpoint
CREATE INDEX "playback_sessions_user_started_idx" ON "playback_sessions" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "playback_sessions_item_started_idx" ON "playback_sessions" USING btree ("item_id","started_at");