import axios from 'axios';
import {publicUrl} from '../../config/index.js';

// Store URLs to submit to IndexNow
export const indexNowQueue: Set<string> = new Set();
const indexNowKey: string = "d6b0cd09f4a44948a481da04f60b1655";

// Get IndexNow key
export function getIndexNowKey(): string {
    return indexNowKey;
}

// Queue URLs for IndexNow submission
export function queueIndexNowUrls(urls: string[]): void {
    urls.forEach(url => indexNowQueue.add(url));
    console.log(`[IndexNow] Queued ${urls.length} URLs, total in queue: ${indexNowQueue.size}`);
}

// Submit queued URLs to IndexNow
export async function submitIndexNowUrls(): Promise<void> {
    if (indexNowQueue.size === 0) {
        console.log(`[IndexNow] No URLs to submit`);
        return;
    }

    const key = getIndexNowKey();
    const urls = Array.from(indexNowQueue).slice(0, 10000); // IndexNow limit
    const payload = {
        host: new URL(publicUrl).hostname,
        key,
        keyLocation: `${publicUrl}/${key}.txt`,
        urlList: urls
    };

    try {
        const response = await axios.post('https://www.bing.com/indexnow', payload, {
            headers: {'Content-Type': 'application/json'}
        });
        console.log(`[IndexNow] Submitted ${urls.length} URLs, status: ${response.status}`);
        // Clear submitted URLs
        urls.forEach(url => indexNowQueue.delete(url));
    } catch (error) {
        console.error(`[IndexNow] Failed to submit URLs:`, error);
    }
}