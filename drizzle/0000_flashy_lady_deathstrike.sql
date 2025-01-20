CREATE TABLE IF NOT EXISTS "channels" (
	"youtube_id" text PRIMARY KEY NOT NULL,
	"channel_name" text NOT NULL,
	"thumbnail_link" text,
	"channel_upload" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "channels_youtube_id_unique" UNIQUE("youtube_id"),
	CONSTRAINT "channels_channel_name_unique" UNIQUE("channel_name"),
	CONSTRAINT "channels_thumbnail_link_unique" UNIQUE("thumbnail_link"),
	CONSTRAINT "channels_channel_upload_unique" UNIQUE("channel_upload")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "video_statistics" (
	"statistic_id" uuid DEFAULT gen_random_uuid(),
	"video_id" text NOT NULL,
	"statistics" jsonb NOT NULL,
	"recorded_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "videos" (
	"video_id" text PRIMARY KEY NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"thumbnail_url" text NOT NULL,
	"created_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updated_at" timestamp DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "videos_video_id_unique" UNIQUE("video_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "video_statistics" ADD CONSTRAINT "video_statistics_video_id_videos_video_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("video_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "videos" ADD CONSTRAINT "videos_channel_id_channels_youtube_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("youtube_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
