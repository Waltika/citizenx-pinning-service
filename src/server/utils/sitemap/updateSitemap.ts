import fs from "fs";
import {sitemapPath} from "../../config/index.js";
import {sitemapUrls} from "./addAnnotationsToSitemap.js";
import {generateSitemap} from "./generateSitemap.js";

export function updateSitemap(): void {
    try {
        fs.writeFileSync(sitemapPath, generateSitemap());
        console.log('Sitemap updated successfully at', sitemapPath, 'with', sitemapUrls.size, 'URLs');
    } catch (error) {
        console.error('Failed to update sitemap at', sitemapPath, ':', error);
    }
}
