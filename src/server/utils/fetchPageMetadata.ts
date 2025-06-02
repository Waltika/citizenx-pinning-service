import axios from 'axios';
import * as cheerio from 'cheerio';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import { Metadata } from './types.js';

// Create a JSDOM instance and configure DOMPurify
const { window } = new JSDOM('');
// Use any as a fallback type assertion to bypass TypeScript error
const purify = DOMPurify(window as any);

export async function fetchPageMetadata(url: string): Promise<Metadata> {
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const cleanHtml = purify.sanitize(response.data);
        const $ = cheerio.load(cleanHtml);

        const metadata: Metadata = {
            title: $('title').text() || 'Untitled Page',
            favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || `${new URL(url).origin}/favicon.ico`,
            ogTitle: $('meta[property="og:title"]').attr('content') || null,
            ogDescription: $('meta[property="og:description"]').attr('content') || null,
            ogImage: $('meta[property="og:image"]').attr('content') || null,
            twitterTitle: $('meta[name="twitter:title"]').attr('content') || null,
            twitterDescription: $('meta[name="twitter:description"]').attr('content') || null,
            twitterImage: $('meta[name="twitter:image"]').attr('content') || null,
        };

        if (metadata.favicon && !metadata.favicon.startsWith('http')) {
            metadata.favicon = new URL(metadata.favicon, url).href;
        }

        return metadata;
    } catch (error: any) {
        console.error(`Failed to fetch metadata for ${url}:`, error.message);
        return {
            title: 'Untitled Page',
            favicon: null,
            ogTitle: null,
            ogDescription: null,
            ogImage: null,
            twitterTitle: null,
            twitterDescription: null,
            twitterImage: null,
        };
    }
}