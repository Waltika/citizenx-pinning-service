import Gun from 'gun';
import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import axios from 'axios';
import RateLimit from 'express-rate-limit';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';
import * as cheerio from 'cheerio'; // Corrected import for cheerio

const port = process.env.PORT || 10000;
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';
const initialPeers = [];

const app = express();

const window = new JSDOM('').window;
const purify = DOMPurify(window);

const corsOptions = {
    origin: [
        'https://citizenx.app',
        'chrome-extension://mbmlbbmhjhcmmpbieofegoefkhnbjmbj',
        'chrome-extension://klblcgbgljcpamgpmdccefaalnhndjap',
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-User-DID'],
    optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

const limiter = RateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: (req) => req.headers['x-user-did'] || req.ip,
    message: 'Too many requests, please try again later.',
});
app.use(limiter);

app.use(express.json());

const sanitizeInput = (req, res, next) => {
    if (req.body) {
        const sanitizeObject = (obj) => {
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

const server = http.createServer(app).listen(port);

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
    process.exit(1);
}

const gun = Gun({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
});

const peerId = `${publicUrl}-bootstrap`;

function normalizeUrl(url) {
    let cleanUrl = url.replace(/^(https?:\/\/)+/, 'https://');
    cleanUrl = cleanUrl.replace(/\/+$/, '');
    const urlObj = new URL(cleanUrl);
    const params = new URLSearchParams(urlObj.search);
    for (const key of params.keys()) {
        if (key.startsWith('utm_')) {
            params.delete(key);
        }
    }
    urlObj.search = params.toString();
    return urlObj.toString();
}

function getShardKey(url) {
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

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash);
}

async function isAdmin(did) {
    return new Promise((resolve) => {
        gun.get('admins').get(did).once((data) => {
            resolve(!!data);
        });
    });
}

const verifyDeletePermission = async (req, res, next) => {
    const requesterDid = req.headers['x-user-did'];
    const { url, annotationId, commentId } = req.body;

    if (!requesterDid) {
        return res.status(401).json({ error: 'Unauthorized: Missing X-User-DID header' });
    }

    if (!url || !annotationId) {
        return res.status(400).json({ error: 'Missing required parameters' });
    }

    try {
        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const annotationNodes = [
            gun.get(domainShard).get(normalizedUrl),
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []),
        ];

        let annotation;
        for (const node of annotationNodes) {
            const data = await new Promise((resolve) => {
                node.get(annotationId).once((data) => resolve(data));
            });
            if (data) {
                annotation = data;
                break;
            }
        }

        if (!annotation) {
            return res.status(404).json({ error: 'Annotation not found' });
        }

        let targetAuthor;
        if (commentId) {
            const comment = await new Promise((resolve) => {
                annotationNodes[0].get(annotationId).get('comments').get(commentId).once((data) => resolve(data));
            });

            if (!comment) {
                return res.status(404).json({ error: 'Comment not found' });
            }
            targetAuthor = comment.author;
        } else {
            targetAuthor = annotation.author;
        }

        const isRequesterAdmin = await isAdmin(requesterDid);
        if (requesterDid !== targetAuthor && !isRequesterAdmin) {
            return res.status(403).json({ error: 'Forbidden: You can only delete your own content or must be an admin' });
        }

        next();
    } catch (error) {
        console.error('Error verifying delete permission:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

const cleanupNullEntries = () => {
    console.log('Performing one-time cleanup of null entries in knownPeers...');
    gun.get('knownPeers').map().once((peer, id) => {
        if (!peer || !peer.url || !peer.timestamp) {
            console.log('Startup cleanup - Removing null or invalid peer entry:', id);
            gun.get('knownPeers').get(id).put(null, (ack) => {
                if (ack.err) {
                    console.error('Startup cleanup - Failed to remove peer entry:', id, ack.err);
                } else {
                    console.log('Startup cleanup - Successfully removed peer entry:', id);
                }
            });
        }
    });
};

const ensureServerPeer = () => {
    console.log('Ensuring server peer in knownPeers...');
    gun.get('knownPeers').get(peerId).once((data) => {
        console.log('Current server peer data:', data);
        const now = Date.now();
        const peerData = {
            url: `${publicUrl}/gun`,
            timestamp: now,
        };
        if (!data || !data.url || !data.timestamp || (now - data.timestamp > 10 * 60 * 1000)) {
            console.log('Registering server peer:', peerId);
            gun.get('knownPeers').get(peerId).put(peerData, (ack) => {
                if (ack.err) {
                    console.error('Failed to register server in knownPeers:', ack.err);
                } else {
                    console.log(`Successfully registered server in knownPeers: ${publicUrl}/gun`);
                }
            });
        } else {
            console.log('Server peer already registered and valid:', data.url, 'Age:', (now - data.timestamp) / 1000, 'seconds');
        }
    });
};

cleanupNullEntries();
ensureServerPeer();

setInterval(() => {
    const now = Date.now();
    console.log('Updating server peer timestamp...');
    const peerData = {
        url: `${publicUrl}/gun`,
        timestamp: now,
    };
    gun.get('knownPeers').get(peerId).put(peerData, (ack) => {
        if (ack.err) {
            console.error('Failed to update server timestamp in knownPeers:', ack.err);
        } else {
            console.log('Updated server timestamp in knownPeers');
        }
    });
}, 5 * 60 * 1000);

let lastCleanup = 0;
const cleanupInterval = 2 * 60 * 1000;
const cleanupThrottle = 1 * 60 * 1000;

const removedPeers = new Set();

setInterval(() => {
    const now = Date.now();
    if (now - lastCleanup < cleanupThrottle) {
        return;
    }

    lastCleanup = now;
    console.log('Running peer cleanup...');
    gun.get('knownPeers').map().once((peer, id) => {
        if (removedPeers.has(id)) {
            return;
        }

        if (!peer || !peer.url || !peer.timestamp) {
            console.log('Removing null or invalid peer entry:', id);
            gun.get('knownPeers').get(id).put(null, (ack) => {
                if (ack.err) {
                    console.error('Failed to remove peer entry:', id, ack.err);
                } else {
                    console.log('Successfully removed peer entry:', id);
                    removedPeers.add(id);
                }
            });
        } else {
            const age = now - peer.timestamp;
            if (age > 10 * 60 * 1000) {
                console.log('Removing stale peer:', peer.url, 'Age:', age / 1000, 'seconds');
                gun.get('knownPeers').get(id).put(null, (ack) => {
                    if (ack.err) {
                        console.error('Failed to remove stale peer:', id, ack.err);
                    } else {
                        console.log('Successfully removed stale peer:', id);
                        removedPeers.add(id);
                    }
                });
            }
        }
    });

    setTimeout(() => {
        removedPeers.clear();
        console.log('Cleared removedPeers set');
    }, 24 * 60 * 60 * 1000);
}, cleanupInterval);

const profileCache = new Map();

async function getProfileWithRetries(did, retries = 5, delay = 100) {
    const startTime = Date.now();
    if (profileCache.has(did)) {
        const endTime = Date.now();
        console.log(`Profile fetch for DID: ${did} (cached) took ${endTime - startTime}ms`);
        return profileCache.get(did);
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        const attemptStartTime = Date.now();
        const profile = await new Promise((resolve) => {
            gun.get('profiles').get(did).once((data) => {
                if (data && data.handle) {
                    resolve({
                        handle: data.handle,
                        profilePicture: data.profilePicture,
                    });
                } else {
                    gun.get(`user_${did}`).get('profile').once((userData) => {
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

        const attemptEndTime = Date.now();
        console.log(`Profile fetch attempt ${attempt}/${retries} for DID: ${did} took ${attemptEndTime - attemptStartTime}ms`);

        if (profile) {
            profileCache.set(did, profile);
            setTimeout(() => profileCache.delete(did), 5 * 60 * 1000);
            const endTime = Date.now();
            console.log(`Profile fetch for DID: ${did} (successful) took ${endTime - startTime}ms`);
            return profile;
        }

        console.log(`Retrying profile fetch for DID: ${did}, attempt ${attempt}/${retries}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    console.error('Failed to load profile for DID after retries:', did);
    const endTime = Date.now();
    console.log(`Profile fetch for DID: ${did} (failed) took ${endTime - startTime}ms`);
    return { handle: 'Unknown' };
}

async function fetchPageMetadata(url) {
    try {
        const response = await axios.get(url, { timeout: 5000 });
        const window = new JSDOM('').window;
        const purify = DOMPurify(window);
        const cleanHtml = purify.sanitize(response.data);
        const $ = cheerio.load(cleanHtml);

        const metadata = {
            title: $('title').text() || 'Untitled Page',
            favicon: $('link[rel="icon"]').attr('href') || $('link[rel="shortcut icon"]').attr('href') || `${new URL(url).origin}/favicon.ico`,
            ogTitle: $('meta[property="og:title"]').attr('content'),
            ogDescription: $('meta[property="og:description"]').attr('content'),
            ogImage: $('meta[property="og:image"]').attr('content'),
            twitterTitle: $('meta[name="twitter:title"]').attr('content'),
            twitterDescription: $('meta[name="twitter:description"]').attr('content'),
            twitterImage: $('meta[name="twitter:image"]').attr('content'),
        };

        if (metadata.favicon && !metadata.favicon.startsWith('http')) {
            metadata.favicon = new URL(metadata.favicon, url).href;
        }

        return metadata;
    } catch (error) {
        console.error(`Failed to fetch metadata for ${url}:`, error.message);
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

app.get('/api/page-metadata', async (req, res) => {
    const { url } = req.query;
    if (!url || typeof url !== 'string') {
        return res.status(400).json({ error: 'Invalid URL' });
    }

    try {
        const metadata = await fetchPageMetadata(url);
        res.json(metadata);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch metadata' });
    }
});

app.get('/api/debug/annotations', async (req, res) => {
    const url = req.query.url;
    const annotationId = req.query.annotationId;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }
    if (!annotationId) {
        return res.status(400).json({ error: 'Missing annotationId parameter' });
    }

    try {
        const normalizedUrl = normalizeUrl(url);
        console.log('Debug - Normalized URL:', normalizedUrl);

        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const annotationNodes = [
            gun.get(domainShard).get(normalizedUrl),
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []),
        ];

        const legacyNode = gun.get('annotations').get(normalizedUrl);

        const shardedData = await Promise.all(
            annotationNodes.map((node) =>
                new Promise((resolve) => {
                    const annotationData = {};
                    node.get(annotationId).once((annotation) => {
                        if (annotation) {
                            annotationData.annotation = {
                                id: annotationId,
                                url: annotation.url,
                                content: annotation.content,
                                author: annotation.author,
                                timestamp: annotation.timestamp,
                                isDeleted: annotation.isDeleted || false,
                                screenshot: annotation.screenshot,
                            };

                            const comments = [];
                            const commentIds = new Set();
                            let nodesProcessed = 0;
                            const totalNodes = annotationNodes.length;

                            const timeout = setTimeout(() => {
                                console.log(`Debug fetch comments for annotation ${annotationId} timed out after 500ms`);
                                nodesProcessed = totalNodes;
                                resolve(comments);
                            }, 500);

                            node.get(annotationId).get('comments').map().once((comment, commentId) => {
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
                                    resolve(comments);
                                }
                            });

                            if (nodesProcessed === 0) {
                                setTimeout(() => {
                                    if (nodesProcessed === 0) {
                                        clearTimeout(timeout);
                                        resolve(comments);
                                    }
                                }, 100);
                            }
                        } else {
                            resolve(null);
                        }
                    });
                }).then((comments) => {
                    if (comments) {
                        return {
                            annotation: {
                                id: annotationId,
                                url: normalizedUrl,
                                content: comments.content,
                                author: comments.author,
                                timestamp: comments.timestamp,
                                isDeleted: comments.isDeleted || false,
                                screenshot: comments.screenshot,
                            },
                            comments,
                        };
                    }
                    return null;
                })
            )
        );

        const legacyData = await new Promise((resolve) => {
            const annotationData = {};
            legacyNode.get(annotationId).once((annotation) => {
                if (annotation) {
                    annotationData.annotation = {
                        id: annotationId,
                        url: annotation.url,
                        content: annotation.content,
                        author: annotation.author,
                        timestamp: annotation.timestamp,
                        isDeleted: annotation.isDeleted || false,
                        screenshot: annotation.screenshot,
                    };

                    const comments = [];
                    const commentIds = new Set();
                    let nodesProcessed = 0;
                    const totalNodes = 1;

                    const timeout = setTimeout(() => {
                        console.log(`Debug fetch comments from legacy node for annotation ${annotationId} timed out after 500ms`);
                        nodesProcessed = totalNodes;
                        resolve(comments);
                    }, 500);

                    legacyNode.get(annotationId).get('comments').map().once((comment, commentId) => {
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
                            resolve(comments);
                        }
                    });

                    if (nodesProcessed === 0) {
                        setTimeout(() => {
                            if (nodesProcessed === 0) {
                                clearTimeout(timeout);
                                resolve(comments);
                            }
                        }, 100);
                    }
                } else {
                    resolve(null);
                }
            });
        }).then((comments) => {
            if (comments) {
                return {
                    annotation: {
                        id: annotationId,
                        url: normalizedUrl,
                        content: comments.content,
                        author: comments.author,
                        timestamp: comments.timestamp,
                        isDeleted: comments.isDeleted || false,
                        screenshot: comments.screenshot,
                    },
                    comments,
                };
            }
            return 'Tombstoned or empty';
        });

        res.json({
            shardedData: shardedData.filter(data => data !== null),
            legacyData: legacyData,
        });
    } catch (error) {
        console.error('Error debugging annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/shorten', express.json(), sanitizeInput, async (req, res) => {
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
        console.error('Error shortening URL:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to shorten URL' });
    }
});

app.get('/api/annotations', async (req, res) => {
    const totalStartTime = Date.now();
    console.log(`[Timing] Starting /api/annotations request at ${new Date().toISOString()}`);

    const url = req.query.url;
    const annotationId = req.query.annotationId;

    if (!url) {
        console.log(`[Timing] Request failed: Missing url parameter`);
        const endTime = Date.now();
        console.log(`[Timing] Total request time: ${endTime - totalStartTime}ms`);
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const cacheClearStart = Date.now();
        profileCache.clear();
        const cacheClearEnd = Date.now();
        console.log(`[Timing] Cleared profile cache in ${cacheClearEnd - cacheClearStart}ms`);

        const normalizedUrl = normalizeUrl(url);
        console.log('Normalized URL for query:', normalizedUrl);

        const { domainShard, subShard } = getShardKey(normalizedUrl);
        console.log(`Querying shards for URL: ${normalizedUrl}, domainShard: ${domainShard}, subShard: ${subShard}`);
        const annotationNodes = [
            gun.get('annotations').get(normalizedUrl),
            gun.get(domainShard).get(normalizedUrl),
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []),
        ];

        const fetchAnnotationsStart = Date.now();
        const annotations = [];
        const loadedAnnotations = new Set();
        const maxWaitTime = 3000; // Maximum time to wait for annotations (3 seconds)

        const fetchPromise = new Promise((resolve) => {
            // Use map().on() to listen for real-time updates
            const onAnnotation = (annotation, key) => {
                if (!annotation || !annotation.id || !annotation.content || !annotation.author || !annotation.timestamp) {
                    console.log(`Skipped non-annotation node for URL: ${normalizedUrl}, Key: ${key}, Data:`, annotation);
                    return;
                }
                if (loadedAnnotations.has(annotation.id)) {
                    console.log(`Skipped duplicate annotation for URL: ${normalizedUrl}, ID: ${annotation.id}`);
                    return;
                }
                if (annotation.isDeleted) {
                    console.log(`Skipped deleted annotation for URL: ${normalizedUrl}, ID: ${annotation.id}`);
                    return;
                }
                loadedAnnotations.add(annotation.id);
                annotations.push({
                    id: annotation.id,
                    url: annotation.url,
                    content: annotation.content,
                    author: annotation.author,
                    timestamp: annotation.timestamp,
                    screenshot: annotation.screenshot,
                });
                console.log(`Loaded annotation for URL: ${normalizedUrl}, ID: ${annotation.id}`);
            };

            // Attach listeners to all nodes
            annotationNodes.forEach(node => {
                node.map().on(onAnnotation);
            });

            // Wait for annotations to load or timeout
            setTimeout(() => {
                // Cleanup listeners
                annotationNodes.forEach(node => node.map().off());
                console.log(`Finished fetching annotations for URL: ${normalizedUrl}, Total annotations: ${annotations.length}`);
                resolve(annotations);
            }, maxWaitTime);
        });

        await fetchPromise;
        const fetchAnnotationsEnd = Date.now();
        console.log(`[Timing] Total fetch annotations time: ${fetchAnnotationsEnd - fetchAnnotationsStart}ms`);

        if (!annotations || annotations.length === 0) {
            console.log(`No valid annotations found for URL: ${normalizedUrl} after waiting ${maxWaitTime}ms`);
            const endTime = Date.now();
            console.log(`[Timing] Total request time: ${endTime - totalStartTime}ms`);
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                const profileStartTime = Date.now();
                const profile = await getProfileWithRetries(annotation.author);
                const profileEndTime = Date.now();
                console.log(`[Timing] Profile fetch for annotation author ${annotation.author} took ${profileEndTime - profileStartTime}ms`);

                const fetchCommentsStart = Date.now();
                const commentsData = await Promise.all(
                    annotationNodes.map((node, nodeIndex) =>
                        new Promise((resolve) => {
                            const commentList = [];
                            const commentIds = new Set();
                            let commentCount = 0;
                            let nodesProcessed = 0;
                            const totalNodes = annotationNodes.length;

                            const timeout = setTimeout(() => {
                                console.log(`Fetch comments for annotation ${annotation.id} timed out after 500ms with ${commentList.length} comments`);
                                resolve(commentList);
                            }, 500);

                            console.log(`Fetching comments for annotation ${annotation.id} from node: ${node._.get}`);
                            node.get(annotation.id).get('comments').map().once((comment, commentId) => {
                                console.log(`Found comment for annotation ${annotation.id}, Comment ID: ${commentId}, Data:`, comment);
                                if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                    commentIds.add(commentId);
                                    if (!('isDeleted' in comment)) {
                                        console.warn(`Comment missing isDeleted field for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                        comment.isDeleted = false;
                                    }
                                    commentList.push({
                                        id: commentId,
                                        content: comment.content,
                                        author: comment.author,
                                        timestamp: comment.timestamp,
                                        isDeleted: comment.isDeleted,
                                        nodeIndex,
                                    });
                                    commentCount++;
                                } else if (!comment) {
                                    console.warn(`Encountered null or undefined comment for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                } else {
                                    console.warn(`Skipping invalid comment for annotation ${annotation.id}, Comment ID: ${commentId}`, comment);
                                }
                                nodesProcessed++;
                                if (nodesProcessed === totalNodes) {
                                    console.log(`Finished fetching comments for node ${node._.get}: ${commentCount} comments found`);
                                }
                            });

                            setTimeout(() => {
                                if (nodesProcessed === totalNodes && commentCount === 0) {
                                    console.log(`No comments found for annotation ${annotation.id} in node: ${node._.get}`);
                                    clearTimeout(timeout);
                                    resolve(commentList);
                                }
                            }, 200);
                        })
                    )
                );
                const fetchCommentsEnd = Date.now();
                console.log(`[Timing] Fetch comments for annotation ${annotation.id} took ${fetchCommentsEnd - fetchCommentsStart}ms`);

                const flattenedComments = [];
                const seenCommentIds = new Set();
                for (const commentList of commentsData) {
                    for (const comment of commentList) {
                        if (!seenCommentIds.has(comment.id)) {
                            seenCommentIds.add(comment.id);
                            flattenedComments.push(comment);
                        }
                    }
                }

                let resolvedComments = [];
                if (flattenedComments.length > 0) {
                    const consistencyCheckStart = Date.now();

                    const commentsById = new Map();
                    for (const comment of flattenedComments) {
                        if (!commentsById.has(comment.id)) {
                            commentsById.set(comment.id, []);
                        }
                        commentsById.get(comment.id).push(comment);
                    }

                    resolvedComments = [];
                    const resolvedCommentIds = new Set();
                    for (const [commentId, commentInstances] of commentsById.entries()) {
                        if (resolvedCommentIds.has(commentId)) continue;
                        resolvedCommentIds.add(commentId);

                        let isDeleted = true;
                        const statesList = commentInstances.map(c => c.isDeleted);
                        console.log(`Consistency check for comment ${commentId}: States across nodes:`, statesList);

                        for (const state of statesList) {
                            if (state === false) {
                                isDeleted = false;
                                break;
                            }
                        }

                        const firstState = statesList[0];
                        for (let i = 1; i < statesList.length; i++) {
                            if (statesList[i] !== firstState) {
                                console.warn(
                                    `Consistency warning: Comment ${commentId} has inconsistent isDeleted state across nodes:`,
                                    statesList
                                );
                            }
                        }

                        if (!isDeleted) {
                            console.log(`Including comment ${commentId} as it is not deleted in at least one node`);
                            resolvedComments.push(commentInstances[0]);
                        } else {
                            console.log(`Excluding comment ${commentId} as it is marked as deleted in all nodes`);
                        }
                    }

                    const consistencyCheckEnd = Date.now();
                    console.log(`[Timing] Consistency check for annotation ${annotation.id} took ${consistencyCheckEnd - consistencyCheckStart}ms`);
                } else {
                    console.log(`[Timing] Skipped consistency check for annotation ${annotation.id} (no comments to process)`);
                }

                const fetchCommentProfilesStart = Date.now();
                const commentsWithAuthors = await Promise.all(
                    resolvedComments.map(async (comment) => {
                        const commentProfile = await getProfileWithRetries(comment.author);
                        return {
                            ...comment,
                            authorHandle: commentProfile.handle,
                        };
                    })
                );
                const fetchCommentProfilesEnd = Date.now();
                console.log(`[Timing] Fetch comment profiles for annotation ${annotation.id} took ${fetchCommentProfilesEnd - fetchCommentProfilesStart}ms`);

                let metadata;
                if (!annotation.screenshot) {
                    const metadataStart = Date.now();
                    metadata = await fetchPageMetadata(normalizedUrl);
                    const metadataEnd = Date.now();
                    console.log(`[Timing] Fetch metadata for URL ${normalizedUrl} took ${metadataEnd - metadataStart}ms`);
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

        const replicationStart = Date.now();
        await Promise.all(
            annotationNodes.map(node =>
                new Promise((resolve) => {
                    node.put({ replicationMarker: Date.now() }, (ack) => {
                        if (ack.err) {
                            console.error(`Failed to force replication for node: ${node._.get}, URL: ${normalizedUrl}, Error:`, ack.err);
                        } else {
                            console.log(`Forced replication for node: ${node._.get}, URL: ${normalizedUrl}`);
                        }
                        resolve();
                    });
                })
            )
        );
        const replicationEnd = Date.now();
        console.log(`[Timing] Write replication marker took ${replicationEnd - replicationStart}ms`);

        const endTime = Date.now();
        console.log(`[Timing] Total request time: ${endTime - totalStartTime}ms`);

        res.json({ annotations: annotationsWithDetails });
    } catch (error) {
        console.error('Error fetching annotations:', error);
        const endTime = Date.now();
        console.log(`[Timing] Total request time (with error): ${endTime - totalStartTime}ms`);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/annotations', sanitizeInput, verifyDeletePermission, async (req, res) => {
    const { url, annotationId } = req.body;

    try {
        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const targetNode = subShard
            ? gun.get(subShard).get(normalizedUrl)
            : gun.get(domainShard).get(normalizedUrl);

        await new Promise((resolve, reject) => {
            targetNode.get(annotationId).put({ isDeleted: true }, (ack) => {
                if (ack.err) {
                    console.error(
                        `Failed to mark annotation as deleted for URL: ${normalizedUrl}, ID: ${annotationId}, Error:`,
                        ack.err
                    );
                    reject(new Error(ack.err));
                } else {
                    console.log(
                        `Successfully marked annotation as deleted for URL: ${normalizedUrl}, ID: ${annotationId}`
                    );
                    resolve();
                }
            });
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting annotation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.delete('/api/comments', sanitizeInput, verifyDeletePermission, async (req, res) => {
    const { url, annotationId, commentId } = req.body;

    if (!commentId) {
        return res.status(400).json({ error: 'Missing commentId parameter' });
    }

    try {
        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const targetNode = subShard
            ? gun.get(subShard).get(normalizedUrl)
            : gun.get(domainShard).get(normalizedUrl);

        await new Promise((resolve, reject) => {
            targetNode.get(annotationId).get('comments').get(commentId).put({ isDeleted: true }, (ack) => {
                if (ack.err) {
                    console.error(
                        `Failed to mark comment as deleted for URL: ${normalizedUrl}, Annotation ID: ${annotationId}, Comment ID: ${commentId}, Error:`,
                        ack.err
                    );
                    reject(new Error(ack.err));
                } else {
                    console.log(
                        `Successfully marked comment as deleted for URL: ${normalizedUrl}, Annotation ID: ${annotationId}, Comment ID: ${commentId}`
                    );
                    resolve();
                }
            });
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Error deleting comment:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.length > 0 ? initialPeers.join(', ') : 'none'}`);

gun.on('hi', (peer) => {
    console.log('Connected to peer:', peer);
});