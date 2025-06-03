// Helper to add annotation to sitemap
import {publicUrl, sitemapPath} from "../../config/index.js";
import {updateSitemap} from "./updateSitemap.js";
import fs from "fs";

interface SitemapEntry {
    url: string;
    timestamp: number; // Store annotation timestamp
}

export let sitemapUrls: Set<SitemapEntry> = new Set();

// Load existing sitemap on startup
try {
    if (fs.existsSync(sitemapPath)) {
        const sitemapContent = fs.readFileSync(sitemapPath, 'utf8');
        // Match <url> entries with flexible content
        const urlEntries = sitemapContent.match(/<url>\s*([\s\S]*?)\s*<\/url>/g) || [];
        const urls = urlEntries.map(entry => {
            const locMatch = entry.match(/<loc>(.*?)<\/loc>/);
            const lastmodMatch = entry.match(/<lastmod>(.*?)<\/lastmod>/);
            const url = locMatch ? locMatch[1] : null;
            let timestamp = Date.now(); // Fallback
            if (lastmodMatch) {
                const parsedDate = new Date(lastmodMatch[1]);
                timestamp = isNaN(parsedDate.getTime()) ? Date.now() : parsedDate.getTime();
            }
            return url && url !== `${publicUrl}/` ? {url, timestamp} : null;
        }).filter(item => item !== null); // Exclude root URL and invalid entries
        sitemapUrls = new Set(urls);
        console.log('Loaded existing sitemap from', sitemapPath, 'with', sitemapUrls.size, 'URLs');
    } else {
        console.log('No existing sitemap found at', sitemapPath, ', starting with empty sitemap');
    }
} catch (error) {
    console.error('Failed to load existing sitemap from', sitemapPath, ':', error);
}

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
        updateSitemap();
        console.log(`Added annotation to sitemap: ${sitemapUrl}, Timestamp: ${new Date(timestamp).toISOString()}`);
    } else if (existingEntry.timestamp !== timestamp) {
        sitemapUrls.delete(existingEntry);
        sitemapUrls.add({url: sitemapUrl, timestamp});
        updateSitemap();
        console.log(`Updated annotation timestamp in sitemap: ${sitemapUrl}, New Timestamp: ${new Date(timestamp).toISOString()}`);
    }
}