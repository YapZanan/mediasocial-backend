import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { Context, Hono } from "hono";
import { channels, videos, VideoStatistics, videoStatistics } from "./db/schema";
import { eq, inArray, sql, and, ilike, desc } from 'drizzle-orm';
import { cors } from "hono/cors";
import { App } from './types';
import pLimit from 'p-limit';

const app = new Hono<App>();
app.use('/*', cors());

// Quota costs for YouTube API operations
const QUOTA_COSTS = {
  channels: { list: 1, update: 50 },
  playlistItems: { list: 1, insert: 50, update: 50, delete: 50 },
  videos: { list: 1, insert: 1600, update: 50, rate: 50, getRating: 1, reportAbuse: 50, delete: 50 },
  search: { list: 100 },
};

let totalQuotaUsed = 0;

// Track quota usage and enforce limits
function trackQuotaUsage(cost: number, endpoint: string) {
  totalQuotaUsed += cost;
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
  return existingChannel ? {
    uploads: existingChannel.channelUploadID,
    id: existingChannel.id,
    customName: existingChannel.channelName,
    followersCount: existingChannel.followersCount,
    viewsCount: existingChannel.viewsCount,
    videoCount: existingChannel.videoCount,
    thumbnailHighUrl: existingChannel.thumbnail
  } : null;
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
      followersCount: Number(data.items[0].statistics.subscriberCount) || null,
      viewsCount: Number(data.items[0].statistics.viewCount) || null,
      videoCount: Number(data.items[0].statistics.videoCount) || null,
      thumbnailHighUrl: data.items[0].snippet.thumbnails.high.url || null,
    } : { uploads: null, id: null, customName: null, followersCount: null, videoCount: null, viewsCount: null, thumbnailHighUrl: null };
  } catch (error) {
    console.error('Error fetching uploads channel ID:', { error });
    return { uploads: null, id: null, customName: null, followersCount: null, videoCount: null, viewsCount: null, thumbnailHighUrl: null };
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
const insertChannel = async (channelId: string, channelThumbnail: string, channelUpload: string, followers_count: number, views_count: number, video_count: number, channelName: string, c: Context) => {
  const db = getDbClient(c);
  const newChannel = await db.insert(channels).values({
    id: channelId,
    thumbnail: channelThumbnail,
    channelUploadID: channelUpload,
    followersCount: followers_count,
    videoCount: video_count,
    viewsCount: views_count,
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
async function insertVideoStatistics(videoStats: VideoStatistics[], c: Context): Promise<number> {
  const db = getDbClient(c);
  try {
    // Insert video statistics into the database
    const result = await db
      .insert(videoStatistics)
      .values(
        videoStats.map(stat => ({
          videoId: stat.videoId,
          statistics: stat.statistics,
          recordedAt: sql`CURRENT_TIMESTAMP`,
        }))
      )
      .execute();

    // Return the number of inserted records
    return videoStats.length; // Fallback to the length of the input array
  } catch (error) {
    console.error('Error inserting video statistics:', error);
    throw error;
  }
}

// RESTful Routes

// Get all channels
app.get('/channels', async (c) => {
  try {
    const db = getDbClient(c);
    const allChannels = await db.select().from(channels).execute();
    const response: Channel[] = allChannels.map(channel => ({
      id: channel.id,
      channelName: channel.channelName,
      thumbnail: channel.thumbnail,
      channelUploadID: channel.channelUploadID,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    }));
    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching channels:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching channels.',
    }, 500);
  }
});

app.get('/channels/:id', async (c) => {
  try {
    const db = getDbClient(c);
    const channelId = c.req.param('id');

    if (!channelId) {
      return c.json({
        status: '400 Bad Request',
        message: 'channelId is required.',
      }, 400);
    }

    // Check if the channel exists
    const channel = await db.select().from(channels).where(eq(channels.id, channelId)).execute();

    if (channel.length === 0) {
      return c.json({
        status: '404 Not Found',
        message: 'Channel not found.',
      }, 404);
    }

    const allVideos = await db.select().from(videos).where(eq(videos.channelId, channelId)).execute();
    const videoIds = allVideos.map(video => video.id);
    const allVideoStatistics = await db
      .select()
      .from(videoStatistics)
      .where(inArray(videoStatistics.videoId, videoIds))
      .execute();

    const videosWithStatistics = allVideos.map(video => {
      const statistics = allVideoStatistics.filter(stat => stat.videoId === video.id);
      return {
        ...video,
        statistics: statistics,
      };
    });

    const response: VideoWithStatistics[] = videosWithStatistics.map(video => ({
      id: video.id,
      channelId: video.channelId,
      title: video.title,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      statistics: video.statistics.map(stat => ({
        id: stat.id,
        videoId: stat.videoId,
        statistics: stat.statistics as Record<string, unknown>,
        recordedAt: stat.recordedAt,
      })),
    }));

    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching videos with statistics:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching videos with statistics.',
    }, 500);
  }
});

