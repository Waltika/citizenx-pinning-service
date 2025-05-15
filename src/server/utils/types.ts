export interface Metadata {
    title: string;
    favicon: string | null;
    ogTitle: string | null | undefined;
    ogDescription: string | null | undefined;
    ogImage: string | null | undefined;
    twitterTitle: string | null | undefined;
    twitterDescription: string | null | undefined;
    twitterImage: string | null | undefined;
}

export interface Annotation {
    id: string;
    url: string;
    content: string;
    author: string;
    timestamp: number;
    isDeleted?: boolean;
    screenshot?: string;
    metadata?: Record<string, any>;
}