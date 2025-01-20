interface YouTubeChannelResponse {
    kind: string;
    etag: string;
    pageInfo: {
        totalResults: number;
        resultsPerPage: number;
    };
    items: Array<{
        kind: string;
        etag: string;
        id: string; // Save the channel ID
        snippet: {
            title: string;
            description: string;
            customUrl: string;
            publishedAt: string;
            thumbnails: {
                default: {
                    url: string;
                    width: number;
                    height: number;
                };
                medium: {
                    url: string;
                    width: number;
                    height: number;
                };
                high: {
                    url: string;
                    width: number;
                    height: number;
                };
            };
            localized: {
                title: string;
                description: string;
            };
            country: string;
        };
        contentDetails: {
            relatedPlaylists: {
                likes: string;
                uploads: string; // Save the uploads playlist ID
            };
        };
        statistics: {
            viewCount: string;
            subscriberCount: string;
            hiddenSubscriberCount: boolean;
            videoCount: string;
        };
    }>;
}

interface PlaylistItemResponse {
    kind: string;
    etag: string;
    nextPageToken: string | undefined;
    items: Array<{
        kind: string;
        etag: string;
        id: string;
        snippet: {
            publishedAt: string;
            channelId: string;
            title: string;
            description: string;
            thumbnails: {
                default: {
                    url: string;
                    width: number;
                    height: number;
                };
                medium: {
                    url: string;
                    width: number;
                    height: number;
                };
                high: {
                    url: string;
                    width: number;
                    height: number;
                };
                standard?: {
                    url: string;
                    width: number;
                    height: number;
                };
                maxres?: {
                    url: string;
                    width: number;
                    height: number;
                };
            };
            channelTitle: string;
            playlistId: string;
            position: number;
            resourceId: {
                kind: string;
                videoId: string;
            };
            videoOwnerChannelTitle: string;
            videoOwnerChannelId: string;
        };
    }>;
}

interface VideoStatisticsResponse {
    kind: string;
    etag: string;
    items: Array<{
        kind: string;
        etag: string;
        id: string;
        statistics: {
            viewCount: string;
            likeCount: string;
            favoriteCount: string;
            commentCount: string;
        };
    }>;
    pageInfo: {
        totalResults: number;
        resultsPerPage: number;
    };
}