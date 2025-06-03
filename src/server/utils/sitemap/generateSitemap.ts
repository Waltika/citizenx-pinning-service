import {sitemapUrls} from "./addAnnotationsToSitemap.js";

export function generateSitemap(): string {
    // Only include annotation URLs, exclude root URL
    const annotationUrls = Array.from(sitemapUrls)
        .map(entry => `
        <url>
            <loc>${entry.url}</loc>
            <lastmod>${new Date(entry.timestamp).toISOString()}</lastmod>
            <changefreq>daily</changefreq>
            <priority>0.8</priority>
        </url>`).join('');

    // noinspection HttpUrlsUsage
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${annotationUrls}
</urlset>`;
}