import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { Context, Hono } from "hono";
import { channels, videos, VideoStatistics, videoStatistics } from "./db/schema";
import { eq, sql } from 'drizzle-orm';
import { cors } from "hono/cors";
import { App } from './types';
import pLimit from 'p-limit';

const app = new Hono<App>();
app.use('/', cors());

// Quota costs for YouTube API operations
const QUOTA_COSTS = {
  channels: { list: 1, update: 50 },
  playlistItems: { list: 1, insert: 50, update: 50, delete: 50 },
  videos: { list: 1, insert: 1600, update: 50, rate: 50, getRating: 1, reportAbuse: 50, delete: 50 },
  search: { list: 100 },
};

let totalQuotaUsed = 0;
// const MAX_QUOTA = 10000; // Example quota limit

// Track quota usage and enforce limits
function trackQuotaUsage(cost: number, endpoint: string) {
  totalQuotaUsed += cost;
  // if (totalQuotaUsed > MAX_QUOTA) {
  //   throw new Error('Quota limit exceeded');
  // }
  // console.log(`Quota used: ${cost} for ${endpoint}. Total quota used: ${totalQuotaUsed}`);
}

// Reusable database client
const getDbClient = (c: Context) => {
  const sqlClient = neon(c.env.DATABASE_URL);
  return drizzle(sqlClient);
};

// Extract username from YouTube URL or handle
function extractUsername(input: string): string | null {
  const urlRegex = /^https?:\/\/(www\.)?youtube\.com\/(channel\/UC[\w-]{21}[AQgw]|(c\/|user\/)?[\w@-]+)$/;
  return input.startsWith('@') ? input : (input.match(urlRegex)?.[2] || null);
}

// Fetch videos from a YouTube playlist
async function getPlaylistVideos(apiKey: string, playlistId: string): Promise<VideoDetails[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${apiKey}`;
  let videos: VideoDetails[] = [];
  let nextPageToken: string | undefined;

  do {
    const apiUrl = nextPageToken ? `${url}&pageToken=${nextPageToken}` : url;
    const response = await fetch(apiUrl);
    const data: PlaylistItemResponse = await response.json();
    trackQuotaUsage(QUOTA_COSTS.playlistItems.list, 'playlistItems.list');
    videos.push(...data.items.map(item => ({
      videoId: item.snippet.resourceId.videoId,
      videoTitle: item.snippet.title,
      thumbnailUrl: item.snippet.thumbnails?.high?.url,
    })));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);

  return videos;
}

// Fetch channel details from the database
async function getChannelDetailsFromDB(channelId: string, c: Context): Promise<ChannelDetails | null> {
  const db = getDbClient(c);
  const existingChannel = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1).execute().then(rows => rows[0]);
  return existingChannel ? { uploads: existingChannel.channelUploadID, id: existingChannel.id, customName: existingChannel.channelName, thumbnailHighUrl: existingChannel.thumbnail } : null;
}

// Fetch channel details from YouTube API
async function getUploadsChannelDetail(apiKey: string, username: string, c: Context): Promise<ChannelDetails> {
  const channelDetailsFromDB = await getChannelDetailsFromDB(username, c);
  if (channelDetailsFromDB) return channelDetailsFromDB;

  const url = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&forHandle=${username}&key=${apiKey}`;
  try {
    const response = await fetch(url);
    const data: YouTubeChannelResponse = await response.json();
    trackQuotaUsage(QUOTA_COSTS.channels.list, 'channels.list');
    return data.items && data.items.length > 0 ? {
      uploads: data.items[0].contentDetails.relatedPlaylists.uploads || null,
      customName: data.items[0].snippet.customUrl || null,
      id: data.items[0].id || null,
      thumbnailHighUrl: data.items[0].snippet.thumbnails.high.url || null,
    } : { uploads: null, id: null, customName: null, thumbnailHighUrl: null };
  } catch (error) {
    console.error('Error fetching uploads channel ID:', { error });
    return { uploads: null, id: null, customName: null, thumbnailHighUrl: null };
  }
}

// Fetch video statistics from YouTube API
async function getVideoStatistics(apiKey: string, videoIds: string[]): Promise<VideoStatistics[]> {
  const batchSize = 50;
  const batches = [];
  for (let i = 0; i < videoIds.length; i += batchSize) {
    batches.push(fetchVideoStatisticsBatch(apiKey, videoIds.slice(i, i + batchSize)));
  }
  return (await Promise.all(batches)).flat();
}

// Fetch a batch of video statistics
async function fetchVideoStatisticsBatch(apiKey: string, videoIds: string[]): Promise<VideoStatistics[]> {
  const url = `https://youtube.googleapis.com/youtube/v3/videos?part=statistics&id=${videoIds.join(',')}&key=${apiKey}`;
  try {
    const response = await fetch(url);
    const data: VideoStatisticsResponse = await response.json();
    trackQuotaUsage(QUOTA_COSTS.videos.list, 'videos.list');
    return data.items?.map(item => ({
      videoId: item.id,
      statistics: item.statistics,
      recordedAt: new Date(),
    })) || [];
  } catch (error) {
    console.error('Error fetching video statistics:', { error, videoIds });
    return [];
  }
}

