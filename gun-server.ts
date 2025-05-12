import Gun from 'gun';
import { normalizeUrl, simpleHash, simpleHashString, type Annotation, type Comment, type Profile } from '@waltika/citizenx-shared';
import http from 'http';
import express, {type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import RateLimit from 'express-rate-limit';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio';
import SEA from 'gun/sea.js';

const port: number = process.env.PORT ? parseInt(process.env.PORT) : 10000;
const publicUrl: string = 'https://citizen-x-bootsrap.onrender.com';
const initialPeers: string[] = [];

const app = express();

const window = new JSDOM('').window;
const purify = DOMPurify(window);

const corsOptions = {
    origin: [
        'https://citizenx.app',
        'chrome-extension://mbmlbbmhjhcmmpbieofegoefkhnbjmbj',
        'chrome-extension://klblcgbgljcpamgpmdccefaalnhndjap',
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

const limiter = RateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: (req: Request) => req.ip ?? 'unknown',
    message: 'Too many requests, please try again later.',
});
app.use(limiter);

app.use(express.json());

const sanitizeInput = (req: Request, res: Response, next: NextFunction) => {
    if (req.body) {
        const sanitizeObject = (obj: any) => {
            for (const key in obj) {
                if (typeof obj[key] === 'string') {
                    obj[key] = purify.sanitize(obj[key]);
                } else if (typeof obj[key] === 'object' && obj[key] !== null) {
                    sanitizeObject(obj[key]);
                }
            }
        };
        sanitizeObject(req.body);
    }
    next();
};

const server = http.createServer(app).listen(port, () => {
    console.log(`Gun server running on port ${port}`);
});

const dataDir = '/var/data/gun-data';
try {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log('Created data directory:', dataDir);
    }
} catch (error) {
    console.error('Failed to create data directory:', dataDir, error);
    console.warn('Data persistence may not work without a persistent disk.');
}

let shortIoApiKey = '';
try {
    shortIoApiKey = fs.readFileSync('/var/data/short.key', 'utf8').trim();
    console.log('Successfully read Short.io API key from /var/data/short.key');
} catch (error) {
    console.error('Failed to read Short.io API key from /var/data/short.key:', error);
    shortIoApiKey = process.env.SHORT_IO_API_KEY || '';
}

const gun = Gun({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
    batch: false,
});

const logThrottle = new Map();

function throttleLog(message: string, interval = 60000): boolean {
    const now = Date.now();
    const lastTime = logThrottle.get(message) || 0;
    if (now - lastTime < interval) return false;
    logThrottle.set(message, now);
    return true;
}

gun._.on('in', (msg: any) => {
    if (msg.put) {
        const souls = Object.keys(msg.put).join(', ');
        if (throttleLog(`write_${souls}`, 60000)) {
            console.log(`Incoming write request for souls: ${souls}`);
        }
    }
});

