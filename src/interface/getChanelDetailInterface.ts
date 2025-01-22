interface ChannelDetails {
    uploads: string | null;
    id: string | null;
    customName: string | null,
    viewsCount: number | null,
    followersCount: number | null,
    videoCount: number | null,
    thumbnailHighUrl: string | null;
}

interface VideoDetails {
    videoId: string;
    videoTitle: string;
    thumbnailUrl: string | undefined;
}