// Refresh channel details in the database
async function refreshChannelDetails(apiKey: string, channelId: string, c: Context): Promise<void> {
  const db = getDbClient(c);
  const url = `https://youtube.googleapis.com/youtube/v3/channels?part=snippet,contentDetails,statistics&id=${channelId}&key=${apiKey}`;
  try {
    const response = await fetch(url);
    const data: YouTubeChannelResponse = await response.json();
    trackQuotaUsage(QUOTA_COSTS.channels.list, 'channels.list');
    if (data.items && data.items.length > 0) {
      const channel = data.items[0];
      await db.update(channels).set({
        channelName: channel.snippet.customUrl,
        thumbnail: channel.snippet.thumbnails.high.url,
        channelUploadID: channel.contentDetails.relatedPlaylists.uploads,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      }).where(eq(channels.id, channelId)).execute();
      console.log(`Updated channel details for channel ID: ${channelId}`);
    } else {
      console.warn(`No channel found with ID: ${channelId}`);
    }
  } catch (error) {
    console.error(`Error refreshing channel details for channel ID: ${channelId}`, { error });
    throw error;
  }
}

// Refresh details for all channels
async function refreshAllChannelDetails(apiKey: string, c: Context): Promise<{ id: string; name: string }[]> {
  const db = getDbClient(c);
  const allChannels = await db.select({ id: channels.id, name: channels.channelName }).from(channels).execute();
  const limit = pLimit(5); // Limit concurrency
  await Promise.all(allChannels.map(channel => limit(() => refreshChannelDetails(apiKey, channel.id, c))));
  console.log('Refreshed details for all channels.');
  return allChannels;
}

// Insert or update a channel in the database
const insertChannel = async (channelId: string, channelThumbnail: string, channelUpload: string, channelName: string, c: Context) => {
  const db = getDbClient(c);
  const newChannel = await db.insert(channels).values({
    id: channelId,
    thumbnail: channelThumbnail,
    channelUploadID: channelUpload,
    channelName: channelName,
  }).onConflictDoUpdate({
    target: channels.id,
    set: {
      thumbnail: channelThumbnail,
      channelUploadID: channelUpload,
      channelName: channelName,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  }).returning();
  return newChannel[0];
};

// Insert or update videos in the database
async function insertVideos(videoDetails: VideoDetails[], channelId: string, c: Context): Promise<void> {
  const db = getDbClient(c);
  const values = videoDetails.map((video) => ({
    id: video.videoId,
    channelId: channelId,
    title: video.videoTitle,
    url: `https://www.youtube.com/watch?v=${video.videoId}`,
    thumbnailUrl: video.thumbnailUrl || '',
    createdAt: sql`CURRENT_TIMESTAMP`,
    updatedAt: sql`CURRENT_TIMESTAMP`,
  }));

  await db.insert(videos).values(values).onConflictDoUpdate({
    target: videos.id,
    set: {
      title: sql`EXCLUDED.title`,
      thumbnailUrl: sql`EXCLUDED.thumbnail_url`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    },
  }).execute();
}

// Insert video statistics in the database
async function insertVideoStatistics(videoStats: VideoStatistics[], c: Context): Promise<void> {
  const db = getDbClient(c);
  await db.insert(videoStatistics).values(videoStats.map(stat => ({
    videoId: stat.videoId,
    statistics: stat.statistics,
    recordedAt: sql`CURRENT_TIMESTAMP`,
  }))).execute();
}

// Routes
app.get('/refresh-all-channels', async (c) => {
  totalQuotaUsed = 0;
  const startTime = Date.now();
  try {
    const apiKey = c.env.apiKey;
    const updatedChannels = await refreshAllChannelDetails(apiKey, c);
    const endTime = Date.now();
    const elapsedTime = endTime - startTime;
    return c.json({
      status: '200 OK',
      elapsedTime: `${elapsedTime}ms`,
      message: 'Refreshed details for all channels.',
      quotaUsed: totalQuotaUsed,
      updatedChannels: updatedChannels,
    }, 200);
  } catch (error) {
    console.error('Error refreshing all channels:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while refreshing channel details.',
      quotaUsed: totalQuotaUsed,
    }, 500);
  }
});

app.get('/', async (c) => {
  totalQuotaUsed = 0;
  try {
    const apiKey = c.env.apiKey;
    const startTime = Date.now();
    const channelUrl = c.req.query('url');
    if (!channelUrl) return c.text("URL or username is missing", 400);

    const username = extractUsername(channelUrl);
    if (!username) return c.text("Invalid input (either a YouTube URL or a username is required)", 400);

    const ChannelDetails = await getUploadsChannelDetail(apiKey, username, c);
    if (!ChannelDetails?.id || !ChannelDetails.customName || !ChannelDetails?.thumbnailHighUrl || !ChannelDetails?.uploads) {
      return c.text("Invalid input (either a YouTube URL or a username is required)", 400);
    }

    const videos = await getPlaylistVideos(apiKey, ChannelDetails.uploads);
    if (videos.length === 0) return c.text("No videos found in the playlist.");

    const videoIds = videos.map(video => video.videoId);
    const stats = await getVideoStatistics(apiKey, videoIds);

    const channel = await insertChannel(ChannelDetails.id, ChannelDetails.thumbnailHighUrl, ChannelDetails.uploads, ChannelDetails.customName, c);
    await insertVideos(videos, ChannelDetails.id, c);
    await insertVideoStatistics(stats, c);

    const endTime = Date.now();
    const elapsedTime = endTime - startTime;

    return c.json({
      status: '200 OK',
      elapsedTime: `${elapsedTime}ms`,
      quotaUsed: totalQuotaUsed,
      channel: channel,
      Date: Date.now(),
      video: stats,
    }, 200);
  } catch (error) {
    console.error('Error:', { error });
    return c.text("Internal Server Error", 500);
  }
});

export default app;