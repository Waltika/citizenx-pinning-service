import fs from 'fs';
import { baseDataDir, publicUrl } from '../../config/index.js';
import { queueIndexNowUrls, submitIndexNowUrls } from './indexnow.js';
import {generateSitemap} from "./generateSitemap.js";

export interface SitemapEntry {
    url: string;
    timestamp: number;
}

export const sitemapUrls: Set<SitemapEntry> = new Set();
const sitemapPath = `${baseDataDir}/sitemap.xml`;

function updateSitemap(): void {
    try {
        fs.writeFileSync(sitemapPath, generateSitemap());
        console.log('Sitemap updated successfully at', sitemapPath, 'with', sitemapUrls.size, 'URLs');
        // Submit queued URLs to IndexNow after sitemap update
        submitIndexNowUrls().catch(err => console.error('[IndexNow] Submission error:', err));
    } catch (error) {
        console.error('Failed to update sitemap at', sitemapPath, ':', error);
    }
}

// Helper to add annotation to sitemap
export function addAnnotationToSitemap(annotationId: string, annotationUrl: string, timestamp: number): void {
    const base64Url = Buffer.from(annotationUrl).toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
    const sitemapUrl = `${publicUrl}/${annotationId}/${base64Url}`;
    if (sitemapUrl === `${publicUrl}/` || annotationId === 'undefined') {
        console.log(`Skipped adding invalid or homepage to sitemapUrls: ${sitemapUrl}`);
        return;
    }
    const existingEntry = Array.from(sitemapUrls).find(entry => entry.url === sitemapUrl);
    if (!existingEntry) {
        sitemapUrls.add({url: sitemapUrl, timestamp});
        queueIndexNowUrls([sitemapUrl]); // Queue for IndexNow
        updateSitemap();
        console.log(`Added annotation to sitemap: ${sitemapUrl}, Timestamp: ${new Date(timestamp).toISOString()}`);
    } else if (existingEntry.timestamp !== timestamp) {
        sitemapUrls.delete(existingEntry);
        sitemapUrls.add({url: sitemapUrl, timestamp});
        queueIndexNowUrls([sitemapUrl]); // Queue for IndexNow
        updateSitemap();
        console.log(`Updated annotation timestamp in sitemap: ${sitemapUrl}, New Timestamp: ${new Date(timestamp).toISOString()}`);
    }
}

// ... rest of the file (generateSitemap, etc.) remains unchanged