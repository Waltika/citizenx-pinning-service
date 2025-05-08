import Gun from 'gun';
import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import RateLimit from 'express-rate-limit';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const port = process.env.PORT || 10000;
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';
const initialPeers = [];

const app = express();

// Setup DOMPurify with JSDOM
const window = new JSDOM('').window;
const purify = DOMPurify(window);

// Enhanced CORS configuration with production extension ID
const corsOptions = {
    origin: [
        'https://citizenx.app',
        'chrome-extension://mbmlbbmhjhcmmpbieofegoefkhnbjmbj', // Production Chrome extension ID
        'chrome-extension://klblcgbgljcpamgpmdccefaalnhndjap', // Development Chrome extension ID
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'X-User-DID'],
    optionsSuccessStatus: 200,
};
app.use(cors(corsOptions));

// Rate limiting configuration
const limiter = RateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each DID to 100 requests per windowMs
    keyGenerator: (req) => req.headers['x-user-did'] || req.ip, // Use DID if available, else IP
    message: 'Too many requests, please try again later.',
});
app.use(limiter);

// Middleware to parse JSON bodies
app.use(express.json());

// Sanitize input middleware
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

// Ensure the /var/data/gun-data directory exists
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

// Read the Short.io API key from /var/data/short.key
let shortIoApiKey = '';
try {
    shortIoApiKey = fs.readFileSync('/var/data/short.key', 'utf8').trim();
    console.log('Successfully read Short.io API key from /var/data/short.key');
} catch (error) {
    console.error('Failed to read Short.io API key from /var/data/short.key:', error);
    process.exit(1); // Exit if the API key cannot be read
}

const gun = Gun({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
});

// Use a static peerId to persist across server restarts
const peerId = `${publicUrl}-bootstrap`;

// Helper function to normalize URLs
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

// Helper function to determine shard key
function getShardKey(url) {
    const normalizedUrl = normalizeUrl(url);
    const urlObj = new URL(normalizedUrl);
    const domain = urlObj.hostname.replace(/\./g, '_');
    const domainShard = `annotations_${domain}`;

    // Sub-sharding for high-traffic domains
    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
    if (highTrafficDomains.includes(domain)) {
        const hash = simpleHash(normalizedUrl);
        const subShardIndex = hash % 10; // 10 sub-shards
        return { domainShard, subShard: `${domainShard}_shard_${subShardIndex}` };
    }

    return { domainShard };
}

// Simple hash function for sub-sharding
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
}

// Helper function to check if a user is an admin
async function isAdmin(did) {
    return new Promise((resolve) => {
        gun.get('admins').get(did).once((data) => {
            resolve(!!data);
        });
    });
}

// Middleware to verify deletion permissions
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
            // Verify comment deletion
            const comment = await new Promise((resolve) => {
                annotationNodes[0].get(annotationId).get('comments').get(commentId).once((data) => resolve(data));
            });

            if (!comment) {
                return res.status(404).json({ error: 'Comment not found' });
            }
            targetAuthor = comment.author;
        } else {
            // Verify annotation deletion
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

// One-time cleanup of null entries on startup
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

// Ensure the server's entry in knownPeers on startup
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

// Run cleanup and peer registration on startup
cleanupNullEntries();
ensureServerPeer();

// Periodically update server peer timestamp
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

// Throttle peer cleanup to reduce unnecessary updates
let lastCleanup = 0;
const cleanupInterval = 2 * 60 * 1000; // Reduced to 2 minutes
const cleanupThrottle = 1 * 60 * 1000; // Throttle to 1 minute between cleanups

// Track removed peers to avoid redundant logging
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
            return; // Skip already processed peers
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

    // Clear the removedPeers set after a longer period to allow for new entries
    setTimeout(() => {
        removedPeers.clear();
        console.log('Cleared removedPeers set');
    }, 24 * 60 * 60 * 1000); // Clear every 24 hours
}, cleanupInterval);

// In-memory cache for profiles
const profileCache = new Map();

