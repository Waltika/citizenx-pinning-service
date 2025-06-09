import { Express, Request, Response } from "express";
import { appendUtmParams } from "../utils/appendUtmParams.js";
import { getProfileWithRetries } from "../data/getProfileWithRetries.js";
import { publicUrl } from "../config/index.js";
import { getShardKey } from "../utils/shardUtils.js";
import { fromUrlSafeBase64 } from "../utils/fromUrlSafeBase64.js";
import { sitemapUrls } from "../utils/sitemap/addAnnotationsToSitemap.js";
import { Annotation } from "../types/types.js";
import { Mutex } from "async-mutex"; // Add this import

// Simplified type for GUN metadata (the "_" key)
interface GUNMetadata {
    '#'?: string;
    '>'?: Record<string, number>;
    [key: string]: any;
}

// Cache for recent annotations and profiles
const recentAnnotationsCache: Array<{
    id: string;
    relativeUrl: string;
    title: string;
    anchorText: string;
    author: string;
    handle: string;
    timestamp: number;
    screenshot?: string;
}> = [];
const profileCache = new Map<string, { handle: string }>();
const MAX_CACHED_ANNOTATIONS = 30;

// Mutex to synchronize access to recentAnnotationsCache
const cacheMutex = new Mutex();

// Track subscribed domains and shards
const subscribedDomains = new Set<string>();
const subscribedShards = new Set<string>();

// Extract domains from sitemapUrls
function getDomainsFromSitemap(): string[] {
    const domains = new Set<string>();

    for (const entry of sitemapUrls) {
        try {
            // Parse URL (e.g., https://service.citizenx.app/[id]/[base64Url])
            const urlParts = entry.url.split('/');
            const base64Url = urlParts[urlParts.length - 1];
            const standardBase64 = fromUrlSafeBase64(base64Url);
            const originalUrl = Buffer.from(standardBase64, 'base64').toString('utf8');
            const urlObj = new URL(originalUrl);
            const domain = urlObj.hostname.replace(/\./g, '_');

            if (!domains.has(domain)) {
                domains.add(domain);
                console.log(`[DEBUG] Extracted domain from sitemap: ${domain}`);
            }
        } catch (error) {
            console.error(`[DEBUG] Error extracting domain from sitemap entry ${entry.url}:`, error);
        }
    }

    return Array.from(domains);
}

export async function cacheNewAnnotation(annotation: Annotation, gun: any, shard: string) {
    const release = await cacheMutex.acquire(); // Acquire mutex
    try {
        const annotationId = annotation.id;
        if (annotation.isDeleted) {
            const existingIndex = recentAnnotationsCache.findIndex(a => a.id === annotationId);
            if (existingIndex >= 0) {
                recentAnnotationsCache.splice(existingIndex, 1);
                console.log(`[DEBUG] Removed deleted annotation ${annotationId} from cache, cache size: ${recentAnnotationsCache.length}`);
            }
            return;
        }

        const existingIndex = recentAnnotationsCache.findIndex(a => a.id === annotationId);
        if (existingIndex !== -1) return;

        const base64Url = Buffer.from(annotation.url).toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=/g, '');

        let profile = profileCache.get(annotation.author);
        if (!profile) {
            // Defer profile fetching to break the call stack
            setImmediate(async () => {
                try {
                    const releaseInner = await cacheMutex.acquire(); // Re-acquire mutex for async operation
                    try {
                        profile = await getProfileWithRetries(gun, annotation.author);
                        profileCache.set(annotation.author, { handle: profile.handle || 'Anonymous' });

                        // Add annotation to cache if still not present
                        const recheckIndex = recentAnnotationsCache.findIndex(a => a.id === annotationId);
                        if (recheckIndex !== -1) return;

                        const newEntry = {
                            id: annotation.id,
                            relativeUrl: `/${annotation.id}/${base64Url}`,
                            title: annotation.title || 'Untitled Annotation',
                            anchorText: annotation.anchorText || 'View Annotation',
                            author: annotation.author,
                            handle: profile.handle || 'Anonymous',
                            timestamp: annotation.timestamp,
                            screenshot: `/image/${annotation.id}/${base64Url}/image.png`
                        };
                        recentAnnotationsCache.push(newEntry);
                        recentAnnotationsCache.sort((a, b) => b.timestamp - a.timestamp);
                        recentAnnotationsCache.splice(MAX_CACHED_ANNOTATIONS);
                        console.log(`[DEBUG] Added annotation ${annotationId} to cache from shard ${shard}, cache size: ${recentAnnotationsCache.length}`);
                    } finally {
                        releaseInner(); // Release inner mutex
                    }
                } catch (error) {
                    console.error(`[DEBUG] Error fetching profile for ${annotation.author}:`, error);
                }
            });
        } else {
            // Add annotation to cache synchronously if profile is cached
            const newEntry = {
                id: annotation.id,
                relativeUrl: `/${annotation.id}/${base64Url}`,
                title: annotation.title || 'Untitled Annotation',
                anchorText: annotation.anchorText || 'View Annotation',
                author: annotation.author,
                handle: profile.handle || 'Anonymous',
                timestamp: annotation.timestamp,
                screenshot: `/image/${annotation.id}/${base64Url}/image.png`
            };
            recentAnnotationsCache.push(newEntry);
            recentAnnotationsCache.sort((a, b) => b.timestamp - a.timestamp);
            recentAnnotationsCache.splice(MAX_CACHED_ANNOTATIONS);
            console.log(`[DEBUG] Added annotation ${annotationId} to cache from shard ${shard}, cache size: ${recentAnnotationsCache.length}`);
        }
    } finally {
        release(); // Release mutex
    }
}

