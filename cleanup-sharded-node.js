import Gun from 'gun';

// Initialize Gun.js with the active peer
const gun = Gun({
    peers: ['https://citizen-x-bootsrap.onrender.com/gun'],
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

// Clean up non-annotation nodes from the sharded node
async function cleanupShardedNode() {
    console.log('Starting cleanup of non-annotation nodes...');

    const url = 'https://x.com/DrNeilStone/status/1918363323982332114';
    const normalizedUrl = normalizeUrl(url);
    const { domainShard, subShard } = getShardKey(normalizedUrl);
    const targetNode = subShard
        ? gun.get(subShard).get(normalizedUrl)
        : gun.get(domainShard).get(normalizedUrl);

    // Non-annotation keys to remove
    const nonAnnotationKeys = ['migrationMarker', 'replicationMarker', 'syncMarker'];

    // Check for non-annotation nodes and remove them
    await Promise.all(
        nonAnnotationKeys.map((key) =>
            new Promise((resolve) => {
                targetNode.get(key).once((data) => {
                    if (data) {
                        console.log(`Found non-annotation node: ${key} with value:`, data);
                        targetNode.get(key).put(null, (ack) => {
                            if (ack.err) {
                                console.error(`Failed to remove ${key}, Error:`, ack.err);
                            } else {
                                console.log(`Successfully removed non-annotation node: ${key}`);
                            }
                            resolve();
                        });
                    } else {
                        console.log(`Non-annotation node ${key} not found.`);
                        resolve();
                    }
                });
            })
        )
    );

    // Force replication
    await new Promise((resolve) => {
        targetNode.put({ cleanupMarker: Date.now() }, (ack) => {
            if (ack.err) {
                console.error(`Failed to force replication for URL: ${normalizedUrl}, Error:`, ack.err);
            } else {
                console.log(`Forced replication after cleanup for sharded node at URL: ${normalizedUrl}`);
            }
            resolve();
        });
    });

    console.log('Cleanup completed.');
}

// Run cleanup
cleanupShardedNode().catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
});