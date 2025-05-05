imp rt Gun from 'gun';
import http from 'http';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';

const port = process.env.PORT || 8765;
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';
const initialPeers = [];

const app = express();
app.use(cors({
    origin: 'https://citizenx.app',
    methods: ['GET'],
}));

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
    console.warn('Data persistence may not work on Render free plan without a persistent disk.');
}

const gun = Gun({
    web: server,
    peers: initialPeers,
    file: dataDir, // Store data in /var/data/gun-data
    radisk: true,
});

const peerId = `${publicUrl}-${Date.now()}`;
gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
    if (ack.err) {
        console.error('Failed to register server in knownPeers:', ack.err);
    } else {
        console.log(`Registered server in knownPeers: ${publicUrl}/gun`);
    }
});

setInterval(() => {
    gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
        if (ack.err) {
            console.error('Failed to update server timestamp in knownPeers:', ack.err);
        }
    });
}, 5 * 60 * 1000);

setInterval(() => {
    gun.get('knownPeers').map().once((peer, id) => {
        if (peer && peer.url && peer.timestamp) {
            const now = Date.now();
            const age = now - peer.timestamp;
            if (age > 10 * 60 * 1000) {
                console.log('Removing stale peer:', peer.url);
                gun.get('knownPeers').get(id).put(null);
            }
        }
    });
}, 5 * 60 * 1000);

// In-memory cache for profiles
const profileCache = new Map();

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

async function getProfileWithRetries(did, retries = 5, delay = 200) {
    // Check cache first
    if (profileCache.has(did)) {
        return profileCache.get(did);
    }

    // Retry fetching the profile from Gun.js
    for (let attempt = 1; attempt <= retries; attempt++) {
        const profile = await new Promise((resolve) => {
            gun.get('profiles').get(did).once((data) => {
                if (data && data.handle) {
                    resolve({
                        handle: data.handle,
                        profilePicture: data.profilePicture,
                    });
                } else {
                    // Fallback to user-specific namespace
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
            // Cache the profile for 5 minutes
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

app.get('/api/annotations', async (req, res) => {
    const url = req.query.url;
    const annotationId = req.query.annotationId;

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const normalizedUrl = normalizeUrl(url);
        console.log('Normalized URL for query:', normalizedUrl);

        const annotationNode = gun.get('annotations').get(normalizedUrl);
        const maxRetries = 3;
        let annotations = [];

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            annotations = await new Promise((resolve) => {
                const annotationList = [];
                const loadedAnnotations = new Set();
                annotationNode.map().once((annotation) => {
                    if (annotation && !loadedAnnotations.has(annotation.id)) {
                        loadedAnnotations.add(annotation.id);
                        annotationList.push({
                            id: annotation.id,
                            url: annotation.url,
                            content: annotation.content,
                            author: annotation.author,
                            timestamp: annotation.timestamp,
                        });
                    }
                });
                setTimeout(() => {
                    console.log(`Attempt ${attempt}: Annotations found:`, annotationList);
                    resolve(annotationList);
                }, 1000); // Reduced from 5000ms to 1000ms
            });

            if (annotations.length > 0 || attempt === maxRetries) {
                break;
            }

            console.log(`Retrying annotation fetch for URL: ${normalizedUrl}, attempt ${attempt}/${maxRetries}`);
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        if (!annotations || annotations.length === 0) {
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                const profile = await getProfileWithRetries(annotation.author);

                const comments = await new Promise((resolve) => {
                    const commentList = [];
                    annotationNode.get(annotation.id).get('comments').map().once((comment) => {
                        if (comment) {
                            commentList.push({
                                id: comment.id,
                                content: comment.content,
                                author: comment.author,
                                timestamp: comment.timestamp,
                            });
                        }
                    });
                    setTimeout(() => resolve(commentList), 500);
                });

                const commentsWithAuthors = await Promise.all(
                    comments.map(async (comment) => {
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

        res.json({ annotations: annotationsWithDetails });
    } catch (error) {
        console.error('Error fetching annotations:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.length > 0 ? initialPeers.join(', ') : 'none'}`);

gun.on('hi', (peer) => {
    console.log('Connected to peer:', peer);
});