app.get('/statistics', async (c) => {
  try {
    // Check if the data is already cached in KV
    const cachedData = await c.env.youtube_cache.get('channelStatistics', 'json');

    if (cachedData) {
      // Return the cached data if it exists
      return c.json({
        status: '200 OK',
        data: cachedData,
        source: 'cache',
      });
    }

    const db = getDbClient(c);

    // Fetch all channels, videos, and statistics in a single query using joins
    const allData = await db
      .select({
        channelId: channels.id,
        channelName: channels.channelName,
        followersCount: channels.followersCount, // Include followersCount
        viewsCount: channels.viewsCount, // Include viewsCount
        videoId: videos.id,
        statistics: videoStatistics.statistics,
      })
      .from(channels)
      .leftJoin(videos, eq(videos.channelId, channels.id))
      .leftJoin(videoStatistics, eq(videoStatistics.videoId, videos.id))
      .execute();

    // Aggregate statistics by channel
    const channelStatisticsMap = new Map();

    allData.forEach((row) => {
      if (!row.channelId) return; // Skip rows without a channel

      if (!channelStatisticsMap.has(row.channelId)) {
        channelStatisticsMap.set(row.channelId, {
          channelId: row.channelId,
          channelName: row.channelName,
          followersCount: row.followersCount, // Pass followersCount directly
          viewsCount: row.viewsCount, // Pass viewsCount directly
          totalLikes: 0,
          totalComments: 0,
        });
      }

      const channelStats = channelStatisticsMap.get(row.channelId);

      if (row.statistics) {
        const stats = row.statistics as {
          likeCount: string;
          commentCount: string;
        };

        // Aggregate likes and comments
        channelStats.totalLikes += parseInt(stats.likeCount) || 0;
        channelStats.totalComments += parseInt(stats.commentCount) || 0;
      }
    });

    // Convert the map to an array
    const channelStatistics = Array.from(channelStatisticsMap.values());

    // Cache the data in KV
    await c.env.youtube_cache.put('channelStatistics', JSON.stringify(channelStatistics), {
      expirationTtl: 3600, // 1 hour in seconds
    });

    // Return the response
    return c.json({
      status: '200 OK',
      data: channelStatistics,
      source: 'database',
    });
  } catch (error) {
    console.error('Error fetching channel statistics:', { error });
    return c.json(
      {
        status: '500 Internal Server Error',
        message: 'An error occurred while fetching channel statistics.',
      },
      500
    );
  }
});