(gun as any)._.on('put', async (msg: any, eve: any) => {
    try {
        if (!msg.souls || !msg.data || typeof msg.data !== 'object') {
            if (throttleLog('invalid_put')) {
                console.log('Skipping invalid put request');
            }
            return;
        }
        const { souls, data } = msg;
        for (const soul in data) {
            try {
                if (soul === 'test' || soul.startsWith('knownPeers')) {
                    if (data[soul] === null) {
                        console.log(`Write detected: ${soul} (cleanup)`);
                        continue;
                    } else if (throttleLog(`write_${soul}`, 60000)) {
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
                    const verified = await verifyGunWrite(nodeData, soul, msg, eve);
                    if (!verified) {
                        console.warn(`Write rejected for soul: ${soul}`);
                        return;
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

async function verifyGunWrite(data: any, key: string, msg: any, eve: any): Promise<boolean> {
    if (key === 'test' || key.startsWith('knownPeers')) {
        if (data === null) {
            console.log(`SEA: Allowing null write for ${key}`);
            return true;
        }
        if (key.startsWith('knownPeers')) {
            if (!data || !data.url || !data.timestamp) {
                console.warn(`SEA: Rejecting invalid knownPeers write: ${key}`);
                return false;
            }
            const validUrlPattern = /^https:\/\/[a-zA-Z0-9-.]+\.[a-zA-Z]{2,}(:\d+)?\/gun$/;
            if (!validUrlPattern.test(data.url)) {
                console.warn(`SEA: Rejecting knownPeers write with invalid URL: ${data.url}`);
                return false;
            }
            if (data.url === `${publicUrl}/gun` && key !== peerId) {
                return false;
            }
            return true;
        }
        return true;
    }

    if (data === null || key.includes('replicationMarker') || !data.id) {
        return true;
    }

    if (!data || typeof data !== 'object') {
        console.warn(`SEA: Rejecting invalid data: ${key}`);
        return false;
    }

    const did = data.author || (data.deletion && data.deletion.author);
    if (!did) {
        console.error(`SEA: Write rejected: Missing author DID for key: ${key}`);
        return false;
    }

    try {
        await checkRateLimit(did);
    } catch (error) {
        console.error(`SEA: Write rejected: Rate limit exceeded for DID: ${did}`);
        return false;
    }

    if (data.isDeleted) {
        const deletionNode = gun.get('deletions').get(key);
        const deletionData = await new Promise<{ signature?: string; author?: string; timestamp?: number; nonce?: string }>((resolve) => {
            deletionNode.once((d) => resolve(d));
        });

        if (!deletionData || !deletionData.signature || !deletionData.author) {
            console.error(`SEA: Deletion rejected: Missing deletion signature for key: ${key}`);
            gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                action: 'delete',
                key,
                error: 'Missing deletion signature',
                timestamp: Date.now()
            });
            return false;
        }

        try {
            const publicKey = await extractPublicKeyFromDID(deletionData.author);
            const verified = await SEA.verify(JSON.stringify({
                key,
                timestamp: deletionData.timestamp,
                nonce: deletionData.nonce
            }), publicKey);

            if (!verified) {
                console.error(`SEA: Deletion rejected: Invalid signature for key: ${key}`);
                gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                    action: 'delete',
                    key,
                    error: 'Invalid deletion signature',
                    timestamp: Date.now()
                });
                return false;
            }

            const now = Date.now();
            if (Math.abs(now - deletionData.timestamp!) > 30 * 60 * 1000) {
                console.error(`SEA: Deletion rejected: Signature timestamp too old for key: ${key}`);
                gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                    action: 'delete',
                    key,
                    error: 'Signature timestamp too old',
                    timestamp: Date.now()
                });
                return false;
            }

            const isAdmin = await new Promise<boolean>((resolve) => {
                gun.get('admins').get(did).once((data) => resolve(!!data));
            });
            const targetNode = gun.get(key.split('/')[0]).get(key.split('/')[1]).get(key.split('/')[2]);
            const targetData = await new Promise<any>((resolve) => {
                targetNode.once((d) => resolve(d));
            });

            if (!isAdmin && deletionData.author !== targetData?.author) {
                console.error(`SEA: Deletion rejected: Unauthorized DID for key: ${key}`);
                gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                    action: 'delete',
                    key,
                    error: 'Unauthorized DID',
                    timestamp: Date.now()
                });
                return false;
            }

            return true;
        } catch (error) {
            console.error(`SEA: Deletion verification failed for key: ${key}`, error);
            gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                action: 'delete',
                key,
                error: (error as Error).message,
                timestamp: Date.now()
            });
            return false;
        }
    }

    if (!data.signature || !data.author) {
        console.warn(`SEA: Write rejected: Missing signature or author for key: ${key}`);
        gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
            action: 'write',
            key,
            error: 'Missing signature or author',
            timestamp: Date.now()
        });
        return false;
    }

    try {
        const publicKey = await extractPublicKeyFromDID(data.author);
        const dataToVerify = {
            id: data.id,
            url: data.url,
            content: data.content,
            author: data.author,
            timestamp: data.timestamp,
            nonce: data.nonce
        };
        const verified = await SEA.verify(JSON.stringify(dataToVerify), publicKey);

        if (!verified) {
            console.error(`SEA: Write rejected: Invalid signature for key: ${key}`);
            gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                action: 'write',
                key,
                error: 'Invalid signature',
                timestamp: Date.now()
            });
            return false;
        }

        const now = Date.now();
        if (Math.abs(now - data.timestamp) > 30 * 60 * 1000) {
            console.error(`SEA: Write rejected: Signature timestamp too old for key: ${key}`);
            gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
                action: 'write',
                key,
                error: 'Signature timestamp too old',
                timestamp: Date.now()
            });
            return false;
        }

        const versionKey = `${key}/versions/${data.timestamp}`;
        gun.get(versionKey).put(data, (ack: any) => {
            if (ack && 'err' in ack) {
                console.error(`Failed to store version for key: ${versionKey}`, ack.err);
            }
        });

        return true;
    } catch (error) {
        console.error(`SEA: Verification failed for key: ${key}`, error);
        gun.get('securityLogs').get(did).get(`${Date.now()}`).put({
            action: 'write',
            key,
            error: (error as Error).message,
            timestamp: Date.now()
        });
        return false;
    }
}

