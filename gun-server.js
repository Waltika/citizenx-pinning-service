import Gun from 'gun';
import http from 'http';
import express from 'express';

// Default port for the Gun server (Render will set PORT automatically)
const port = process.env.PORT || 8765;

// Hardcode the public URL for Render
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';

// Initial list of known peers (empty since this is the first bootstrap node)
const initialPeers = [];

// Create an Express app for the API
const app = express();

// Create an HTTP server for Gun and Express
const server = http.createServer(app).listen(port);
const gun = Gun({
    web: server,
    peers: initialPeers,
    file: 'gun-data',
    radisk: true,
});

// Register this server's URL in the knownPeers node
const peerId = `${publicUrl}-${Date.now()}`; // Unique ID for this server instance
gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
    if (ack.err) {
        console.error('Failed to register server in knownPeers:', ack.err);
    } else {
        console.log(`Registered server in knownPeers: ${publicUrl}/gun`);
    }
});

// Keep the entry alive by periodically updating the timestamp
setInterval(() => {
    gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
        if (ack.err) {
            console.error('Failed to update server timestamp in knownPeers:', ack.err);
        }
    });
}, 5 * 60 * 1000); // Update every 5 minutes

// Clean up stale peers (older than 10 minutes)
setInterval(() => {
    gun.get('knownPeers').map().once((peer, id) => {
        if (peer && peer.url && peer.timestamp) {
            const now = Date.now();
            const age = now - peer.timestamp;
            if (age > 10 * 60 * 1000) { // 10 minutes
                console.log('Removing stale peer:', peer.url);
                gun.get('knownPeers').get(id).put(null);
            }
        }
    });
}, 5 * 60 * 1000); // Check every 5 minutes

// API endpoint to fetch annotation data
app.get('/api/annotations', async (req, res) => {
    const url = req.query.url;
    const annotationId = req.query.annotationId;

    if (!url || !annotationId) {
        return res.status(400).json({ error: 'Missing url or annotationId parameter' });
    }

    try {
        const annotationNode = gun.get('annotations').get(url).get(annotationId);
        const annotation = await new Promise((resolve) => {
            annotationNode.once((data) => {
                if (data) {
                    resolve({
                        id: data.id,
                        url: data.url,
                        content: data.content,
                        author: data.author,
                        timestamp: data.timestamp,
                    });
                } else {
                    resolve(null);
                }
            });
        });

        if (!annotation) {
            return res.status(404).json({ error: 'Annotation not found' });
        }

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
            annotationNode.get('comments').map().once((comment) => {
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

        res.json({
            annotation: {
                ...annotation,
                authorHandle: profile.handle,
                authorProfilePicture: profile.profilePicture,
                comments: commentsWithAuthors,
            },
        });
    } catch (error) {
        console.error('Error fetching annotation:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.length > 0 ? initialPeers.join(', ') : 'none'}`);

// Log peer connections
gun.on('hi', (peer) => {
    console.log('Connected to peer:', peer);
});