// Get a specific channel by ID
app.get('/channels/get/:id', async (c) => {
  try {
    const db = getDbClient(c);
    const channelId = c.req.param('id');

    if (!channelId) {
      return c.json({
        status: '400 Bad Request',
        message: 'channelId is required.',
      }, 400);
    }

    // Check if the channel exists
    const channel = await db.select().from(channels).where(eq(channels.id, channelId)).execute();

    if (channel.length === 0) {
      return c.json({
        status: '404 Not Found',
        message: 'Channel not found.',
      }, 404);
    }

    const allVideos = await db.select().from(videos).where(eq(videos.channelId, channelId)).execute();
    const videoIds = allVideos.map(video => video.id);
    const allVideoStatistics = await db
      .select()
      .from(videoStatistics)
      .where(inArray(videoStatistics.videoId, videoIds))
      .execute();

    const videosWithStatistics = allVideos.map(video => {
      const statistics = allVideoStatistics.filter(stat => stat.videoId === video.id);
      return {
        ...video,
        statistics: statistics,
      };
    });

    const response: VideoWithStatistics[] = videosWithStatistics.map(video => ({
      id: video.id,
      channelId: video.channelId,
      title: video.title,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
      statistics: video.statistics.map(stat => ({
        id: stat.id,
        videoId: stat.videoId,
        statistics: stat.statistics as Record<string, unknown>,
        recordedAt: stat.recordedAt,
      })),
    }));

    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching videos with statistics:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching videos with statistics.',
    }, 500);
  }
});

// Get all videos for a specific channel
app.get('/channels/:id/videos', async (c) => {
  try {
    const db = getDbClient(c);
    const channelId = c.req.param('id');

    if (!channelId) {
      return c.json({
        status: '400 Bad Request',
        message: 'channelId is required.',
      }, 400);
    }

    const allVideos = await db.select().from(videos).where(eq(videos.channelId, channelId)).execute();
    const response: Video[] = allVideos.map(video => ({
      id: video.id,
      channelId: video.channelId,
      title: video.title,
      url: video.url,
      thumbnailUrl: video.thumbnailUrl,
      createdAt: video.createdAt,
      updatedAt: video.updatedAt,
    }));

    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching videos:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching videos.',
    }, 500);
  }
});

// Get video statistics for specific video IDs
app.get('/videos/statistics', async (c) => {
  try {
    const db = getDbClient(c);
    const videoIds = c.req.query('videoIds');

    if (!videoIds) {
      return c.json({
        status: '400 Bad Request',
        message: 'videoIds is required (comma-separated).',
      }, 400);
    }

    const videoIdsArray = videoIds.split(',');
    const allVideoStatistics = await db
      .select()
      .from(videoStatistics)
      .where(inArray(videoStatistics.videoId, videoIdsArray))
      .execute();

    const response: VideoStatistics[] = allVideoStatistics.map(stat => ({
      id: stat.id,
      videoId: stat.videoId,
      statistics: stat.statistics,
      recordedAt: stat.recordedAt,
    }));

    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching video statistics:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching video statistics.',
    }, 500);
  }
});

// Get all data (channels, videos, and video statistics)
app.get('/all-data', async (c) => {
  try {
    const db = getDbClient(c);
    const allChannels = await db.select().from(channels).execute();
    const allVideos = await db.select().from(videos).execute();
    const allVideoStatistics = await db
      .select()
      .from(videoStatistics)
      .execute();

    const response: AllDataResponse = {
      channels: allChannels.map(channel => ({
        id: channel.id,
        channelName: channel.channelName,
        thumbnail: channel.thumbnail,
        channelUploadID: channel.channelUploadID,
        createdAt: channel.createdAt,
        updatedAt: channel.updatedAt,
      })),
      videos: allVideos.map(video => ({
        id: video.id,
        channelId: video.channelId,
        title: video.title,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      })),
      videoStatistics: allVideoStatistics.map(stat => ({
        id: stat.id,
        videoId: stat.videoId,
        statistics: stat.statistics as Record<string, unknown>,
        recordedAt: stat.recordedAt,
      })),
    };

    return c.json({
      status: '200 OK',
      data: response,
    }, 200);
  } catch (error) {
    console.error('Error fetching all data:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching all data.',
    }, 500);
  }
});


