import Gun from 'gun';
import http from 'http';
import express, { Express, Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import { fetchPageMetadata } from './utils/fetchPageMetadata.js';
import { verifyGunWrite } from './utils/verifyGunWrite.js';
import { limiter, checkRateLimit, PeerData } from './utils/rateLimit.js';
import { Annotation, Metadata } from './utils/types.js';
import SEA from 'gun/sea.js';

const port: number = parseInt(process.env.PORT || '10000', 10);
const publicUrl: string = 'https://citizen-x-bootsrap.onrender.com';
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
        fs.mkdirSync(dataDir, { recursive: true });
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
        const { data } = msg;
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
                const hash = require('crypto').createHash('sha256').update(cleanUrl).digest('hex').slice(0, 8);
                const subShardIndex = parseInt(hash, 16) % 10;
                return { domainShard, subShard: `${domainShard}_shard_${subShardIndex}` };
            }

            return { domainShard };
        }

        app.get('/api/page-metadata', async (req: Request, res: Response) => {
            const { url } = req.query;
            if (!url || typeof url !== 'string') {
                return res.status(400).json({ error: 'Invalid URL' });
            }

            try {
                const metadata: Metadata = await fetchPageMetadata(url);
                res.json(metadata);
            } catch (error) {
                res.status(500).json({ error: 'Failed to fetch metadata' });
            }
        });

        app.get('/api/debug/annotations', async (req: Request, res: Response) => {
            const url = req.query.url as string | undefined;
            const annotationId = req.query.annotationId as string | undefined;

            if (!url || !annotationId) {
                return res.status(400).json({ error: 'Missing url or annotationId parameter' });
            }

            try {
                const { domainShard, subShard } = getShardKey(url);
                const annotationNodes = [
                    gun.get(domainShard).get(url),
                    ...(subShard ? [gun.get(subShard).get(url)] : []),
                ];

                const shardedData = await Promise.all(
                    annotationNodes.map((node) =>
                        new Promise((resolve) => {
                            const annotationData: { annotation?: Annotation; comments: any[] } = { comments: [] };
                            node.get(annotationId).once((annotation: any) => {
                                if (annotation) {
                                    annotationData.annotation = {
                                        id: annotationId,
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
                                        resolve({ annotation: annotationData.annotation, comments });
                                    }, 500);

                                    node.get(annotationId).get('comments').map().once((comment: any, commentId: string) => {
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
        });

        app.post('/api/shorten', async (req: Request, res: Response) => {
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

                const shortUrl: string = response.data.shortURL;
                console.log(`Successfully shortened URL: ${url} to ${shortUrl}`);
                res.json({ shortUrl });
            } catch (error: any) {
                console.error('Error shortening URL:', error.response?.data || error.message);
                res.status(500).json({ error: 'Failed to shorten URL' });
            }
        });

// Placeholder for /viewannotation route
        app.get('/viewannotation/:annotationId/:base64Url', async (req: Request, res: Response) => {
            res.status(501).send('Not implemented yet');
        });

        console.log(`Gun server running on port ${port}`);
        console.log(`Public URL: ${publicUrl}/gun`);
        console.log(`Initial peers: ${initialPeers.join(', ')}`);