// Set up real-time updates for a specific domain
function setupRealtimeUpdatesForDomain(gun: any, domain: string) {
    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
    const domainShard = `annotations_${domain}`;
    const isHighTraffic = highTrafficDomains.includes(domain);
    const shards = [domainShard];
    if (isHighTraffic) {
        shards.push(...Array.from({ length: 10 }, (_, i) => `${domainShard}_shard_${i}`));
    }

    for (const shard of shards) {
        if (subscribedShards.has(shard)) continue;
        subscribedShards.add(shard);
        console.log(`[DEBUG] Subscribing to shard for real-time updates: ${shard}`);

        // Use a single on listener to reduce callback nesting
        gun.get(shard).on((shardData: Record<string, Record<string, Annotation> | GUNMetadata>) => {
            if (!shardData || typeof shardData !== 'object') return;

            // Iterate over URLs in the shard
            Object.entries(shardData).forEach(([url, urlData]) => {
                if (url === '_' || !url || !urlData || typeof urlData !== 'object') return;

                // Determine the correct shard for this URL
                const { domainShard: computedDomainShard, subShard } = getShardKey(url);
                const targetShard = subShard || computedDomainShard;
                if (targetShard !== shard) return; // Skip if this URL belongs to a different shard

                // Iterate over annotations for this URL
                Object.entries(urlData as Record<string, Annotation>).forEach(async ([annotationId, annotation]) => {
                    if (annotationId === '_' || !annotation || typeof annotation !== 'object') return;
                    if (annotation.isDeleted || !annotation.id || !annotation.url || !annotation.timestamp) return;
                    cacheNewAnnotation(annotation, gun, shard);
                });
            });
        });
    }
}

// Public method to subscribe to a new domain from a URL
export function subscribeToNewDomain(gun: any, url: string) {
    try {
        const urlObj = new URL(url);
        const domain = urlObj.hostname; // e.g., youtube.com
        const normalizedDomain = domain.replace(/\./g, '_'); // e.g., youtube_com
        if (subscribedDomains.has(normalizedDomain)) {
            console.log(`[DEBUG] Already subscribed to domain: ${normalizedDomain}`);
            return;
        }
        subscribedDomains.add(normalizedDomain);
        console.log(`[DEBUG] Adding real-time subscription for new domain: ${normalizedDomain}`);
        setupRealtimeUpdatesForDomain(gun, normalizedDomain);
    } catch (error) {
        console.error(`[DEBUG] Error extracting domain from URL ${url}:`, error);
    }
}

