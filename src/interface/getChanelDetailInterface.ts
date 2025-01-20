interface ChannelDetails {
    uploads: string | null;
    id: string | null;
    customName: string | null,
    thumbnailHighUrl: string | null;
}

interface VideoDetails {
    videoId: string;
    videoTitle: string;
    thumbnailUrl: string | undefined;
}