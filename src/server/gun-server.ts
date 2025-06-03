// arc/server/gun-server.ts

import Gun from 'gun';
import http from 'http';
import express, {Express, Request, Response} from 'express';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import {fetchPageMetadata} from './utils/fetchPageMetadata.js';
import {verifyGunWrite} from './utils/verifyGunWrite.js';
import {limiter, PeerData} from './utils/rateLimit.js';
import {Annotation, Metadata} from './utils/types.js';
import {stripHtml} from "./utils/stripHtml.js";
import {ParsedQs} from 'qs';
import sharp from 'sharp';
import {getShardKey} from "./utils/shardUtils.js";
import {normalizeUrl} from "./utils/normalizeUrl.js";

// Profile cache
const profileCache = new Map<string, { handle: string; profilePicture?: string }>();

async function getProfileWithRetries(did: string, retries: number = 5, delay: number = 100): Promise<{
    handle: string;
    profilePicture?: string
}> {
    if (profileCache.has(did)) {
        return profileCache.get(did)!;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        const profile = await new Promise<{ handle: string; profilePicture?: string } | null>((resolve) => {
            gun.get('profiles').get(did).once((data: any) => {
                if (data && data.handle) {
                    resolve({
                        handle: data.handle,
                        profilePicture: data.profilePicture,
                    });
                } else {
                    gun.get(`user_${did}`).get('profile').once((userData: any) => {
                        if (userData && userData.handle) {
                            resolve({
                                handle: userData.handle,
                                profilePicture: userData.profilePicture,
                            });
                        } else {
                            resolve(null);
                        }
                    });
                }
            });
        });

        if (profile) {
            profileCache.set(did, profile);
            setTimeout(() => profileCache.delete(did), 5 * 60 * 1000);
            return profile;
        }

        console.log(`Retrying profile fetch for DID: ${did}, attempt ${attempt}/${retries}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    console.error('Failed to load profile for DID after retries:', did);
    return {handle: 'Unknown'};
}

// Annotation cache with expiration
const annotationCache = new Map<string, number>();
const ANNOTATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

// Simple hash function for sharding
function simpleHash(str: string): number {
    return parseInt(require('crypto').createHash('sha256').update(str).digest('hex').slice(0, 8), 16);
}

const port: number = parseInt(process.env.PORT || '10000', 10);
const publicUrl: string = 'https://service.citizenx.app';
const websiteUrl: string = 'https://citizenx.app';
const initialPeers: string[] = [
    'https://service.citizenx.app/gun',
    'https://s3.citizenx.app/gun',
    'https://s2.citizenx.app/gun'
];

const app: Express = express();

app.use(limiter);
app.use(express.json());
app.use(cors({
    origin: [
        'https://citizenx.app',
        'chrome-extension://mbmlbbmhjhcmmpbieofegoefkhnbjmbj',
        'chrome-extension://klblcgbgljcpamgpmdccefaalnhndjap',
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    optionsSuccessStatus: 200,
}));

const server: http.Server = http.createServer(app).listen(port, () => {
    console.log(`Gun server running on port ${port}`);
});

const baseDataDir: string = process.env.DATA_DIR || '/var/data';
const dataDir: string = `${baseDataDir}/gun-data`;
try {
    if (!fs.existsSync(baseDataDir)) {
        fs.mkdirSync(baseDataDir, {recursive: true});
        console.log('Created base data directory:', baseDataDir);
    }
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, {recursive: true});
        console.log('Created data directory:', dataDir);
    }
} catch (error) {
    console.error('Failed to create data directories:', {baseDataDir, dataDir}, error);
    console.warn('Data persistence may not work without a persistent disk.');
}

let shortIoApiKey: string = process.env.SHORT_IO_API_KEY || '';
const shortKeyPath: string = `${baseDataDir}/short.key`;
try {
    if (!shortIoApiKey && fs.existsSync(shortKeyPath)) {
        shortIoApiKey = fs.readFileSync(shortKeyPath, 'utf8').trim();
        console.log('Successfully read Short.io API key from', shortKeyPath);
    }
} catch (error) {
    console.error('Failed to read Short.io API key from', shortKeyPath, ':', error);
}

const gun: any = (Gun as any)({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
    batch: false,
});

// Sitemap management
const sitemapPath = `${baseDataDir}/sitemap.xml`;

interface SitemapEntry {
    url: string;
    timestamp: number; // Store annotation timestamp
}

let sitemapUrls: Set<SitemapEntry> = new Set();

function generateSitemap(): string {
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

function serveSitemap(): string {

    let sitemapDate: Date | null = null;
    Array.from(sitemapUrls)
        .map(entry => {
            let annotationDate: Date = new Date(entry.timestamp);
            if (sitemapDate == null || annotationDate > sitemapDate) {
                sitemapDate = annotationDate;
            }
        });

    if (sitemapDate == null) {
        sitemapDate = new Date();
    }
    // Add root URL dynamically with daily frequency
    const homepageUrl = `
    <url>
        <loc>${publicUrl}/</loc>
        <lastmod>${sitemapDate}</lastmod>
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

    // noinspection HttpUrlsUsage
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
    } catch (error) {
        console.error('Failed to update sitemap at', sitemapPath, ':', error);
    }
}

// Helper to add annotation to sitemap
function addAnnotationToSitemap(annotationId: string, annotationUrl: string, timestamp: number): void {
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

// Bootstrap sitemap with existing annotations only if the sitemap file doesn't exist
if (!fs.existsSync(sitemapPath)) {
    console.log('No sitemap file found, running bootstrapSitemap...');
    bootstrapSitemap().then(() => console.log('Bootstrap sitemap completed with', sitemapUrls.size, 'URLs')).catch(error => console.error('Error bootstrapping sitemap:', error));
} else {
    console.log('Sitemap file exists, skipping bootstrapSitemap to preserve existing sitemap');
}

async function bootstrapSitemap(): Promise<void> {
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

function appendUtmParams(baseUrl: string, utmParams: ParsedQs): string {
    const url = new URL(baseUrl);
    const validUtmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    validUtmKeys.forEach(key => {
        const value = utmParams[key];
        if (typeof value === 'string') {
            url.searchParams.set(key, value);
        }
    });
    return url.toString();
}

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

// Debug endpoint to rebuild sitemap
app.get('/api/debug/rebuild-sitemap', async (_req: Request, res: Response) => {
    console.log('Rebuilding sitemap via debug endpoint...');
    sitemapUrls.clear();
    await bootstrapSitemap();
    res.json({message: 'Sitemap rebuilt successfully', urlCount: sitemapUrls.size});
    console.log('Debug sitemap rebuild completed with', sitemapUrls.size, 'URLs');
});

// Throttle logging with expiration
const logThrottle: Map<string, number> = new Map();
const LOG_THROTTLE_TTL = 3600000; // 1 hour in milliseconds

function throttleLog(message: string, interval: number = 60000): boolean {
    const now = Date.now();
    const lastTime = logThrottle.get(message) || 0;
    if (now - lastTime < interval) return false;
    logThrottle.set(message, now);
    setTimeout(() => logThrottle.delete(message), LOG_THROTTLE_TTL);
    return true;
}

// Log incoming messages
gun._.on('in', (msg: { put?: Record<string, any> }) => {
    if (msg.put) {
        const souls = Object.keys(msg.put).join(', ');
        if (throttleLog(`write_${souls}`, 60000)) {
            console.log(`Incoming write request for souls: ${souls}`);
        }
    }
});

// Modified put hook to capture annotation writes and update sitemap
gun._.on('put' as any, async (msg: { souls?: string; data?: Record<string, any> }, eve: any) => {
    try {
        if (!msg.souls || !msg.data || typeof msg.data !== 'object') {
            if (throttleLog('invalid_put')) {
                console.log('Skipping invalid put request', msg);
            }
            return;
        }
        const {data} = msg;
        for (const soul in data) {
            try {
                if (soul === 'test' || soul.startsWith('knownPeers')) {
                    if (data[soul] === null) {
                        console.log(`Write detected: ${soul} (cleanup)`);
                        continue;
                    }
                    if (throttleLog(`write_${soul}`, 60000)) {
                        console.log(`Write detected: ${soul}`);
                    }
                    continue;
                }
                const nodeData = data[soul];
                if (nodeData === null || soul.includes('replicationMarker')) {
                    if (throttleLog(`skip_${soul}`)) {
                        console.log(`Skipping SEA verification for soul: ${soul}`);
                    }
                    continue;
                }
                if (nodeData && typeof nodeData === 'object') {
                    const verified = await verifyGunWrite(nodeData, soul, msg, eve, gun);
                    if (!verified) {
                        console.warn(`Write rejected for soul: ${soul}, data:`, nodeData);
                        continue;
                    }
                    if (soul.includes('annotations_') && nodeData.id && nodeData.url && nodeData.timestamp) {
                        addAnnotationToSitemap(nodeData.id, nodeData.url, nodeData.timestamp);
                    } else if (soul.includes('annotations_')) {
                        console.log(`Skipped incomplete annotation write in ${soul}, data:`, nodeData);
                    }
                }
            } catch (error) {
                console.error(`Error processing soul: ${soul}, error:`, error);
            }
        }
    } catch (error) {
        console.error('Error in put hook:', error);
    }
});

const peerId: string = `${publicUrl}-bootstrap`;
let serverPeerUpdateCount = 0;
setInterval(() => {
    const now = Date.now();
    gun.get('knownPeers').get(peerId).put({
        url: `${publicUrl}/gun`,
        timestamp: now,
        lastConnection: now,
    }, (ack: any) => {
        serverPeerUpdateCount++;
        if (ack.err) {
            console.error(`Failed to update server peer lastConnection: ${ack.err}`);
        } else if (serverPeerUpdateCount % 10 === 0 || throttleLog('server_peer_update', 3600000)) {
            console.log(`Updated server peer lastConnection: ${peerId}`);
        }
    });
}, 5 * 60 * 1000);

const peerConnectionCount = new Map<string, number>();
gun.on('hi', (peer: { url?: string }) => {
    if (peer.url) {
        console.log('Connected to peer:', peer.url);
        const peerId = peer.url.replace(/[^a-zA-Z0-9-]/g, '-') || `peer-${Date.now()}`;
        gun.get('knownPeers').get(peerId).once((data: any) => {
            const now = Date.now();
            const peerData: PeerData = {
                url: peer.url,
                timestamp: data?.timestamp || now,
                lastConnection: now,
            };
            gun.get('knownPeers').get(peerId).put(peerData, (ack: any) => {
                const count = (peerConnectionCount.get(peerId) || 0) + 1;
                peerConnectionCount.set(peerId, count);
                if (ack.err) {
                    console.error(`Failed to update lastConnection for peer ${peerId}:`, ack.err);
                } else if (count % 10 === 0 || throttleLog(`peer_${peerId}_update`, 3600000)) {
                    console.log(`Updated lastConnection for peer: ${peerId}, URL: ${peer.url}`);
                }
            });
        });
    }
});

function fromUrlSafeBase64(urlSafeBase64: string): string {
    let base64 = urlSafeBase64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return base64;
}

// Homepage route
app.get('/', (req: Request, res: Response) => {
    const recentAnnotations = Array.from(sitemapUrls)
        .sort((a, b) => b.timestamp - a.timestamp)
        .map(entry => {
            console.log(`Listing annotation: ${entry.url}`);
            const viewUrl = appendUtmParams(entry.url, req.query);
            // Format timestamp as human-readable date (e.g., "May 29, 2025, 5:23 PM")
            const timestampText = new Date(entry.timestamp).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
            return `<li><a href="${viewUrl}" class="annotation-link">Annotation from ${timestampText}</a></li>`;
        })
        .filter(Boolean)
        .join('');

    const ctaUrl = appendUtmParams('https://citizenx.app', req.query);
    const logoUrl = appendUtmParams('https://citizenx.app', req.query);

    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CitizenX Annotations - Service</title>
    <meta name="description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation and annotate the web.">
    <link rel="canonical" href="https://service.citizenx.app">
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta property="og:title" content="CitizenX Annotations - Service">
    <meta property="og:description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation.">
    <meta property="og:image" content="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png">
    <meta property="og:url" content="https://service.citizenx.app">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="CitizenX Annotations - Service">
    <meta name="twitter:description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation.">
    <meta name="twitter:image" content="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png">
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
        }
        p {
            color: #444;
            font-size: 1rem;
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
        .annotations h2 {
            color: #333;
            font-size: 1.4rem;
            margin-bottom: 10px;
        }
        .annotations ul {
            list-style: none;
            padding: 0;
        }
        .annotations li {
            margin-bottom: 8px;
        }
        .annotation-link {
            color: #7593f4;
            text-decoration: none;
            display: inline-block;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .annotation-link:hover {
            text-decoration: underline;
        }
        /* Responsive adjustments */
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
            .annotations h2 {
                font-size: 1.2rem;
            }
            p, .annotation-link {
                font-size: 0.9rem;
            }
            .cta {
                padding: 8px 16px;
                font-size: 0.9rem;
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
        <div class="header">
            <a href="${logoUrl}">
                <img src="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png" alt="CitizenX Logo" class="logo">
            </a>
        </div>
        <h1>CitizenX Annotations</h1>
        <p>This service hosts web annotations created with CitizenX, a platform for collaborative web commentary.</p>
        <p><a href="${ctaUrl}" class="cta">Visit CitizenX to Start Annotating</a></p>
        <p>Explore existing annotations via our <a href="/sitemap.xml">sitemap</a>.</p>
        ${recentAnnotations ? `
        <div class="annotations">
            <h2>Recent Annotations</h2>
            <ul>${recentAnnotations}</ul>
        </div>` : ''}
    </div>
</body>
</html>
    `;
    res.set('Content-Type', 'text/html');
    res.send(html);
});

// Update /api/annotations to add to sitemap
app.get('/api/annotations', async (req: Request, res: Response) => {
    const totalStartTime = Date.now();
    const url = req.query.url as string | undefined;
    const annotationId = req.query.annotationId as string | undefined;

    if (!url) {
        console.log(`[Timing] Request failed: Missing url parameter`);
        return res.status(400).json({error: 'Missing url parameter'});
    }

    try {
        const cacheClearStart = Date.now();
        profileCache.clear();
        annotationCache.clear();
        const cacheClearEnd = Date.now();
        if (throttleLog('cache_clear', 3600000)) {
            console.log(`[Timing] Cleared caches in ${cacheClearEnd - cacheClearStart}ms`);
        }

        const cleanUrl = normalizeUrl(new URL(url).href);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        const annotations: Annotation[] = [];
        const loadedAnnotations = new Set<string>();
        const maxWaitTime = 5000;

        await new Promise<void>((resolve) => {
            const onAnnotation = (annotation: any) => {
                if (!annotation || !annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                    return;
                }
                const cacheKey = `${cleanUrl}:${annotation.id}`;
                if (loadedAnnotations.has(annotation.id) || annotationCache.has(cacheKey)) {
                    return;
                }
                if (annotation.isDeleted) {
                    return;
                }
                loadedAnnotations.add(annotation.id);
                annotationCache.set(cacheKey, Date.now());
                setTimeout(() => annotationCache.delete(cacheKey), ANNOTATION_CACHE_TTL);
                annotations.push({
                    comments : annotation.comments,
                    id: annotation.id,
                    url: annotation.url,
                    content: annotation.content,
                    author: annotation.author,
                    timestamp: annotation.timestamp,
                    screenshot: annotation.screenshot,
                    metadata: annotation.metadata || {},
                    isDeleted: annotation.isDeleted || false,
                });
                addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
            };

            annotationNodes.forEach(node => {
                node.map().on(onAnnotation, {change: true, filter: {isDeleted: false}});
            });

            setTimeout(() => {
                annotationNodes.forEach(node => node.map().off());
                resolve();
            }, maxWaitTime);
        });

        if (!annotations.length) {
            return res.status(404).json({error: 'No annotations found for this URL'});
        }

        annotations.sort((a, b) => b.timestamp - a.timestamp);

        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                const profile = await getProfileWithRetries(annotation.author);
                const commentsData = await Promise.all(
                    annotationNodes.map((node) =>
                        new Promise<any[]>((resolve) => {
                            const commentList: any[] = [];
                            const commentIds = new Set<string>();
                            node.get(annotationId || annotation.id).get('comments').map().once((comment: any, commentId: string) => {
                                if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                    commentIds.add(commentId);
                                    commentList.push({
                                        id: commentId,
                                        content: comment.content,
                                        author: comment.author,
                                        timestamp: comment.timestamp,
                                        isDeleted: comment.isDeleted || false,
                                    });
                                }
                            });
                            setTimeout(() => resolve(commentList), 500);
                        })
                    )
                );

                const flattenedComments: any[] = [];
                const seenCommentIds = new Set<string>();
                for (const commentList of commentsData) {
                    for (const comment of commentList) {
                        if (!seenCommentIds.has(comment.id)) {
                            seenCommentIds.add(comment.id);
                            flattenedComments.push(comment);
                        }
                    }
                }

                const resolvedComments: any[] = [];
                const resolvedCommentIds = new Set<string>();
                for (const comment of flattenedComments) {
                    if (!resolvedCommentIds.has(comment.id)) {
                        resolvedCommentIds.add(comment.id);
                        if (!comment.isDeleted) {
                            resolvedComments.push(comment);
                        }
                    }
                }

                const commentsWithAuthors = await Promise.all(
                    resolvedComments.map(async (comment) => {
                        const commentProfile = await getProfileWithRetries(comment.author);
                        return {
                            ...comment,
                            authorHandle: commentProfile.handle,
                        };
                    })
                );

                let metadata: Metadata | undefined;
                if (!annotation.screenshot) {
                    metadata = await fetchPageMetadata(cleanUrl);
                }

                return {
                    ...annotation,
                    authorHandle: profile.handle,
                    authorProfilePicture: profile.profilePicture,
                    comments: commentsWithAuthors,
                    metadata,
                };
            })
        );

        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.put({replicationMarker: Date.now()}, (ack: any) => {
                        if (ack.err) {
                            console.error(`Failed to force replication for node: ${node._.get}, URL: ${cleanUrl}, Error:`, ack.err);
                        }
                        resolve();
                    });
                })
            )
        );

        const endTime = Date.now();
        if (throttleLog('annotations_timing', 3600000)) {
            console.log(`[Timing] Total request time: ${endTime - totalStartTime}ms`);
        }

        res.json({annotations: annotationsWithDetails});
    } catch (error) {
        console.error('Error fetching annotations:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

// Update /api/page-metadata to add to sitemap
app.get('/api/page-metadata', async (req: Request, res: Response) => {
    const {url} = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({error: 'Invalid URL'});
    }

    try {
        const metadata: Metadata = await fetchPageMetadata(url);
        const cleanUrl = normalizeUrl(new URL(url).href);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.map().once((annotation: any) => {
                        if (annotation && !annotation.isDeleted && annotation.id && annotation.url && annotation.timestamp) {
                            addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
                        }
                    });
                    setTimeout(resolve, 1000);
                })
            )
        );

        res.json(metadata);
    } catch (error) {
        console.error('Error fetching metadata:', error);
        res.status(500).json({error: 'Failed to fetch metadata'});
    }
});

// Update /image/... to add to sitemap
app.get('/image/:annotationId/:base64Url/image.png', async (req: Request, res: Response) => {
    console.log(`[DEBUG] /image called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);

    const {annotationId, base64Url} = req.params;

    if (!annotationId || !base64Url) {
        console.log(`[DEBUG] Missing parameters: annotationId=${annotationId}, base64Url=${base64Url}`);
        return res.status(400).send('Missing annotationId or base64Url');
    }

    let originalUrl: string;
    try {
        const standardBase64 = fromUrlSafeBase64(base64Url);
        console.log(`[DEBUG] Converted URL-safe Base64 to standard Base64: ${standardBase64}`);
        originalUrl = Buffer.from(standardBase64, 'base64').toString('utf8');
        console.log(`[DEBUG] Decoded base64Url to originalUrl: ${originalUrl}`);
        new URL(originalUrl);
    } catch (error) {
        console.error(`[DEBUG] Invalid base64Url: ${base64Url}, error:`, error);
        return res.status(400).send('Invalid base64Url');
    }

    try {
        const cleanUrl = normalizeUrl(new URL(originalUrl).href);
        console.log(`[DEBUG] Cleaned URL: ${cleanUrl}`);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        const annotations = await Promise.all(
            annotationNodes.map(node =>
                new Promise<Annotation | null>((resolve) => {
                    node.get(annotationId).once((data: any) => {
                        if (data && !data.isDeleted && typeof data.screenshot === 'string') {
                            resolve(data as Annotation);
                        } else {
                            resolve(null);
                        }
                    });
                })
            )
        );

        const annotation = annotations.find(a => a !== null) || null;

        if (!annotation || !annotation.screenshot || !annotation.url) {
            console.log(`[DEBUG] No annotation or screenshot found for annotationId: ${annotationId}, url: ${cleanUrl}`);
            return res.status(404).send('Annotation or screenshot not found');
        }

        addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);

        console.log(`[DEBUG] Annotation screenshot found, length: ${annotation.screenshot.length}`);
        const base64Match = annotation.screenshot.match(/^data:image\/(png|jpeg);base64,(.+)$/);
        if (!base64Match) {
            console.log(`[DEBUG] Invalid Base64 image format for annotationId: ${annotationId}`);
            return res.status(400).send('Invalid screenshot format');
        }

        const imageBuffer = Buffer.from(base64Match[2], 'base64');
        console.log(`[DEBUG] Decoded image buffer, size: ${imageBuffer.length} bytes`);

        const targetAspectRatio = 1.91;
        const targetWidth = 1200;
        const targetHeight = 630;

        try {
            const metadata = await sharp(imageBuffer).metadata();
            const width = metadata.width || targetWidth;
            const height = metadata.height || targetHeight;
            console.log(`[DEBUG] Original image dimensions: ${width}x${height}`);

            const currentAspectRatio = width / height;

            let left: number, top: number, cropWidth: number, cropHeight: number;

            if (currentAspectRatio > targetAspectRatio) {
                cropHeight = height;
                cropWidth = Math.floor(height * targetAspectRatio);
                left = Math.floor((width - cropWidth) / 2);
                top = 0;
            } else {
                cropWidth = width;
                cropHeight = Math.floor(width / targetAspectRatio);
                left = 0;
                top = 0;
            }

            console.log(`[DEBUG] Cropping to ${cropWidth}x${cropHeight} at (${left}, ${top})`);

            const processedBuffer = await sharp(imageBuffer)
                .extract({left, top, width: cropWidth, height: cropHeight})
                .resize({width: targetWidth, height: targetHeight, fit: 'fill'})
                .toFormat("png")
                .toBuffer();

            res.set('Content-Type', `image/${base64Match[1]}`);
            res.send(processedBuffer);
            console.log(`[DEBUG] Processed image sent, size: ${processedBuffer.length} bytes`);
        } catch (sharpError) {
            console.error(`[DEBUG] Error processing image with sharp:`, sharpError);
            res.set('Content-Type', `image/${base64Match[1]}`);
            res.send(imageBuffer);
        }
    } catch (error) {
        console.error(`[DEBUG] Error in /image:`, error);
        res.status(500).send('Internal server error');
    }
});

app.get('/:annotationId/:base64Url', async (req: Request, res: Response) => {
    console.log(`[DEBUG] /:annotationId/:base64Url called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);

    const {annotationId, base64Url} = req.params;

    if (!annotationId || !base64Url) {
        console.log(`[DEBUG] Missing parameters: annotationId=${annotationId}, base64Url=${base64Url}`);
        return res.status(400).send('Missing annotationId or base64Url');
    }

    let originalUrl: string;
    try {
        const standardBase64 = fromUrlSafeBase64(base64Url);
        console.log(`[DEBUG] Converted URL-safe Base64 to standard Base64: ${standardBase64}`);
        originalUrl = Buffer.from(standardBase64, 'base64').toString('utf8');
        console.log(`[DEBUG] Decoded base64Url to originalUrl: ${originalUrl}`);
        new URL(originalUrl);
    } catch (error) {
        console.error(`[DEBUG] Invalid base64Url: ${base64Url}, error:`, error);
        return res.status(400).send('Invalid base64Url');
    }

    try {
        const cleanUrl = normalizeUrl(new URL(originalUrl).href);
        console.log(`[DEBUG] Cleaned URL: ${cleanUrl}`);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        let annotation: any = null;
        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.get(annotationId).once((data: any) => {
                        console.log(`[DEBUG] Fetched annotation for annotationId: ${annotationId}, data:`, data);
                        if (data && !data.isDeleted) {
                            annotation = data;
                        }
                        resolve();
                    });
                })
            )
        );

        if (!annotation || !annotation.url) {
            console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}, url: ${cleanUrl}`);
            return res.status(404).send('Annotation not found');
        }

        addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);

        console.log(`[DEBUG] Annotation found:`, annotationId);
        const profile = await getProfileWithRetries(annotation.author);
        console.log(`[DEBUG] Fetched profile for author: ${annotation.author}, profile:`, profile);
        let metadata: Metadata = await fetchPageMetadata(cleanUrl);
        console.log(`[DEBUG] Fetched metadata for url: ${cleanUrl}, metadata:`, metadata);
        const annotationNoHTML = stripHtml(annotation.content);
        const description = annotationNoHTML.length > 160 ? `${annotationNoHTML.slice(0, 157)}...` : annotationNoHTML;
        const title = `${profile.handle}'s Annotation on ${new URL(cleanUrl).hostname}`;
        const defaultImage = 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png';
        const image = annotation.screenshot
            ? `${publicUrl}/image/${annotationId}/${base64Url}/image.png`
            : metadata.ogImage || defaultImage;
        const canonicalUrl = `${publicUrl}/${annotationId}/${base64Url}`;
        const baseViewUrl = `${websiteUrl}/view-annotations?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
        const viewUrl = appendUtmParams(baseViewUrl, req.query);

        const keywords = annotationNoHTML
            .split(/\s+/)
            .filter(word => word.length > 3)
            .slice(0, 10)
            .join(', ');

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta name="description" content="${description}">
    <meta name="keywords" content="${keywords}">
    <meta name="author" content="${profile.handle}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${image}">
    <link rel="canonical" href="${canonicalUrl}">
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
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            background-color: #f5f5f5;
        }
        .annotation-container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }
        .annotation-header {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
        }
        .author-img {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            margin-right: 12px;
        }
        .author-name {
            font-weight: bold;
            color: #333;
            font-size: 1.2em;
        }
        .timestamp {
            color: #666;
            font-size: 0.9em;
        }
        .content {
            margin-bottom: 20px;
            color: #444;
            font-size: 16px;
        }
        .screenshot {
            max-width: 100%;
            border-radius: 8px;
            margin-bottom: 20px;
            border: 1px solid #ddd;
        }
        .view-link {
            display: inline-flex;
            align-items: center;
            padding: 10px 20px;
            background-color: #000000;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 500;
            transition: background-color 0.3s ease;
        }
        .view-link:hover {
            background-color: #393b3c;
        }
    </style>
</head>
<body>
    <div class="annotation-container">
        <div class="annotation-header">
            ${profile.profilePicture ? `<img src="${profile.profilePicture}" alt="${profile.handle || 'User'}" class="author-img">` : ''}
            <div>
                <div class="author-name">${profile.handle || 'Anonymous'}</div>
                <div class="timestamp">${new Date(annotation.timestamp).toLocaleString()}</div>
            </div>
        </div>
        <div class="content">${annotation.content}</div>
        ${image !== defaultImage ? `<img src="${image}" alt="Annotation screenshot" class="screenshot">` : ''}
        <a href="${viewUrl}" class="view-link">View Full Annotation on CitizenX</a>
    </div>
</body>
</html>
`;

        console.log(`[DEBUG] Sending HTML response for /${annotationId}/${base64Url}`);
        res.set('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error(`[ERROR] Error in /${annotationId}/${base64Url}:`, error);
        res.status(500).send('Internal server error');
    }
});

// Update /viewannotation/... to add to sitemap
app.get('/viewannotation/:annotationId/:base64Url', async (req: Request, res: Response) => {
    console.log(`[DEBUG] /viewannotation called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);
    console.log(`[DEBUG] Request headers:`, req.headers);
    console.log(`[DEBUG] Request query:`, req.query);

    const {annotationId, base64Url} = req.params;

    if (!annotationId || !base64Url) {
        console.log(`[DEBUG] Missing parameters: annotationId=${annotationId}, base64Url=${base64Url}`);
        return res.status(400).send('Missing annotationId or base64Url');
    }

    let originalUrl: string;
    try {
        const standardBase64 = fromUrlSafeBase64(base64Url);
        console.log(`[DEBUG] Converted URL-safe Base64 to standard Base64: ${standardBase64}`);
        originalUrl = Buffer.from(standardBase64, 'base64').toString('utf8');
        console.log(`[DEBUG] Decoded base64Url to originalUrl: ${originalUrl}`);
        new URL(originalUrl);
    } catch (error) {
        console.error(`[DEBUG] Invalid base64Url: ${base64Url}, error:`, error);
        return res.status(400).send('Invalid base64Url');
    }

    try {
        const cleanUrl = normalizeUrl(new URL(originalUrl).href);
        console.log(`[DEBUG] Cleaned URL: ${cleanUrl}`);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        let annotation: any = null;
        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.get(annotationId).once((data: any) => {
                        console.log(`[DEBUG] Fetched annotation for annotationId: ${annotationId}, data:`, data);
                        if (data && !data.isDeleted) {
                            annotation = data;
                        }
                        resolve();
                    });
                })
            )
        );

        if (!annotation || !annotation.url) {
            console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}, url: ${cleanUrl}`);
            return res.status(404).send('Annotation not found');
        }

        addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);

        console.log(`[DEBUG] Annotation found:`, annotationId);
        const profile = await getProfileWithRetries(annotation.author);
        console.log(`[DEBUG] Fetched profile for author: ${annotation.author}, profile:`, profile);
        let metadata: Metadata = await fetchPageMetadata(cleanUrl);
        console.log(`[DEBUG] Fetched metadata for url: ${cleanUrl}, metadata:`, metadata);
        const annotationNoHTML = stripHtml(annotation.content);
        const description = annotationNoHTML.length > 160 ? `${annotationNoHTML.slice(0, 157)}...` : annotationNoHTML;
        const title = `Annotation by ${profile.handle} on ${cleanUrl}`;
        const defaultImage = 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png';
        const image = metadata.ogImage
            ? metadata.ogImage
            : annotation.screenshot ? `${publicUrl}/image/${annotationId}/${base64Url}/image.png` : defaultImage;

        const baseCheckExtensionUrl = `${websiteUrl}/check-extension?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
        const baseViewAnnotationsUrl = `${websiteUrl}/view-annotations?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
        const checkExtensionUrl = appendUtmParams(baseCheckExtensionUrl, req.query);
        const viewAnnotationsUrl = appendUtmParams(baseViewAnnotationsUrl, req.query);

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta name="description" content="${description}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:url" content="${cleanUrl}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${image}">
    <link rel="canonical" href="${cleanUrl}">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-YDDS5BJ90C"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-YDDS5BJ90C');
    </script>
</head>
<body>
    <script>
        (function() {
            let redirectHandled = false;
            function redirect(url) {
                console.log('[DEBUG] Redirecting to:', url);
                if (!redirectHandled) {
                    redirectHandled = true;
                    window.location.href = url;
                }
            }

            setTimeout(() => {
                const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
                console.log('[DEBUG] Browser detection: isChrome=', isChrome);
                console.log('Original URL: ${originalUrl}');
                if (isChrome) {
                    redirect('${checkExtensionUrl}');
                } else {
                    redirect('${viewAnnotationsUrl}');
                }
            }, 500);
        })();
    </script>
</body>
</html>
        `;

        console.log(`[DEBUG] Sending HTML response for /viewannotation`);
        res.set('Content-Type', 'text/html');
        res.send(html);
    } catch (error) {
        console.error(`[DEBUG] Error in /viewannotation:`, error);
        res.status(500).send('Internal server error');
    }
});

// Unchanged routes
app.get('/api/debug/annotations', async (req: Request, res: Response) => {
    const {url, annotationId} = req.query;
    console.log(`[DEBUG] /api/debug/annotations called with url: ${url}, annotationId: ${annotationId}`);

    if (!url || !annotationId) {
        console.log(`[DEBUG] Missing url or annotationId: url=${url}, annotationId=${annotationId}`);
        return res.status(400).json({error: 'Missing url or annotationId parameter'});
    }

    try {
        const {domainShard, subShard} = getShardKey(url as string);
        console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
        const annotationNodes = [
            gun.get(domainShard).get(url),
            ...(subShard ? [gun.get(subShard).get(url)] : []),
        ];

        const shardedData = await Promise.all(
            annotationNodes.map((node) =>
                new Promise((resolve) => {
                    const annotationData: { annotation?: Annotation; comments: any[] } = {comments: []};
                    node.get(annotationId as string).once((annotation: any) => {
                        if (annotation) {
                            annotationData.annotation = {
                                comments : annotation.comments,
                                id: annotationId as string,
                                url: annotation.url,
                                content: annotation.content,
                                author: annotation.author,
                                timestamp: annotation.timestamp,
                                isDeleted: annotation.isDeleted || false,
                                screenshot: annotation.screenshot,
                                metadata: annotation.metadata || {},
                            };

                            const comments: any[] = [];
                            const commentIds = new Set();
                            let nodesProcessed = 0;
                            const totalNodes = annotationNodes.length;

                            const timeout = setTimeout(() => {
                                nodesProcessed = totalNodes;
                                resolve({annotation: annotationData.annotation, comments});
                            }, 500);

                            node.get(annotationId as string).get('comments').map().once((comment: any, commentId: string) => {
                                console.log(`[DEBUG] Fetched comment for annotationId: ${annotationId}, commentId: ${commentId}, comment:`, comment);
                                if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                    commentIds.add(commentId);
                                    comments.push({
                                        id: commentId,
                                        content: comment.content,
                                        author: comment.author,
                                        timestamp: comment.timestamp,
                                        isDeleted: comment.isDeleted || false,
                                    });
                                }
                                nodesProcessed++;
                                if (nodesProcessed === totalNodes) {
                                    clearTimeout(timeout);
                                    resolve({annotation: annotationData.annotation, comments});
                                }
                            });

                            if (nodesProcessed === 0) {
                                setTimeout(() => {
                                    if (nodesProcessed === 0) {
                                        clearTimeout(timeout);
                                        resolve({annotation: annotationData.annotation, comments});
                                    }
                                }, 100);
                            }
                        } else {
                            console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}`);
                            resolve(null);
                        }
                    });
                })
            )
        );

        console.log(`[DEBUG] Sharded data response:`, shardedData);
        res.json({
            shardedData: shardedData.filter(data => data !== null),
        });
    } catch (error) {
        console.error('[DEBUG] Error in /api/debug/annotations:', error);
        res.status(500).json({error: 'Internal server error'});
    }
});

app.post('/api/shorten', async (req: Request, res: Response) => {
    const {url} = req.body;

    console.log(`[DEBUG] /api/shorten called with url: ${url}`);

    if (!url) {
        console.log('[DEBUG] Missing url parameter');
        return res.status(400).json({error: 'Missing url parameter'});
    }

    try {
        const response = await axios.post(
            'https://api.short.io/links',
            {
                originalURL: url,
                domain: 'citizx.im',
            },
            {
                headers: {
                    Authorization: shortIoApiKey,
                    'Content-Type': 'application/json',
                },
            }
        );

        const shortUrl: string = response.data.shortURL;
        console.log(`[DEBUG] Successfully shortened URL: ${url} to ${shortUrl}`);
        res.json({shortUrl});
    } catch (error: any) {
        console.error('[DEBUG] Error shortening URL:', error.response?.data || error.message);
        res.status(500).json({error: 'Failed to shorten URL'});
    }
});

app.get('/health', (req, res) => res.status(200).json({status: 'ok'}));

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.join(', ')}`);