async function getProfileWithRetries(did, retries = 5, delay = 200) {
    if (profileCache.has(did)) {
        return profileCache.get(did);
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
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

// Debug endpoint to inspect sharded node data
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

        // Fetch from sharded nodes
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
                            };

                            const comments = [];
                            node.get(annotationId).get('comments').map().once((comment, commentId) => {
                                if (comment) {
                                    comments.push({
                                        id: commentId,
                                        content: comment.content,
                                        author: comment.author,
                                        timestamp: comment.timestamp,
                                        isDeleted: comment.isDeleted || false,
                                    });
                                }
                            });
                            setTimeout(() => {
                                annotationData.comments = comments;
                                resolve(annotationData);
                            }, 5000);
                        } else {
                            resolve(null);
                        }
                    });
                })
            )
        );

        // Fetch from legacy node (for debugging)
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
                    };

                    const comments = [];
                    legacyNode.get(annotationId).get('comments').map().once((comment, commentId) => {
                        if (comment) {
                            comments.push({
                                id: commentId,
                                content: comment.content,
                                author: comment.author,
                                timestamp: comment.timestamp,
                                isDeleted: comment.isDeleted || false,
                            });
                        }
                    });
                    setTimeout(() => {
                        annotationData.comments = comments;
                        resolve(annotationData);
                    }, 5000);
                } else {
                    resolve(null);
                }
            });
        });

        res.json({
            shardedData: shardedData.filter(data => data !== null),
            legacyData: legacyData || 'Tombstoned or empty',
        });
    } catch (error) {
        console.error('Error debugging annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// New endpoint for URL shortening
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

// Endpoint to fetch annotations
app.get('/api/annotations', async (req, res) => {
    const url = req.query.url;
    const annotationId = req.query.annotationId;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        // Clear profile cache to avoid stale data
        profileCache.clear();
        console.log('Cleared profile cache for request');

        const normalizedUrl = normalizeUrl(url);
        console.log('Normalized URL for query:', normalizedUrl);

        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const annotationNodes = [
            gun.get(domainShard).get(normalizedUrl), // Primary shard
            ...(subShard ? [gun.get(subShard).get(normalizedUrl)] : []), // Sub-shard
        ];

        const maxRetries = 3;
        let annotations = [];

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            const loadedAnnotations = new Set();
            annotations = await Promise.all(
                annotationNodes.map((node) =>
                    new Promise((resolve) => {
                        const annotationList = [];
                        node.map().once((annotation, key) => {
                            // Skip non-annotation nodes
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
                            annotationList.push({
                                id: annotation.id,
                                url: annotation.url,
                                content: annotation.content,
                                author: annotation.author,
                                timestamp: annotation.timestamp,
                            });
                            console.log(`Loaded annotation for URL: ${normalizedUrl}, ID: ${annotation.id}`);
                        });
                        setTimeout(() => {
                            console.log(
                                `Attempt ${attempt}: Annotations found from node:`,
                                annotationList
                            );
                            resolve(annotationList);
                        }, 5000); // Increased timeout to match debug endpoint
                    })
                )
            );

            // Flatten and deduplicate annotations
            annotations = [...new Set(annotations.flat())];

            if (annotations.length > 0 || attempt === maxRetries) {
                break;
            }

            console.log(
                `Retrying annotation fetch for URL: ${normalizedUrl}, attempt ${attempt}/${maxRetries}`
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (!annotations || annotations.length === 0) {
            console.log(`No valid annotations found for URL: ${normalizedUrl} after ${maxRetries} attempts`);
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                const profile = await getProfileWithRetries(annotation.author);

                const commentsData = await Promise.all(
                    annotationNodes.map((node) =>
                        new Promise((resolve) => {
                            const commentList = [];
                            const commentIds = new Set();

                            node
                                .get(annotation.id)
                                .get('comments')
                                .map()
                                .once((comment, commentId) => {
                                    if (comment && !commentIds.has(commentId)) {
                                        commentIds.add(commentId);
                                        if (!('isDeleted' in comment)) {
                                            console.warn(`Comment missing isDeleted field for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                            comment.isDeleted = false;
                                        }
                                        if (!comment.isDeleted) {
                                            console.log(`Including comment for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                            commentList.push({
                                                id: commentId,
                                                content: comment.content,
                                                author: comment.author,
                                                timestamp: comment.timestamp,
                                            });
                                        } else {
                                            console.log(`Skipped deleted comment for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                        }
                                    } else if (!comment) {
                                        console.warn(`Encountered null or undefined comment for annotation ${annotation.id}, Comment ID: ${commentId}`);
                                    }
                                });

                            setTimeout(() => resolve(commentList), 5000);
                        })
                    )
                );

                // Flatten and deduplicate comments
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

                // Consistency check across nodes
                const commentStates = await Promise.all(
                    annotationNodes.map((node) =>
                        new Promise((resolve) => {
                            const states = {};
                            node
                                .get(annotation.id)
                                .get('comments')
                                .map()
                                .once((comment, commentId) => {
                                    if (comment) {
                                        states[commentId] = comment.isDeleted || false;
                                    }
                                });
                            setTimeout(() => resolve(states), 5000);
                        })
                    )
                );

                // Check for inconsistencies
                const firstNodeStates = commentStates[0];
                for (let i = 1; i < commentStates.length; i++) {
                    const nodeStates = commentStates[i];
                    for (const commentId in firstNodeStates) {
                        if (nodeStates[commentId] !== undefined && nodeStates[commentId] !== firstNodeStates[commentId]) {
                            console.warn(
                                `Consistency warning: Comment ${commentId} has inconsistent isDeleted state across nodes: Node 0: ${firstNodeStates[commentId]}, Node ${i}: ${nodeStates[commentId]}`
                            );
                        }
                    }
                }

                const commentsWithAuthors = await Promise.all(
                    flattenedComments.map(async (comment) => {
                        const commentProfile = await getProfileWithRetries(comment.author);
                        return {
                            ...comment,
                            authorHandle: commentProfile.handle,
                        };
                    })
                );

                return {
                    ...annotation,
                    authorHandle: profile.handle,
                    authorProfilePicture: profile.profilePicture,
                    comments: commentsWithAuthors,
                };
            })
        );

        // Force replication
        const targetNode = subShard
            ? gun.get(subShard).get(normalizedUrl)
            : gun.get(domainShard).get(normalizedUrl);
        await new Promise((resolve) => {
            targetNode.put({ replicationMarker: Date.now() }, (ack) => {
                if (ack.err) {
                    console.error(`Failed to force replication for URL: ${normalizedUrl}, Error:`, ack.err);
                } else {
                    console.log(`Forced replication for sharded node at URL: ${normalizedUrl}`);
                }
                resolve();
            });
        });

        res.json({ annotations: annotationsWithDetails });
    } catch (error) {
        console.error('Error fetching annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to delete annotations
app.delete('/api/annotations', sanitizeInput, verifyDeletePermission, async (req, res) => {
    const { url, annotationId } = req.body;

    try {
        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const targetNode = subShard
            ? gun.get(subShard).get(normalizedUrl)
            : gun.get(domainShard).get(normalizedUrl);

        // Mark as deleted
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

// Endpoint to delete comments
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

        // Mark comment as deleted
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