interface Channel {
    id: string;
    channelName: string;
    thumbnail: string | null; // Allow null
    channelUploadID: string;
    createdAt: Date; // Use Date instead of string
    updatedAt: Date; // Use Date instead of string
}

interface Video {
    id: string;
    channelId: string;
    title: string;
    url: string;
    thumbnailUrl: string;
    createdAt: Date; // Use Date instead of string
    updatedAt: Date; // Use Date instead of string
}

interface VideoStatistics {
    id: string | null; // Allow null
    videoId: string;
    statistics: Record<string, unknown>; // Use a generic object for JSONB
    recordedAt: Date; // Use Date instead of string
}

interface AllDataResponse {
    channels: Channel[];
    videos: Video[];
    videoStatistics: VideoStatistics[];
}

interface Pagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

interface AllVideoResponse {
    videos: Video[];
    pagination: Pagination; // Add pagination to the response
}


interface VideoWithStatistics {
    id: string;
    channelId: string;
    title: string;
    url: string;
    thumbnailUrl: string;
    createdAt: Date;
    updatedAt: Date;
    statistics: {
        id: string | null; // Allow null
        videoId: string;
        statistics: Record<string, unknown>;
        recordedAt: Date;
    }[];
}