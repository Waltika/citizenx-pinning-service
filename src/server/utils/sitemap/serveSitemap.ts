import { sitemapUrls } from "./addAnnotationsToSitemap.js";
import { publicUrl } from "../../config/index.js";

export function serveSitemap(): string {
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