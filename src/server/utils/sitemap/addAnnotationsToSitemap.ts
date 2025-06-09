import fs from 'fs';
import { baseDataDir, publicUrl } from '../../config/index.js';
import { queueIndexNowUrls, submitIndexNowUrls } from './indexnow.js';
import { SitemapEntry } from '../../types/types.js';

export const sitemapUrls: Set<SitemapEntry> = new Set();
const sitemapPath = `${baseDataDir}/sitemap.xml`;

function generateSitemap(): string {
    let sitemapDate: Date | null = null;
    Array.from(sitemapUrls).forEach(entry => {
        let annotationDate: Date = new Date(entry.timestamp);
        if (sitemapDate == null || annotationDate > sitemapDate) {
            sitemapDate = annotationDate;
        }
    });

    if (sitemapDate == null) {
        sitemapDate = new Date();
    }
    const homepageUrl = `
    <url>
        <loc>${publicUrl}/</loc>
        <lastmod>${sitemapDate.toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.6</priority>
    </url>`;

    const annotationUrls = Array.from(sitemapUrls)
        .map(entry => `
        <url>
            <loc>${entry.url}</loc>
            <lastmod>${new Date(entry.timestamp).toISOString()}</lastmod>
            <changefreq>daily</changefreq>
            <priority>0.8</priority>
        </url>`).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${homepageUrl}
${annotationUrls}
</urlset>`;
}

function updateSitemap(): void {
    try {
        fs.writeFileSync(sitemapPath, generateSitemap());
        console.log('Sitemap updated successfully at', sitemapPath, 'with', sitemapUrls.size, 'URLs');
        submitIndexNowUrls().catch(err => console.error('[IndexNow] Submission error:', err));
    } catch (error) {
        console.error('Failed to update sitemap at', sitemapPath, ':', error);
    }
}

export async function addAnnotationToSitemap(annotationId: string, annotationUrl: string, timestamp: number): Promise<void> {
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
        queueIndexNowUrls([sitemapUrl]);
        updateSitemap();
        console.log(`Added annotation to sitemap: ${sitemapUrl}, Timestamp: ${new Date(timestamp).toISOString()}`);
    } else if (existingEntry.timestamp !== timestamp ) {
        sitemapUrls.delete(existingEntry);
        sitemapUrls.add({url: sitemapUrl, timestamp});
        queueIndexNowUrls([sitemapUrl]);
        updateSitemap();
        console.log(`Updated annotation in sitemap: ${sitemapUrl}, New Timestamp: ${new Date(timestamp).toISOString()}`);
    }
}