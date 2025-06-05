import {addAnnotationToSitemap, sitemapUrls} from './sitemap/addAnnotationsToSitemap.js';
import {updateSitemap} from './sitemap/updateSitemap.js';
import fs from 'fs';
import {publicUrl, sitemapPath} from '../config/index.js';
import xml2js from 'xml2js';

export async function bootstrapSitemap(gun: any): Promise<void> {
    console.log('Bootstrapping sitemap with existing annotations...');
    try {
        const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
        let totalAnnotations = 0;

        const domains: string[] = ['x_com'];
        await new Promise<void>((resolve) => {
            gun.get('').map().once((_data: any, key: string) => {
                if (!key || key.length === 0) {
                    console.warn(`Skipping invalid key: ${key}`);
                    return;
                }
                console.log(`Top-level node: ${key}`);
                if (key.startsWith('annotations_') && !key.includes('_shard_')) {
                    const domain = key.replace('annotations_', '');
                    if (!domains.includes(domain)) {
                        domains.push(domain);
                        console.log(`Discovered domain: ${domain}`);
                    }
                }
            });
            setTimeout(resolve, 60000);
        });

        console.log('Found domains:', domains);

        for (const domain of domains) {
            const domainShard = `annotations_${domain}`;
            console.log(`Scanning domain shard: ${domainShard}`);
            const isHighTraffic = highTrafficDomains.includes(domain);
            const shards = [domainShard];
            if (isHighTraffic) {
                shards.push(...Array.from({length: 10}, (_, i) => `${domainShard}_shard_${i}`));
            }

            for (const shard of shards) {
                console.log(`Processing shard: ${shard}`);
                await new Promise<void>((resolve) => {
                    gun.get(shard).map().once((urlData: any, url: string) => {
                        if (!url || url === '_' || !urlData || typeof urlData !== 'object') {
                            console.log(`No valid URL data in shard: ${shard}, URL: ${url}`);
                            return;
                        }
                        console.log(`Found URL node: ${url}`);
                        gun.get(shard).get(url).map().once((annotation: any, annotationId: string) => {
                            if (annotation && typeof annotation === 'object' && !annotation.id) {
                                console.log(`Adding ID to annotation in ${shard}, ID: ${annotationId}, data:`, annotation);
                                annotation.id = annotationId;
                            }

                            if (!annotationId || !annotation || annotation.isDeleted || !annotation.id || !annotation.url || !annotation.timestamp) {
                                console.log(`Skipped invalid annotation in ${shard}, ID: ${annotationId}, data:`, annotation);
                                return;
                            }
                            addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
                            totalAnnotations++;
                        });
                    });
                    setTimeout(() => {
                        console.log(`Completed scan of shard: ${shard}, found ${totalAnnotations} annotations so far`);
                        resolve();
                    }, 120000);
                });
            }
        }
        updateSitemap();
        console.log('Sitemap bootstrap completed with', sitemapUrls.size, 'URLs');
    } catch (error) {
        console.error('Error bootstrapping sitemap:', error);
    }
}

// Load sitemapUrls from sitemap.xml on disk
export async function loadSitemapFromDisk(): Promise<void> {
    if (!fs.existsSync(sitemapPath)) {
        console.log('No sitemap file found, starting with empty sitemapUrls');
        return;
    }

    try {
        const xmlContent = fs.readFileSync(sitemapPath, 'utf8');
        const parser = new xml2js.Parser({explicitArray: false});
        const result = await parser.parseStringPromise(xmlContent);
        let urls = result.urlset.url || [];
        sitemapUrls.clear();

        if (!Array.isArray(urls)) {
            urls = [urls];
        }

        for (const url of urls) {
            const loc = url.loc;
            const lastmod = url.lastmod ? new Date(url.lastmod).getTime() : Date.now();
            const title = url['citizenx:title']; // Optional, for compatibility with past attempts
            const anchorText = url['citizenx:anchorText']; // Optional
            if (loc && loc !== `${publicUrl}/`) {
                sitemapUrls.add({url: loc, timestamp: lastmod});
                console.log(`Loaded sitemap entry: ${loc}, Timestamp: ${new Date(lastmod).toISOString()}, Title: ${title || 'none'}, AnchorText: ${anchorText || 'none'}`);
            }
        }
        console.log('Loaded', sitemapUrls.size, 'URLs from sitemap.xml');
    } catch (error) {
        console.error('Error loading sitemapUrls from sitemap.xml:', error);
    }
}

export async function bootstrapSiteMapIfNotExist(gun: any) {
    if (!fs.existsSync(sitemapPath)) {
        console.log('No sitemap file found, running bootstrapSitemap...');
        await bootstrapSitemap(gun);
        console.log('Bootstrap sitemap completed with', sitemapUrls.size, 'URLs');
    } else {
        console.log('Sitemap file exists, loading sitemapUrls from disk...');
        await loadSitemapFromDisk();
        console.log('Loaded sitemapUrls with', sitemapUrls.size, 'URLs');
    }
}