import Gun from 'gun';

// Initialize Gun.js with the same peers as the server
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

// Migrate legacy annotations to sharded nodes and tombstone legacy nodes
async function migrateLegacyData() {
    console.log('Starting migration of legacy annotations...');

    gun.get('annotations').map().once(async (data, url) => {
        if (!url) {
            console.log('Skipping invalid URL:', url);
            return;
        }

        const normalizedUrl = normalizeUrl(url);
        const { domainShard, subShard } = getShardKey(normalizedUrl);
        const targetNode = subShard
            ? gun.get(subShard).get(normalizedUrl)
            : gun.get(domainShard).get(normalizedUrl);
        const legacyNode = gun.get('annotations').get(normalizedUrl);

        // Fetch annotations from legacy node
        legacyNode.map().once(async (annotation, id) => {
            if (!annotation) {
                console.log(`Skipping null annotation for URL: ${normalizedUrl}, ID: ${id}`);
                return;
            }

            console.log(`Migrating annotation for URL: ${normalizedUrl}, ID: ${id}`);

            // Ensure isDeleted is set
            const annotationData = {
                ...annotation,
                isDeleted: annotation.isDeleted || false,
            };

            // Save to sharded node
            await new Promise((resolve, reject) => {
                targetNode.get(id).put(annotationData, (ack) => {
                    if (ack.err) {
                        console.error(`Failed to migrate annotation for URL: ${normalizedUrl}, ID: ${id}, Error:`, ack.err);
                        reject(ack.err);
                    } else {
                        console.log(`Successfully migrated annotation to sharded node for URL: ${normalizedUrl}, ID: ${id}`);
                        resolve();
                    }
                });
            });

            // Migrate comments
            legacyNode.get(id).get('comments').map().once(async (comment, commentId) => {
                if (!comment) {
                    console.log(`Skipping null comment for annotation ${id}, Comment ID: ${commentId}`);
                    return;
                }

                console.log(`Migrating comment for annotation ${id}, Comment ID: ${commentId}`);

                const commentData = {
                    ...comment,
                    isDeleted: comment.isDeleted || false,
                };

                await new Promise((resolve, reject) => {
                    targetNode.get(id).get('comments').get(commentId).put(commentData, (ack) => {
                        if (ack.err) {
                            console.error(`Failed to migrate comment for annotation ${id}, Comment ID: ${commentId}, Error:`, ack.err);
                            reject(ack.err);
                        } else {
                            console.log(`Successfully migrated comment for annotation ${id}, Comment ID: ${commentId}`);
                            resolve();
                        }
                    });
                });
            });
        });

        // Tombstone legacy node after migration
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for migration to complete
        console.log(`Tombstoning legacy node for URL: ${normalizedUrl}`);
        legacyNode.put(null, (ack) => {
            if (ack.err) {
                console.error(`Failed to tombstone legacy node for URL: ${normalizedUrl}, Error:`, ack.err);
            } else {
                console.log(`Successfully tombstoned legacy node for URL: ${normalizedUrl}`);
            }
        });
    });

    console.log('Migration and tombstoning completed.');
}

// Run migration
migrateLegacyData().catch((error) => {
    console.error('Migration failed:', error);
    process.exit(1);
});