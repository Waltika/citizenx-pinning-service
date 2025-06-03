import {Express, Request, Response} from "express";
import {sitemapUrls} from "../utils/sitemap/addAnnotationsToSitemap.js";
import {bootstrapSitemap} from "../utils/bootstrapSitemap.js";

export function setupRebuildSitemapRoute(app: Express, gun: any) {
    app.get('/api/debug/rebuild-sitemap', async (_req: Request, res: Response) => {
        console.log('Rebuilding sitemap via debug endpoint...');
        sitemapUrls.clear();
        await bootstrapSitemap(gun);
        res.json({message: 'Sitemap rebuilt successfully', urlCount: sitemapUrls.size});
        console.log('Debug sitemap rebuild completed with', sitemapUrls.size, 'URLs');
    });
}