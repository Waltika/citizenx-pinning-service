import Gun from 'gun';
import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

// Initialize Gun.js server
const gun = Gun({
    peers: ['https://citizen-x-bootsrap.onrender.com/gun'], // Self-reference for bootstrap
    radisk: true,
    localStorage: false,
    file: 'gun-data',
    webrtc: true,
});

// Middleware to parse JSON and handle CORS
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Helper function to fetch a profile with retries
async function getProfile(did, retries = 5, delay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        const profile = await new Promise((resolve) => {
            gun.get(`user_${did}`).get('profile').once((data) => {
                if (data && data.did && data.handle) {
                    console.log(`gun-server: Loaded profile for DID on attempt ${attempt}:`, did, data);
                    resolve({ did: data.did, handle: data.handle, profilePicture: data.profilePicture });
                } else {
                    console.warn(`gun-server: Profile not found for DID on attempt ${attempt}:`, did, data);
                    resolve(null);
                }
            });
        });

        if (profile) {
            return profile;
        }

        console.log(`gun-server: Retrying getProfile for DID: ${did}, attempt ${attempt}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    console.error('gun-server: Failed to load profile for DID after retries:', did);
    return null;
}

// API endpoint to fetch annotations
app.get('/api/annotations', async (req, res) => {
    const url = req.query.url;
    if (!url) {
        return res.status(400).json({ error: 'URL parameter is required' });
    }

    try {
        const annotations = [];
        const annotationNode = gun.get('annotations').get(url);

        await new Promise((resolve) => {
            annotationNode.map().once(async (annotation, id) => {
                if (annotation) {
                    const comments = await new Promise((resolveComments) => {
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
                        setTimeout(() => resolveComments(commentList), 500);
                    });

                    // Fetch the author's profile
                    const profile = await getProfile(annotation.author);
                    const authorHandle = profile ? profile.handle : 'Unknown';

                    annotations.push({
                        id: annotation.id,
                        url: annotation.url,
                        content: annotation.content,
                        author: annotation.author,
                        authorHandle, // Add authorHandle to the response
                        timestamp: annotation.timestamp,
                        comments,
                    });
                }
            });

            setTimeout(() => {
                console.log('gun-server: Loaded annotations for URL:', url, annotations);
                resolve();
            }, 2000);
        });

        if (!annotations || annotations.length === 0) {
            return res.status(404).json({ error: 'No annotations found for this URL' });
        }

        res.json({ annotations });
    } catch (err) {
        console.error('gun-server: Error fetching annotations:', err);
        res.status(500).json({ error: 'Error fetching annotations' });
    }
});

app.listen(port, () => {
    console.log(`gun-server: Server running on port ${port}`);
});