app.get('/all-video', async (c) => {
  try {
    const db = getDbClient(c);

    // Extract query parameters for pagination
    const pageQuery = c.req.query('page');
    const limitQuery = c.req.query('limit');

    // Provide default values if query parameters are undefined
    const page = pageQuery ? parseInt(pageQuery) : 1; // Default to page 1
    const limit = limitQuery ? parseInt(limitQuery) : 10; // Default to 10 items per page
    const offset = (page - 1) * limit; // Calculate the offset

    // Fetch paginated videos from the database
    const allVideos = await db
      .select()
      .from(videos)
      .limit(limit)
      .offset(offset)
      .execute();

    // Count total number of videos for pagination metadata
    const totalVideos = await db
      .select({ count: sql<number>`count(*)` })
      .from(videos)
      .execute();
    const totalCount = totalVideos[0]?.count || 0;

    // Construct the response
    const response: AllVideoResponse = {
      videos: allVideos.map((video) => ({
        id: video.id,
        channelId: video.channelId,
        title: video.title,
        url: video.url,
        thumbnailUrl: video.thumbnailUrl,
        createdAt: video.createdAt,
        updatedAt: video.updatedAt,
      })),
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };

    return c.json(
      {
        status: '200 OK',
        data: response,
      },
      200
    );
  } catch (error) {
    console.error('Error fetching all data:', { error });
    return c.json(
      {
        status: '500 Internal Server Error',
        message: 'An error occurred while fetching all data.',
      },
      500
    );
  }
});


// Refresh all channels
app.post('/channels/refresh', async (c) => {
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


// Get top 5 most viewed videos
app.get('/videos/top-views', async (c) => {
  try {
    const db = getDbClient(c);

    // Get the limit from query params, default to 5 if not provided
    const limit = parseInt(c.req.query('limit') || '5', 10);

    // Subquery to get the latest video statistics for each video
    const latestVideoStatistics = db
      .select({
        videoId: videoStatistics.videoId,
        latestRecordedAt: sql`MAX(${videoStatistics.recordedAt})`.as('latestRecordedAt'),
      })
      .from(videoStatistics)
      .groupBy(videoStatistics.videoId)
      .as('latestVideoStatistics');

    // Main query to get the top viewed videos
    const topViewedVideos = await db
      .select({
        videoId: videos.id,
        channelName: channels.channelName, // Include channelName
        title: videos.title,
        views: sql<number>`COALESCE(CAST(${videoStatistics.statistics}->>'viewCount' AS INTEGER), 0)`.as('views'),
      })
      .from(videos)
      .leftJoin(videoStatistics, eq(videos.id, videoStatistics.videoId))
      .leftJoin(
        latestVideoStatistics,
        and(
          eq(videoStatistics.videoId, latestVideoStatistics.videoId),
          eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
        )
      )
      .leftJoin(channels, eq(videos.channelId, channels.id)) // Join the channels table
      .where(and(
        eq(videoStatistics.videoId, latestVideoStatistics.videoId),
        eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
      ))
      .orderBy(sql`views DESC`)
      .limit(limit) // Use the dynamic limit
      .execute();

    return c.json({
      status: '200 OK',
      data: topViewedVideos,
    }, 200);
  } catch (error) {
    console.error('Error fetching top viewed videos:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching top viewed videos.',
    }, 500);
  }
});

// Get top 5 most liked videos
app.get('/videos/top-likes', async (c) => {
  try {
    const db = getDbClient(c);

    // Get the limit from query params, default to 5 if not provided
    const limit = parseInt(c.req.query('limit') || '5', 10);

    // Subquery to get the latest video statistics for each video
    const latestVideoStatistics = db
      .select({
        videoId: videoStatistics.videoId,
        latestRecordedAt: sql`MAX(${videoStatistics.recordedAt})`.as('latestRecordedAt'),
      })
      .from(videoStatistics)
      .groupBy(videoStatistics.videoId)
      .as('latestVideoStatistics');

    // Main query to get the top liked videos
    const topLikedVideos = await db
      .select({
        videoId: videos.id,
        channelName: channels.channelName, // Include channelName
        title: videos.title,
        likes: sql<number>`COALESCE(CAST(${videoStatistics.statistics}->>'likeCount' AS INTEGER), 0)`.as('likes'),
      })
      .from(videos)
      .leftJoin(videoStatistics, eq(videos.id, videoStatistics.videoId))
      .leftJoin(
        latestVideoStatistics,
        and(
          eq(videoStatistics.videoId, latestVideoStatistics.videoId),
          eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
        )
      )
      .leftJoin(channels, eq(videos.channelId, channels.id)) // Join the channels table
      .where(and(
        eq(videoStatistics.videoId, latestVideoStatistics.videoId),
        eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
      ))
      .orderBy(sql`likes DESC`)
      .limit(limit) // Use the dynamic limit
      .execute();

    return c.json({
      status: '200 OK',
      data: topLikedVideos,
    }, 200);
  } catch (error) {
    console.error('Error fetching top liked videos:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching top liked videos.',
    }, 500);
  }
});

