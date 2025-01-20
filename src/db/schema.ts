import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, jsonb, uuid } from 'drizzle-orm/pg-core';

export const channels = pgTable('channels', {
  id: text('youtube_id').unique().primaryKey(),
  channelName: text('channel_name').notNull().unique(),
  thumbnail: text('thumbnail_link').unique(),
  channelUploadID: text('channel_upload').notNull().unique(),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const videos = pgTable('videos', {
  id: text('video_id').notNull().unique().primaryKey(),
  channelId: text('channel_id')
    .notNull()
    .references(() => channels.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  url: text('url').notNull(),
  thumbnailUrl: text('thumbnail_url').notNull(),
  createdAt: timestamp('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});


export const videoStatistics = pgTable('video_statistics', {
  id: uuid('statistic_id').default(sql`gen_random_uuid()`),
  videoId: text('video_id')
    .notNull()
    .references(() => videos.id, { onDelete: 'cascade' }),
  statistics: jsonb('statistics').notNull(),
  recordedAt: timestamp('recorded_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});


export const channelsIndexes = {
  channelNameIndex: sql`CREATE INDEX IF NOT EXISTS channel_name_idx ON ${channels} (channel_name)`,
};

export const videosIndexes = {
  channelIdIndex: sql`CREATE INDEX IF NOT EXISTS channel_id_idx ON ${videos} (channel_id)`,
  createdAtIndex: sql`CREATE INDEX IF NOT EXISTS video_created_at_idx ON ${videos} (created_at)`,
};

export const videoStatisticsIndexes = {
  videoIdIndex: sql`CREATE INDEX IF NOT EXISTS video_id_idx ON ${videoStatistics} (video_id)`,
  recordedAtIndex: sql`CREATE INDEX IF NOT EXISTS recorded_at_idx ON ${videoStatistics} (recorded_at)`,
};


export type Channel = typeof channels.$inferInsert;
export type Video = typeof videos.$inferInsert;
export type VideoStatistics = typeof videoStatistics.$inferInsert;