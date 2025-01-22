ALTER TABLE "channels" ADD COLUMN "followers_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "views_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD COLUMN "video_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_followers_count_unique" UNIQUE("followers_count");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_views_count_unique" UNIQUE("views_count");--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_video_count_unique" UNIQUE("video_count");