import Gun from 'gun';

// Initialize Gun.js with all peers
const gun = Gun({
    peers: [
        'http://localhost:8765/gun',
        'https://citizen-x-bootsrap.onrender.com/gun',
        'https://gun-manhattan.herokuapp.com/gun',
        'https://relay.peer.ooo/gun',
    ],
    radisk: true,
});

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

// Synchronize comment states for a specific annotation
async function syncCommentStates() {
    console.log('Starting synchronization of comment states...');

    const url = 'https://x.com/DrNeilStone/status/1918363323982332114';
    const annotationId = 'did:key:z6Mkn9jS7WaZ6NWGmmc6W46KcgsbjawXRArGu7EUY3NPYbDD-1746428323319';
    const commentsToSync = [
        '1746470471533',
        '1746470482132',
        '1746470494415',
        '1746475840569',
    ];

    const normalizedUrl = normalizeUrl(url);
    const { domainShard, subShard } = getShardKey(normalizedUrl);
    const targetNode = subShard
        ? gun.get(subShard).get(normalizedUrl)
        : gun.get(domainShard).get(normalizedUrl);

    // Fetch current comment states
    const comments = await new Promise((resolve) => {
        const commentList = [];
        targetNode.get(annotationId).get('comments').map().once((comment, commentId) => {
            if (comment && commentsToSync.includes(commentId)) {
                commentList.push({
                    id: commentId,
                    content: comment.content,
                    author: comment.author,
                    timestamp: comment.timestamp,
                    isDeleted: comment.isDeleted || false,
                });
            }
        });
        setTimeout(() => resolve(commentList), 5000);
    });

    console.log('Current comment states:', comments);

    // Update comments to isDeleted: true
    for (const comment of comments) {
        console.log(`Updating comment ${comment.id} to isDeleted: true`);
        await new Promise((resolve, reject) => {
            targetNode.get(annotationId).get('comments').get(comment.id).put(
                {
                    ...comment,
                    isDeleted: true,
                },
                (ack) => {
                    if (ack.err) {
                        console.error(`Failed to update comment ${comment.id}, Error:`, ack.err);
                        reject(ack.err);
                    } else {
                        console.log(`Successfully updated comment ${comment.id} to isDeleted: true`);
                        resolve();
                    }
                }
            );
        });
    }

    // Force replication
    await new Promise((resolve) => {
        targetNode.put({ syncMarker: Date.now() }, (ack) => {
            if (ack.err) {
                console.error(`Failed to force replication for URL: ${normalizedUrl}, Error:`, ack.err);
            } else {
                console.log(`Forced replication for sharded node at URL: ${normalizedUrl}`);
            }
            resolve();
        });
    });

    console.log('Synchronization completed.');
}

// Run synchronization
syncCommentStates().catch((error) => {
    console.error('Synchronization failed:', error);
    process.exit(1);
});