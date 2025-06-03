import {Express, Request, Response} from "express";
import {sitemapUrls} from "../utils/sitemap/addAnnotationsToSitemap.js";
import fs from "fs";
import {sitemapPath} from "../config/index.js";
import {serveSitemap} from "../utils/sitemap/serveSitemap.js";

export function setupSitemapRoute(app : Express) {
// Serve sitemap.xml
    app.get('/sitemap.xml', (_req: Request, res: Response) => {
        try {
            console.log(`Serving sitemap.xml, in-memory sitemapUrls size: ${sitemapUrls.size}, URLs:`, Array.from(sitemapUrls).map(entry => entry.url));
            let sitemapContent: string;
            if (fs.existsSync(sitemapPath)) {
                sitemapContent = serveSitemap();
                console.log(`Generated sitemap with root URL, content length: ${sitemapContent.length} bytes`);
            } else {
                console.warn(`Sitemap file not found at ${sitemapPath}, generating dynamically`);
                sitemapContent = serveSitemap();
                console.log(`Generated dynamic sitemap with root URL, content length: ${sitemapContent.length} bytes`);
            }
            res.set('Content-Type', 'application/xml');
            res.send(sitemapContent);
            console.log('Served sitemap.xml with', sitemapUrls.size, 'URLs plus root URL');
        } catch (error) {
            console.error('Error serving sitemap.xml:', error);
            res.status(500).send('Internal server error');
        }
    });
}