const rateLimits = new Map<string, { count: number; startTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_ACTIONS_PER_WINDOW = 100;

async function checkRateLimit(did: string): Promise<void> {
    const now = Date.now();
    let record = rateLimits.get(did) || { count: 0, startTime: now };

    if (now - record.startTime > RATE_LIMIT_WINDOW) {
        record = { count: 0, startTime: now };
    }

    if (record.count >= MAX_ACTIONS_PER_WINDOW) {
        throw new Error('Rate limit exceeded');
    }

    record.count++;
    rateLimits.set(did, record);
    gun.get('rateLimits').get(did).put(record, (ack: any) => {
        if (ack && 'err' in ack) {
            console.error('Failed to update rate limit for DID:', did, ack.err);
        }
    });
}

const peerId = `${publicUrl}-bootstrap`;

function getShardKey(url: string): { domainShard: string; subShard?: string } {
    const normalizedUrl = normalizeUrl(url);
    const urlObj = new URL(normalizedUrl);
    const domain = urlObj.hostname.replace(/\./g, '_');
    const domainShard = `annotations_${domain}`;

    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
    if (highTrafficDomains.includes(domain)) {
        const hash = simpleHash(normalizedUrl);
        const subShardIndex = hash % 10;
        return { domainShard, subShard: `${domainShard}_shard_${subShardIndex}` };
    }

    return { domainShard };
}

async function extractPublicKeyFromDID(did: string): Promise<string> {
    if (!did.startsWith('did:key:')) {
        throw new Error('Invalid DID format');
    }
    const keyPart = did.split('did:key:')[1];
    return keyPart;
}

const ensureServerPeer = () => {
    console.log('Ensuring server peer in knownPeers...');
    gun.get('knownPeers').get(peerId).once((data) => {
        console.log('Current server peer data:', data);
        const now = Date.now();
        const peerData = {
            url: `${publicUrl}/gun`,
            timestamp: now,
            lastConnection: now,
        };
        gun.get('knownPeers').get(peerId).put(peerData, (ack: any) => {
            if (ack && 'err' in ack) {
                console.error('Failed to register server in knownPeers:', ack.err);
            } else {
                console.log(`Successfully registered server in knownPeers: ${publicUrl}/gun`);
            }
        });
    });
};

let serverPeerUpdateCount = 0;
setInterval(() => {
    const now = Date.now();
    gun.get('knownPeers').get(peerId).put({
        url: `${publicUrl}/gun`,
        timestamp: now,
        lastConnection: now,
    }, (ack: any) => {
        serverPeerUpdateCount++;
        if (ack && 'err' in ack) {
            console.error(`Failed to update server peer lastConnection: ${ack.err}`);
        } else if (serverPeerUpdateCount % 10 === 0 || throttleLog('server_peer_update', 3600000)) {
            console.log(`Updated server peer lastConnection: ${peerId}`);
        }
    });
}, 5 * 60 * 1000);

const peerConnectionCount = new Map<string, number>();
gun.on('hi', (peer: any) => {
    if (peer.url) {
        console.log('Connected to peer:', peer.url);
        const peerId = peer.url.replace(/[^a-zA-Z0-9-]/g, '-') || `peer-${Date.now()}`;
        gun.get('knownPeers').get(peerId).once((data) => {
            const now = Date.now();
            const peerData = {
                url: peer.url,
                timestamp: data?.timestamp || now,
                lastConnection: now,
            };
            gun.get('knownPeers').get(peerId).put(peerData, (ack: any) => {
                const count = (peerConnectionCount.get(peerId) || 0) + 1;
                peerConnectionCount.set(peerId, count);
                if (ack && 'err' in ack) {
                    console.error(`Failed to update lastConnection for peer ${peerId}:`, ack.err);
                } else if (count % 10 === 0 || throttleLog(`peer_${peerId}_update`, 3600000)) {
                    console.log(`Updated lastConnection for peer: ${peerId}, URL: ${peer.url}`);
                }
            });
        });
    }
});

const profileCache = new Map<string, Profile>();

async function getProfileWithRetries(did: string, retries: number = 5, delay: number = 100): Promise<Profile | { handle: string }> {
    const startTime = Date.now();
    if (profileCache.has(did)) {
        return profileCache.get(did)!;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        const profile = await new Promise<Profile | null>((resolve) => {
            gun.get('profiles').get(did).once((data) => {
                if (data && data.handle) {
                    resolve({
                        did,
                        handle: data.handle,
                        profilePicture: data.profilePicture,
                    });
                } else {
                    gun.get(`user_${did}`).get('profile').once((userData) => {
                        if (userData && userData.handle) {
                            resolve({
                                did,
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
    return { handle: 'Unknown' };
}

async function fetchPageMetadata(url: string): Promise<{
    title: string;
    favicon: string | null;
    ogTitle: string | null;
    ogDescription: string | null;
    ogImage: string | null;
    twitterTitle: string | null;
    twitterDescription: string | null;
    twitterImage: string | null;
}> {
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const cleanHtml = purify.sanitize(response.data);
        const $ = cheerio.load(cleanHtml);

        const metadata = {
            title: $('title').text() || 'Untitled Page',
            favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || `${new URL(url).origin}/favicon.ico`,
            ogTitle: $('meta[property="og:title"]').attr('content') || null,
            ogDescription: $('meta[property="og:description"]').attr('content') || null,
            ogImage: $('meta[property="og:image"]').attr('content') || null,
            twitterTitle: $('meta[name="twitter:title"]').attr('content') || null,
            twitterDescription: $('meta[name="twitter:description"]').attr('content') || null,
            twitterImage: $('meta[name="twitter:image"]').attr('content') || null,
        };

        if (metadata.favicon && !metadata.favicon.startsWith('http')) {
            metadata.favicon = new URL(metadata.favicon, url).href;
        }

        return metadata;
    } catch (error) {
        console.error(`Failed to fetch metadata for ${url}:`, (error as Error).message);
        return {
            title: 'Untitled Page',
            favicon: null,
            ogTitle: null,
            ogDescription: null,
            ogImage: null,
            twitterTitle: null,
            twitterDescription: null,
            twitterImage: null,
        };
    }
}

app.get('/api/page-metadata', (async (req: Request, res: Response) => {
    const url = req.query.url as string | undefined;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        const metadata = await fetchPageMetadata(url);
        res.json(metadata);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch metadata' });
    }
}) as RequestHandler);

app.get('/api/debug/annotations', (async (req: Request, res: Response) => {
    const url = req.query.url as string | undefined;
    const annotationId = req.query.annotationId as string | undefined;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    if (!annotationId) {
        return res.status(400).json({ error: 'Missing annotationId parameter' });
    }

    try {
        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const annotationNodes = [
            gun.get(domainShard).get(normalizedUrl),
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []),
        ];

        const shardedData = await Promise.all(
            annotationNodes.map((node) =>
                new Promise((resolve) => {
                    const annotationData: { annotation?: Annotation } = {};
                    node.get(annotationId!).once((annotation) => {
                        if (annotation) {
                            annotationData.annotation = {
                                id: annotationId!,
                                url: annotation.url,
                                content: annotation.content,
                                author: annotation.author,
                                text: annotation.text || '',
                                timestamp: annotation.timestamp,
                                comments: [],
                                isDeleted: annotation.isDeleted || false,
                                screenshot: annotation.screenshot,
                                metadata: annotation.metadata || {
                                    title: '',
                                    favicon: null,
                                    ogTitle: null,
                                    ogDescription: null,
                                    ogImage: null,
                                    twitterTitle: null,
                                    twitterDescription: null,
                                    twitterImage: null,
                                },
                            };

                            const comments: Comment[] = [];
                            const commentIds = new Set();
                            let nodesProcessed = 0;
                            const totalNodes = annotationNodes.length;

                            const timeout = setTimeout(() => {
                                nodesProcessed = totalNodes;
                                resolve({ annotation: annotationData.annotation, comments });
                            }, 500);

                            node.get(annotationId!).get('comments').map().once((comment, commentId) => {
                                if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                    commentIds.add(commentId);
                                    comments.push({
                                        id: commentId,
                                        annotationId: annotationId!,
                                        content: comment.content,
                                        author: comment.author,
                                        timestamp: comment.timestamp,
                                        isDeleted: comment.isDeleted || false,
                                    });
                                }
                                nodesProcessed++;
                                if (nodesProcessed === totalNodes) {
                                    clearTimeout(timeout);
                                    resolve({ annotation: annotationData.annotation, comments });
                                }
                            });

                            if (nodesProcessed === 0) {
                                setTimeout(() => {
                                    if (nodesProcessed === 0) {
                                        clearTimeout(timeout);
                                        resolve({ annotation: annotationData.annotation, comments });
                                    }
                                }, 100);
                            }
                        } else {
                            resolve(null);
                        }
                    });
                })
            )
        );

        res.json({
            shardedData: shardedData.filter(data => data !== null),
        });
    } catch (error) {
        console.error('Error debugging annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

app.post('/api/shorten', express.json(), sanitizeInput, (async (req: Request, res: Response) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
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

        const shortUrl = response.data.shortURL;
        console.log(`Successfully shortened URL: ${url} to ${shortUrl}`);
        res.json({ shortUrl });
    } catch (error) {
        console.error('Error shortening URL:', (error as any).response?.data || (error as Error).message);
        res.status(500).json({ error: 'Failed to shorten URL' });
    }
}) as RequestHandler);

const annotationCache = new Map<string, number>();

app.get('/api/annotations', (async (req: Request, res: Response) => {
    const totalStartTime = Date.now();
    const url = req.query.url as string | undefined;
    const annotationId = req.query.annotationId as string | undefined;

    if (!url) {
        console.log(`[Timing] Request failed: Missing url parameter`);
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const cacheClearStart = Date.now();
        profileCache.clear();
        annotationCache.clear();
        const cacheClearEnd = Date.now();
        if (throttleLog('cache_clear', 3600000)) {
            console.log(`[Timing] Cleared caches in ${cacheClearEnd - cacheClearStart}ms`);
        }

        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const annotationNodes = [
            gun.get(domainShard).get(normalizedUrl),
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []),
        ];

        const annotations: (Annotation & { authorHandle?: string; authorProfilePicture?: string; comments: Comment[] })[] = [];
        const loadedAnnotations = new Set<string>();
        const maxWaitTime = 5000;

        await new Promise<void>((resolve) => {
            const onAnnotation = (annotation: Annotation | null, key: string) => {
                if (!annotation || !annotation.id || !annotation.content || !annotation.author || !annotation.timestamp) {
                    return;
                }
                const cacheKey = `${normalizedUrl}:${annotation.id}`;
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
                    text: annotation.text || '',
                    timestamp: annotation.timestamp,
                    comments: [],
                    isDeleted: annotation.isDeleted || false,
                    screenshot: annotation.screenshot,
                    metadata: annotation.metadata || {
                        title: '',
                        favicon: null,
                        ogTitle: null,
                        ogDescription: null,
                        ogImage: null,
                        twitterTitle: null,
                        twitterDescription: null,
                        twitterImage: null,
                    },
                });
            };

            annotationNodes.forEach(node => {
                node.map().on(onAnnotation, { change: true });
            });

            setTimeout(() => {
                annotationNodes.forEach(node => node.map().off());
                resolve();
            }, maxWaitTime);
        });

        if (!annotations.length) {
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        annotations.sort((a, b) => b.timestamp - a.timestamp);

        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                const profile = await getProfileWithRetries(annotation.author);
                const commentsData = await Promise.all(
                    annotationNodes.map((node) =>
                        new Promise<Comment[]>((resolve) => {
                            const commentList: Comment[] = [];
                            const commentIds = new Set();
                            node.get(annotationId!).get('comments').map().once((comment, commentId) => {
                                if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                    commentIds.add(commentId);
                                    commentList.push({
                                        id: commentId,
                                        annotationId: annotationId!,
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

                const flattenedComments: Comment[] = [];
                const seenCommentIds = new Set();
                for (const commentList of commentsData) {
                    for (const comment of commentList) {
                        if (!seenCommentIds.has(comment.id)) {
                            seenCommentIds.add(comment.id);
                            flattenedComments.push(comment);
                        }
                    }
                }

                const resolvedComments: Comment[] = [];
                const resolvedCommentIds = new Set();
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

                let metadata = annotation.metadata;
                if (!annotation.screenshot) {
                    metadata = await fetchPageMetadata(normalizedUrl);
                }

                return {
                    ...annotation,
                    authorHandle: profile.handle,
                    authorProfilePicture: 'profilePicture' in profile ? profile.profilePicture : undefined,
                    comments: commentsWithAuthors,
                    metadata,
                };
            })
        );

        await Promise.all(
            annotationNodes.map(node =>
                new Promise<void>((resolve) => {
                    node.put({ replicationMarker: Date.now() }, (ack: any) => {
                        if (ack && 'err' in ack) {
                            console.error(`Failed to force replication for node: ${(node as any)._.get}, URL: ${normalizedUrl}, Error:`, ack.err);
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

        res.json({ annotations: annotationsWithDetails });
    } catch (error) {
        console.error('Error fetching annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
}) as RequestHandler);

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.join(', ')}`);