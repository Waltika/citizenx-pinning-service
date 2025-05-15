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

// Profile cache
const profileCache = new Map<string, { handle: string; profilePicture?: string }>();

async function getProfileWithRetries(did: string, retries: number = 5, delay: number = 100): Promise<{
    handle: string;
    profilePicture?: string
}> {
    const startTime = Date.now();
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

// Annotation cache
const annotationCache = new Map<string, number>();

// Simple hash function for sharding
function simpleHash(str: string): number {
    return parseInt(require('crypto').createHash('sha256').update(str).digest('hex').slice(0, 8), 16);
}

const port: number = parseInt(process.env.PORT || '10000', 10);
const publicUrl: string = 'https://citizen-x-bootsrap.onrender.com';
const websiteUrl: string = 'https://citizenx.app';
const initialPeers: string[] = [];

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

const dataDir: string = '/var/data/gun-data';
try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, {recursive: true});
        console.log('Created data directory:', dataDir);
    }
} catch (error) {
    console.error('Failed to create data directory:', dataDir, error);
    console.warn('Data persistence may not work without a persistent disk.');
}

let shortIoApiKey: string = '';
try {
    shortIoApiKey = fs.readFileSync('/var/data/short.key', 'utf8').trim();
    console.log('Successfully read Short.io API key from /var/data/short.key');
} catch (error) {
    console.error('Failed to read Short.io API key from /var/data/short.key:', error);
    shortIoApiKey = process.env.SHORT_IO_API_KEY || '';
}

const gun: any = (Gun as any)({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
    batch: false,
});

// Throttle logging
const logThrottle: Map<string, number> = new Map();

function throttleLog(message: string, interval: number = 60000): boolean {
    const now = Date.now();
    const lastTime = logThrottle.get(message) || 0;
    if (now - lastTime < interval) return false;
    logThrottle.set(message, now);
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

// Custom type for put hook
interface PutHookCallback {
    (msg: { souls?: string; data?: Record<string, any> }, eve: any): Promise<void>;
}

// Put hook with type assertion
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
                        console.warn(`Write rejected for soul: ${soul}`);
                        continue;
                    }
                }
            } catch (error) {
                console.error(`Error processing soul: ${soul}`, error);
            }
        }
    } catch (error) {
        console.error('Error in put hook:', error);
    }
});

const peerId: string = `${publicUrl}-bootstrap`;

async function ensureServerPeer() {
    console.log('Ensuring server peer in knownPeers...');
    const now = Date.now();
    const peerData: PeerData = {
        url: `${publicUrl}/gun`,
        timestamp: now,
        lastConnection: now,
    };
    gun.get('knownPeers').get(peerId).put(peerData, (ack: any) => {
        if (ack.err) {
            console.error('Failed to register server in knownPeers:', ack.err);
        } else {
            console.log(`Successfully registered server in knownPeers: ${publicUrl}/gun`);
        }
    });
}

// Update server peer's lastConnection
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

// Update lastConnection for peers
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

