import Gun from 'gun';
import http from 'http';
import express from 'express';
import cors from 'cors';

const port = process.env.PORT || 8765;
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';
const initialPeers = [];

const app = express();
app.use(cors({
    origin: 'https://citizenx.app',
    methods: ['GET'],
}));

const server = http.createServer(app).listen(port);
const gun = Gun({
    web: server,
    peers: initialPeers,
    file: 'gun-data',
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

app.get('/api/annotations', async (req, res) => {
    const url = req.query.url;
    const annotationId = req.query.annotationId; // Optional

    if (!url) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const annotationNode = gun.get('annotations').get(url);
        const annotations = await new Promise((resolve) => {
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
            setTimeout(() => resolve(annotationList), 2000);
        });

        if (!annotations || annotations.length === 0) {
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        // Fetch profiles and comments for each annotation
        const annotationsWithDetails = await Promise.all(
            annotations.map(async (annotation) => {
                // Fetch the author's profile
                const profile = await new Promise((resolve) => {
                    gun.get('profiles').get(annotation.author).once((data) => {
                        if (data && data.handle) {
                            resolve({
                                handle: data.handle,
                                profilePicture: data.profilePicture,
                            });
                        } else {
                            resolve({ handle: 'Unknown' });
                        }
                    });
                });

                // Fetch comments
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

                // Fetch comment authors' profiles
                const commentsWithAuthors = await Promise.all(
                    comments.map(async (comment) => {
                        const commentProfile = await new Promise((resolve) => {
                            gun.get('profiles').get(comment.author).once((data) => {
                                if (data && data.handle) {
                                    resolve({ handle: data.handle });
                                } else {
                                    resolve({ handle: 'Unknown' });
                                }
                            });
                        });
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