export function setupHomepageRoute(app: Express, gun: any) {
    // Initialize cache on server start
    const initializeCache = async (domains: string[]) => {
        console.log('[DEBUG] Initializing homepage cache with domains:', domains);
        try {
            const annotationsMap = new Map<string, any>();
            const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];

            // Fetch annotations from all shards
            for (const domain of domains) {
                const domainShard = `annotations_${domain}`;
                const isHighTraffic = highTrafficDomains.includes(domain);
                const shards = [domainShard];
                if (isHighTraffic) {
                    shards.push(...Array.from({ length: 10 }, (_, i) => `${domainShard}_shard_${i}`));
                }

                for (const shard of shards) {
                    console.log(`[DEBUG] Starting fetch for shard: ${shard}`);

                    // Fetch all URLs under the shard
                    const urls: Set<string> = new Set();
                    await new Promise<void>((resolve) => {
                        let processed = false;
                        const timeout = setTimeout(() => {
                            console.warn(`[DEBUG] Timeout after 30 seconds fetching URLs for shard: ${shard}, found ${urls.size} URLs`);
                            processed = true;
                            resolve();
                        }, 30000);

                        gun.get(shard).map().once((urlData: any, url: string) => {
                            if (processed) return; // Skip if already timed out

                            if (url === '_' || !url || !urlData || typeof urlData !== 'object') {
                                console.log(`[DEBUG] Skipping invalid URL data in shard: ${shard}, URL: ${url}, urlData: ${urlData}`);
                                return;
                            }

                            console.log(`[DEBUG] Found URL in shard: ${shard}, URL: ${url}`);
                            urls.add(url);

                            // Check if we've received enough data
                            if (urls.size > 0) {
                                // Wait a bit longer for more URLs
                                setTimeout(() => {
                                    if (!processed) {
                                        console.log(`[DEBUG] Collected ${urls.size} URLs for shard: ${shard}, proceeding`);
                                        clearTimeout(timeout);
                                        processed = true;
                                        resolve();
                                    }
                                }, 5000); // Wait 5 seconds for more URLs
                            }
                        });
                    });

                    // Fetch annotations for each URL
                    let urlCount = 0;
                    let annotationCount = 0;
                    for (const url of urls) {
                        urlCount++;
                        await new Promise<void>((resolve) => {
                            let urlProcessed = false;
                            const urlTimeout = setTimeout(() => {
                                console.warn(`[DEBUG] Timeout after 20 seconds fetching annotations for URL: ${url} in shard: ${shard}`);
                                urlProcessed = true;
                                resolve();
                            }, 20000);

                            gun.get(shard).get(url).map().once((annotation: Annotation, annotationId: string) => {
                                if (urlProcessed) return;

                                if (annotationId === '_' || !annotation || typeof annotation !== 'object') {
                                    console.log(`[DEBUG] Skipping invalid annotation in shard: ${shard}, URL: ${url}, ID: ${annotationId}`);
                                    return;
                                }
                                if (annotation.isDeleted || !annotation.id || !annotation.url || !annotation.timestamp) {
                                    console.log(`[DEBUG] Skipping deleted or invalid annotation in shard: ${shard}, URL: ${url}, ID: ${annotationId}`);
                                    return;
                                }
                                annotationCount++;
                                console.log(`[DEBUG] Found annotation in shard: ${shard}, URL: ${url}, ID: ${annotationId}, adding to annotationsMap`);
                                annotationsMap.set(annotationId, { ...annotation, shard });

                                // Wait a bit longer for more annotations
                                setTimeout(() => {
                                    if (!urlProcessed) {
                                        console.log(`[DEBUG] Collected ${annotationCount} annotations for URL: ${url} in shard: ${shard}, proceeding`);
                                        clearTimeout(urlTimeout);
                                        urlProcessed = true;
                                        resolve();
                                    }
                                }, 2000); // Wait 2 seconds for more annotations
                            });
                        });
                    }
                    console.log(`[DEBUG] Completed shard ${shard}: ${urlCount} URLs, ${annotationCount} valid annotations`);
                }
            }

            // Sort and limit to top 30 by timestamp
            const sortedAnnotations = Array.from(annotationsMap.values())
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, MAX_CACHED_ANNOTATIONS);

            // Populate cache
            for (const annotation of sortedAnnotations) {
                const base64Url = Buffer.from(annotation.url).toString('base64')
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=/g, '');
                const profile = await getProfileWithRetries(gun, annotation.author);
                const handle = profile.handle || 'Anonymous';

                // Cache profile
                if (!profileCache.has(annotation.author)) {
                    profileCache.set(annotation.author, { handle });
                }

                recentAnnotationsCache.push({
                    id: annotation.id,
                    relativeUrl: `/${annotation.id}/${base64Url}`, // Relative path
                    title: annotation.title || 'Untitled Annotation',
                    anchorText: annotation.anchorText || 'View Annotation',
                    author: annotation.author,
                    handle,
                    timestamp: annotation.timestamp,
                    screenshot: `/image/${annotation.id}/${base64Url}/image.png`
                });
            }

            // Sort cache by timestamp
            recentAnnotationsCache.sort((a, b) => b.timestamp - a.timestamp);
            recentAnnotationsCache.splice(MAX_CACHED_ANNOTATIONS); // Keep only 30
            console.log(`[DEBUG] Initialized homepage cache with ${recentAnnotationsCache.length} annotations, total annotations found: ${annotationsMap.size}`);
        } catch (error) {
            console.error('[DEBUG] Error initializing homepage cache:', error);
        }
    };

    // Set up real-time updates for initial domains
    const setupRealtimeUpdates = (domains: string[]) => {
        console.log('[DEBUG] Setting up real-time updates for homepage cache with domains:', domains);
        domains.forEach(domain => {
            subscribedDomains.add(domain);
            setupRealtimeUpdatesForDomain(gun, domain);
        });
    };

    // Initialize cache and real-time updates using domains from sitemapUrls
    const domains = getDomainsFromSitemap();
    console.log('[DEBUG] Found domains from sitemap:', domains);
    initializeCache(domains).then(() => setupRealtimeUpdates(domains));

    app.get('/', async (req: Request, res: Response) => {
        console.log('[DEBUG] Serving homepage');

        // Serve from cache
        const recentAnnotations = recentAnnotationsCache.slice(); // Copy to avoid modifying cache

        // Generate annotation cards
        const recentAnnotationsHtml = recentAnnotations
            .map(annotation => `
                <article class="annotation-card">
                    <div class="annotation-header">
                        ${annotation.screenshot ? `
                            <a href="${annotation.relativeUrl}">
                                <img src="${annotation.screenshot}" alt="Annotation screenshot by ${annotation.handle}" class="thumbnail" loading="lazy">
                            </a>
                        ` : ''}
                        <div class="annotation-content">
                            <h3 class="annotation-title">
                                <a href="${annotation.relativeUrl}" class="annotation-link">${annotation.anchorText}</a>
                            </h3>
                            <p class="annotation-meta">
                                By <span class="annotation-author">${annotation.handle}</span> on 
                                ${new Date(annotation.timestamp).toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true
            })}
                            </p>
                        </div>
                    </div>
                </article>
            `)
            .join('');

        const ctaUrl = appendUtmParams('https://citizenx.app', req.query);
        const logoUrl = '/'; // Relative path to homepage

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Discover recent web annotations created with CitizenX. Join the conversation and annotate the web at citizenx.app.">
    <meta name="keywords" content="web annotations, CitizenX, collaborative commentary, social media annotations">
    <meta name="robots" content="index, follow">
    <title>CitizenX Annotations - Collaborative Web Commentary</title>
    <link rel="canonical" href="${publicUrl}/">
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <link rel="icon" href="/yandex-logo.png" type="image/x-icon">
    <meta property="og:title" content="CitizenX Annotations - Collaborative Web Commentary">
    <meta property="og:description" content="Discover recent web annotations created with CitizenX. Join the conversation and annotate the web at citizenx.app.">
    <meta property="og:image" content="${recentAnnotations[0]?.screenshot || 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png'}">
    <meta property="og:url" content="${publicUrl}/">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="CitizenX Annotations - Collaborative Web Commentary">
    <meta name="twitter:description" content="Discover recent web annotations created with CitizenX. Join the conversation and annotate the web at citizenx.app.">
    <meta name="twitter:image" content="${recentAnnotations[0]?.screenshot || 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png'}">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-YDDS5BJ90C"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-YDDS5BJ90C');
    </script>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 20px;
            line-height: 1.6;
            background-color: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
        }
        .container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            max-width: 800px;
            width: 100%;
            box-sizing: border-box;
            text-align: center;
        }
        .header {
            display: flex;
            justify-content: flex-start;
            align-items: center;
            margin-bottom: 20px;
        }
        .logo {
            width: 32px;
            height: 32px;
        }
        h1 {
            color: #333;
            font-size: 1.8rem;
            margin-bottom: 10px;
        }
        h2 {
            color: #333;
            font-size: 1.4rem;
            margin-bottom: 15px;
        }
        h3.annotation-title {
            color: #333;
            font-size: 1.2rem;
            margin: 0 0 5px;
        }
        p {
            color: #444;
            font-size: 1rem;
            margin-bottom: 10px;
        }
        .cta {
            display: inline-block;
            padding: 10px 20px;
            background-color: #000000;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 500;
            transition: background-color 0.3s ease;
        }
        .cta:hover {
            background-color: #393b3c;
        }
        .annotations {
            text-align: left;
            margin-top: 20px;
        }
        .annotation-card {
            background: #fff;
            border: 1px solid #e0e0e0;
            border-radius: 6px;
            padding: 15px;
            margin-bottom: 15px;
            transition: background-color 0.3s ease;
        }
        .annotation-card:hover {
            background-color: #f9f9f9;
        }
        .annotation-header {
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .thumbnail {
            width: 100px;
            height: 100px;
            object-fit: cover;
            border-radius: 4px;
        }
        .annotation-content {
            flex: 1;
        }
        .annotation-link {
            color: #333;
            text-decoration: none;
            font-weight: 500;
        }
        .annotation-link:hover {
            color: #7593f4;
            text-decoration: underline;
        }
        .annotation-meta {
            color: #666;
            font-size: 0.9rem;
            margin: 0;
        }
        .annotation-author {
            font-weight: bold;
        }
        @media (max-width: 600px) {
            body {
                padding: 10px;
            }
            .container {
                padding: 15px;
            }
            h1 {
                font-size: 1.5rem;
            }
            h2 {
                font-size: 1.2rem;
            }
            h3.annotation-title {
                font-size: 1rem;
            }
            p {
                font-size: 0.9rem;
            }
            .cta {
                padding: 8px 16px;
                font-size: 0.9rem;
            }
            .annotation-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 10px;
            }
            .thumbnail {
                margin-bottom: 10px;
            }
        }
        @media (min-width: 601px) {
            .container {
                margin: 0 auto;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <header class="header">
            <a href="${logoUrl}">
                <img src="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png" alt="CitizenX Logo" class="logo">
            </a>
        </header>
        <main>
            <h1>CitizenX Annotations</h1>
            <p>This service hosts web annotations created with CitizenX, a platform for collaborative web commentary.</p>
            <p><a href="${ctaUrl}" class="cta">Visit CitizenX to Start Annotating</a></p>
            <p>Explore existing annotations via our <a href="/sitemap.xml">sitemap</a>.</p>
            ${recentAnnotations.length ? `
            <section class="annotations">
                <h2>Recent Annotations</h2>
                ${recentAnnotationsHtml}
            </section>` : ''}
        </main>
    </div>
</body>
</html>
        `;
        res.set('Content-Type', 'text/html');
        res.send(html);
    });
}