// Get top 5 most commented videos
app.get('/videos/top-comments', async (c) => {
  try {
    const db = getDbClient(c);

    // Get the limit from query params, default to 5 if not provided
    const limit = parseInt(c.req.query('limit') || '5', 10);

    // Subquery to get the latest video statistics for each video
    const latestVideoStatistics = db
      .select({
        videoId: videoStatistics.videoId,
        latestRecordedAt: sql`MAX(${videoStatistics.recordedAt})`.as('latestRecordedAt'),
      })
      .from(videoStatistics)
      .groupBy(videoStatistics.videoId)
      .as('latestVideoStatistics');

    // Main query to get the top commented videos
    const topCommentedVideos = await db
      .select({
        videoId: videos.id,
        channelName: channels.channelName, // Include channelName
        title: videos.title,
        comments: sql<number>`COALESCE(CAST(${videoStatistics.statistics}->>'commentCount' AS INTEGER), 0)`.as('comments'),
      })
      .from(videos)
      .leftJoin(videoStatistics, eq(videos.id, videoStatistics.videoId))
      .leftJoin(
        latestVideoStatistics,
        and(
          eq(videoStatistics.videoId, latestVideoStatistics.videoId),
          eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
        )
      )
      .leftJoin(channels, eq(videos.channelId, channels.id)) // Join the channels table
      .where(and(
        eq(videoStatistics.videoId, latestVideoStatistics.videoId),
        eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
      ))
      .orderBy(sql`comments DESC`)
      .limit(limit) // Use the dynamic limit
      .execute();

    return c.json({
      status: '200 OK',
      data: topCommentedVideos,
    }, 200);
  } catch (error) {
    console.error('Error fetching top commented videos:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching top commented videos.',
    }, 500);
  }
});

// Get the top most viewed video from each channel
app.get('/videos/top-channel-views', async (c) => {
  try {
    const db = getDbClient(c);

    // Subquery to get the latest video statistics for each video
    const latestVideoStatistics = db
      .select({
        videoId: videoStatistics.videoId,
        latestRecordedAt: sql`MAX(${videoStatistics.recordedAt})`.as('latestRecordedAt'),
      })
      .from(videoStatistics)
      .groupBy(videoStatistics.videoId)
      .as('latestVideoStatistics');

    // Main query to get the top viewed videos per channel
    const topViewedVideosPerChannel = await db
      .select({
        channelId: videos.channelId,
        channelName: channels.channelName, // Include channelName
        videoId: videos.id,
        title: videos.title,
        views: sql<number>`COALESCE(CAST(${videoStatistics.statistics}->>'viewCount' AS INTEGER), 0)`.as('views'),
      })
      .from(videos)
      .leftJoin(videoStatistics, eq(videos.id, videoStatistics.videoId))
      .leftJoin(
        latestVideoStatistics,
        and(
          eq(videoStatistics.videoId, latestVideoStatistics.videoId),
          eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
        )
      )
      .leftJoin(channels, eq(videos.channelId, channels.id)) // Join the channels table
      .where(and(
        eq(videoStatistics.videoId, latestVideoStatistics.videoId),
        eq(videoStatistics.recordedAt, latestVideoStatistics.latestRecordedAt)
      ))
      .orderBy(videos.channelId, sql`views DESC`)
      .execute();

    // Filter to get the top viewed video per channel
    const uniqueTopViewedVideos = topViewedVideosPerChannel.reduce((acc, video) => {
      if (!acc[video.channelId]) {
        acc[video.channelId] = video;
      }
      return acc;
    }, {} as Record<string, typeof topViewedVideosPerChannel[0]>);

    return c.json({
      status: '200 OK',
      data: Object.values(uniqueTopViewedVideos),
    }, 200);
  } catch (error) {
    console.error('Error fetching top viewed videos per channel:', { error });
    return c.json({
      status: '500 Internal Server Error',
      message: 'An error occurred while fetching top viewed videos per channel.',
    }, 500);
  }
});