// Simple URL parsing for sharding
function getShardKey(url: string): { domainShard: string; subShard?: string } {
    let cleanUrl: string;
    try {
        cleanUrl = new URL(url).href;
    } catch {
        cleanUrl = url.startsWith('http') ? url : `https://${url}`;
    }
    const urlObj = new URL(cleanUrl);
    const domain = urlObj.hostname.replace(/\./g, '_');
    const domainShard = `annotations_${domain}`;

    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
    if (highTrafficDomains.includes(domain)) {
        const hash = simpleHash(cleanUrl);
        const subShardIndex = hash % 10;
        return {domainShard, subShard: `${domainShard}_shard_${subShardIndex}`};
    }

    return {domainShard};
}

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

        const cleanUrl = new URL(url).href; // Simplified URL parsing
        const {domainShard, subShard} = getShardKey(cleanUrl);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];

        const annotations: Annotation[] = [];
        const loadedAnnotations = new Set<string>();
        const maxWaitTime = 5000;

        await new Promise<void>((resolve) => {
            const onAnnotation = (annotation: any, key: string) => {
                if (!annotation || !annotation.id || !annotation.content || !annotation.author || !annotation.timestamp) {
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
                annotations.push({
                    id: annotation.id,
                    url: annotation.url,
                    content: annotation.content,
                    author: annotation.author,
                    timestamp: annotation.timestamp,
                    screenshot: annotation.screenshot,
                    metadata: annotation.metadata || {},
                    isDeleted: annotation.isDeleted || false,
                });
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

app.get('/api/page-metadata', async (req: Request, res: Response) => {
    const {url} = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({error: 'Invalid URL'});
    }

    try {
        const metadata: Metadata = await fetchPageMetadata(url);
        res.json(metadata);
    } catch (error) {
        res.status(500).json({error: 'Failed to fetch metadata'});
    }
});

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
                        console.log(`[DEBUG] Fetched annotation for node: ${node._.get}, annotation:`, annotation);
                        if (annotation) {
                            annotationData.annotation = {
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

// New /viewannotation route with enhanced logging
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
        originalUrl = Buffer.from(base64Url, 'base64').toString('utf8');
        console.log(`[DEBUG] Decoded base64Url to originalUrl: ${originalUrl}`);
        new URL(originalUrl); // Validate URL
    } catch (error) {
        console.error(`[DEBUG] Invalid base64Url: ${base64Url}, error:`, error);
        return res.status(400).send('Invalid base64Url');
    }

    try {
        const cleanUrl = new URL(originalUrl).href;
        console.log(`[DEBUG] Cleaned URL: ${cleanUrl}`);
        const {domainShard, subShard} = getShardKey(cleanUrl);
        console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
        const annotationNodes = [
            gun.get(domainShard).get(cleanUrl),
            ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
        ];
        console.log(`[DEBUG] Annotation nodes:`, annotationNodes.map(node => node._.get));

        let annotation: any = null;
        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.get(annotationId).once((data: any) => {
                        console.log(`[DEBUG] Fetched annotation for node: ${node._.get}, annotationId: ${annotationId}, data:`, data);
                        if (data && !data.isDeleted) {
                            annotation = data;
                        }
                        resolve();
                    });
                })
            )
        );

        if (!annotation) {
            console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}, url: ${cleanUrl}`);
            return res.status(404).send('Annotation not found');
        }

        console.log(`[DEBUG] Annotation found:`, annotation);
        const profile = await getProfileWithRetries(annotation.author);
        console.log(`[DEBUG] Fetched profile for author: ${annotation.author}, profile:`, profile);
        let metadata: Metadata = await fetchPageMetadata(cleanUrl);
        console.log(`[DEBUG] Fetched metadata for url: ${cleanUrl}, metadata:`, metadata);
        const title = annotation.content.length > 100 ? `${annotation.content.slice(0, 97)}...` : annotation.content;
        const description = `Annotation by ${profile.handle} on ${metadata.title || 'a webpage'}`;
        const image = metadata.ogImage || annotation.screenshot || 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png';
        const canonicalUrl = `${publicUrl}/viewannotation/${annotationId}/${base64Url}`;
        console.log(`[DEBUG] Generated meta tags: title=${title}, description=${description}, image=${image}, canonicalUrl=${canonicalUrl}`);

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${image}">
    <link rel="canonical" href="${canonicalUrl}">
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

            // Detect CitizenX extension
            window.addEventListener('citizenx-extension-installed', () => {
                console.log('[DEBUG] Extension detected, redirecting to original URL');
                redirect('${originalUrl}');
            }, { once: true });

            // Timeout to detect browser and redirect
            setTimeout(() => {
                const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
                console.log('[DEBUG] Browser detection: isChrome=', isChrome);
                console.log('Original URL ${originalUrl}');
                if (isChrome) {
                    redirect('${websiteUrl}/check-extension?annotationId=${annotationId}&url=${originalUrl}');
                } else {
                    redirect('${websiteUrl}/view-annotations?annotationId=${annotationId}&url=${originalUrl}');
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

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.join(', ')}`);