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
    author: string; // Optional to handle incomplete Gun.js data
    content: string;
    id: string;
    url: string;
    text?: string;
    timestamp: number;
    comments: Comment[]; // Optional, defaults to []
    isDeleted?: boolean;
    screenshot?: string | null;
    signature?: string;
    nonce?: string;
    metadata?: {
        title: string;
        favicon: string | null;
        ogTitle: string | null;
        ogDescription: string | null;
        ogImage: string | null;
        twitterTitle: string | null;
        twitterDescription: string | null;
        twitterImage: string | null;
    };
    originalUrl?: string;
}

export interface SitemapEntry {
    url: string;
    timestamp: number;
    title?: string;
    anchorText?: string;
}