app.get('/videos/search', async (c) => {
  try {
    const db = getDbClient(c);

    // Extract query parameters
    const query = c.req.query('q'); // Search query
    const pageQuery = c.req.query('page'); // Page number for pagination
    const limitQuery = c.req.query('limit'); // Number of items per page

    // Validate the search query
    if (!query) {
      return c.json(
        {
          status: '400 Bad Request',
          message: 'Search query (q) is required.',
        },
        400
      );
    }

    // Set default values for pagination
    const page = pageQuery ? parseInt(pageQuery) : 1; // Default to page 1
    const limit = limitQuery ? parseInt(limitQuery) : 10; // Default to 10 items per page
    const offset = (page - 1) * limit; // Calculate the offset

    // Search for videos whose titles match the query (case-insensitive)
    const searchResults = await db
      .select()
      .from(videos)
      .where(ilike(videos.title, `%${query}%`)) // Use ilike for case-insensitive search
      .orderBy(desc(videos.updatedAt)) // Order by updatedAt in descending order (newest first)
      .limit(limit)
      .offset(offset)
      .execute();

    // Count total matching videos for pagination metadata
    const totalResults = await db
      .select({ count: sql<number>`count(*)` })
      .from(videos)
      .where(ilike(videos.title, `%${query}%`))
      .execute();
    const totalCount = totalResults[0]?.count || 0;

    // Construct the response
    const response = {
      status: '200 OK',
      data: searchResults,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    };

    return c.json(response, 200);
  } catch (error) {
    console.error('Error searching videos:', { error });
    return c.json(
      {
        status: '500 Internal Server Error',
        message: 'An error occurred while searching videos.',
      },
      500
    );
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
    if (!ChannelDetails?.id || !ChannelDetails.customName || !ChannelDetails?.thumbnailHighUrl || !ChannelDetails?.uploads || !ChannelDetails?.followersCount || !ChannelDetails?.videoCount || !ChannelDetails?.viewsCount) {
      return c.text("Invalid input (either a YouTube URL or a username is required)", 400);
    }

    const videos = await getPlaylistVideos(apiKey, ChannelDetails.uploads);
    if (videos.length === 0) return c.text("No videos found in the playlist.");

    const videoIds = videos.map(video => video.videoId);
    const stats = await getVideoStatistics(apiKey, videoIds);

    const channel = await insertChannel(ChannelDetails.id, ChannelDetails.thumbnailHighUrl, ChannelDetails.uploads, ChannelDetails.followersCount, ChannelDetails.viewsCount, ChannelDetails.videoCount, ChannelDetails.customName, c);
    await insertVideos(videos, ChannelDetails.id, c);
    const insertedVideoStatisticsCount = await insertVideoStatistics(stats, c);

    // Invalidate the cache by deleting the `channelStatistics` key
    await c.env.youtube_cache.delete('channelStatistics');

    const endTime = Date.now();
    const elapsedTime = endTime - startTime;

    return c.json({
      status: '200 OK',
      elapsedTime: `${elapsedTime}ms`,
      insertedCount: insertedVideoStatisticsCount,
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