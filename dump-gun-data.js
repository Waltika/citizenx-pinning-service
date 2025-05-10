import Gun from 'gun';
import { promises as fs } from 'fs';
import path from 'path';

// Configuration
const GUN_SERVER_URL = 'https://citizen-x-bootsrap.onrender.com/gun';
const OUTPUT_FILE = 'gun-data-dump.json';
const FETCH_TIMEOUT_MS = 30000; // Increased timeout to 30 seconds
const MIN_WAIT_TIME_MS = 10000; // Minimum wait time to collect data

// Helper function to normalize URLs (copied from gun-server.js)
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

// Helper function to get shard keys (copied from gun-server.js)
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

// Helper function to fetch data with a timeout and real-time updates
async function fetchWithRealTime(gun, nodePath, mapCallback, waitTimeMs = FETCH_TIMEOUT_MS, minWaitTimeMs = MIN_WAIT_TIME_MS) {
    const items = new Map();
    let resolved = false;
    let receivedData = false;

    const fetchPromise = new Promise((resolve) => {
        const onItem = (data, key) => {
            if (data) {
                mapCallback(data, key, items);
                console.log(`Received data for node ${nodePath}: ${key}`, data);
                receivedData = true;

                // Resolve immediately after receiving the first piece of data, but ensure minimum wait time
                if (!resolved && items.size > 0) {
                    setTimeout(() => {
                        if (!resolved) {
                            resolved = true;
                            gun.get(nodePath).map().off();
                            console.log(`Finished fetching ${nodePath}, collected ${items.size} items after receiving data`);
                            resolve([...items.values()]);
                        }
                    }, Math.max(0, minWaitTimeMs - (Date.now() - startTime)));
                }
            }
        };

        const startTime = Date.now();
        gun.get(nodePath).map().on(onItem);

        // Minimum wait time to collect initial data
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                gun.get(nodePath).map().off();
                console.log(`Finished fetching ${nodePath}, collected ${items.size} items after minimum wait time`);
                resolve([...items.values()]);
            }
        }, minWaitTimeMs);

        // Maximum wait time to prevent hanging
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                gun.get(nodePath).map().off();
                console.log(`Timed out fetching ${nodePath}, collected ${items.size} items`);
                resolve([...items.values()]);
            }
        }, waitTimeMs);
    });

    return fetchPromise;
}

// Main function to dump Gun server data
async function dumpGunData() {
    console.log(`Connecting to Gun server at ${GUN_SERVER_URL}...`);
    const gun = Gun({
        peers: [GUN_SERVER_URL],
        localStorage: false,
        radisk: false,
        webrtc: true, // Enable WebRTC in case it's needed for peer communication
    });

    // Monitor WebSocket connection and raw data flow
    gun.on('hi', (peer) => {
        console.log('WebSocket connected to peer:', peer);
    });
    gun.on('bye', (peer) => {
        console.log('WebSocket disconnected from peer:', peer);
    });
    gun.on('in', (msg) => {
        console.log('Incoming message from server:', JSON.stringify(msg, null, 2));
    });
    gun.on('out', (msg) => {
        console.log('Outgoing message to server:', JSON.stringify(msg, null, 2));
    });

    // Force synchronization by writing a dummy value
    console.log('Forcing synchronization by writing a dummy value...');
    gun.get('sync-test').put({ timestamp: Date.now() }, (ack) => {
        if (ack.err) {
            console.error('Failed to write sync-test value:', ack.err);
        } else {
            console.log('Successfully wrote sync-test value');
        }
    });

    const dump = {
        rootNodes: {},
        profiles: {},
        legacyProfiles: {},
        annotations: {},
        shardedAnnotations: {},
        knownPeers: {},
        admins: [],
        metadata: {
            timestamp: new Date().toISOString(),
            gunServerUrl: GUN_SERVER_URL,
        },
    };

    try {
        // 0. Dump the root of the database to debug the structure
        console.log('Dumping root nodes...');
        const rootNodes = await fetchWithRealTime(
            gun,
            '',
            (data, node, items) => {
                if (node && data) {
                    items.set(node, data);
                }
            }
        );
        dump.rootNodes = Object.fromEntries(rootNodes);

        // 1. Fetch Profiles
        console.log('Fetching profiles...');
        const profiles = await fetchWithRealTime(
            gun,
            'profiles',
            (profile, did, items) => {
                if (profile && profile.handle) {
                    items.set(did, {
                        handle: profile.handle,
                        profilePicture: profile.profilePicture || null,
                    });
                }
            }
        );
        dump.profiles = Object.fromEntries(profiles.map(item => [Object.keys(item)[0], Object.values(item)[0]]));

        // 2. Fetch Legacy Profiles (user_${did})
        console.log('Fetching legacy profiles...');
        const dids = Object.keys(dump.profiles);
        for (const did of dids) {
            console.log(`Fetching legacy profile for DID: ${did}`);
            const legacyProfile = await fetchWithRealTime(
                gun,
                `user_${did}`,
                (data, key, items) => {
                    if (key === 'profile' && data && data.handle) {
                        items.set(did, {
                            handle: data.handle,
                            profilePicture: data.profilePicture || null,
                        });
                    }
                },
                FETCH_TIMEOUT_MS,
                1000
            );
            if (legacyProfile.length > 0) {
                dump.legacyProfiles[did] = legacyProfile[0][did];
            }
        }

        // 3. Discover All Sharded Nodes (annotations_*)
        console.log('Discovering sharded nodes...');
        const shardedNodes = new Set();
        await fetchWithRealTime(
            gun,
            '',
            (data, node, items) => {
                if (node.startsWith('annotations_')) {
                    items.add(node);
                }
            }
        );
        shardedNodes.forEach(node => console.log(`Found sharded node: ${node}`));

        // 4. Fetch Annotations from 'annotations' Node
        console.log('Fetching annotations from annotations node...');
        const urlsWithAnnotations = new Set();
        await fetchWithRealTime(
            gun,
            'annotations',
            (urlData, url, items) => {
                if (urlData && url) {
                    items.add(url);
                }
            }
        );
        urlsWithAnnotations.forEach(url => console.log(`Found URL in annotations: ${url}`));

        for (const url of urlsWithAnnotations) {
            console.log(`Fetching annotations for URL: ${url}`);
            dump.annotations[url] = {};
            const annotations = await fetchWithRealTime(
                gun,
                `annotations/${url}`,
                (annotation, annotationId, items) => {
                    if (annotation && annotation.id && annotation.content && annotation.author && annotation.timestamp) {
                        items.set(annotationId, annotation);
                    }
                }
            );

            for (const [annotationId, annotation] of annotations) {
                const comments = await fetchWithRealTime(
                    gun,
                    `annotations/${url}/${annotationId}/comments`,
                    (comment, commentId, items) => {
                        if (comment && comment.id && comment.author && comment.content) {
                            items.set(commentId, {
                                content: comment.content,
                                author: comment.author,
                                timestamp: comment.timestamp,
                                isDeleted: comment.isDeleted || false,
                            });
                        }
                    },
                    FETCH_TIMEOUT_MS,
                    1000
                );

                dump.annotations[url][annotationId] = {
                    id: annotation.id,
                    url: annotation.url,
                    content: annotation.content,
                    author: annotation.author,
                    timestamp: annotation.timestamp,
                    isDeleted: annotation.isDeleted || false,
                    screenshot: annotation.screenshot || null,
                    comments: Object.fromEntries(comments),
                };
            }
        }

        // 5. Fetch Sharded Annotations
        console.log('Fetching sharded annotations...');
        for (const shard of shardedNodes) {
            console.log(`Processing shard: ${shard}`);
            dump.shardedAnnotations[shard] = {};
            const urlsInShard = new Set();
            await fetchWithRealTime(
                gun,
                shard,
                (urlData, url, items) => {
                    if (urlData && url) {
                        items.add(url);
                    }
                }
            );
            urlsInShard.forEach(url => console.log(`Found URL in shard ${shard}: ${url}`));

            for (const url of urlsInShard) {
                dump.shardedAnnotations[shard][url] = {};
                const annotations = await fetchWithRealTime(
                    gun,
                    `${shard}/${url}`,
                    (annotation, annotationId, items) => {
                        if (annotation && annotation.id && annotation.content && annotation.author && annotation.timestamp) {
                            items.set(annotationId, annotation);
                        }
                    }
                );

                for (const [annotationId, annotation] of annotations) {
                    const comments = await fetchWithRealTime(
                        gun,
                        `${shard}/${url}/${annotationId}/comments`,
                        (comment, commentId, items) => {
                            if (comment && comment.id && comment.author && comment.content) {
                                items.set(commentId, {
                                    content: comment.content,
                                    author: comment.author,
                                    timestamp: comment.timestamp,
                                    isDeleted: comment.isDeleted || false,
                                });
                            }
                        },
                        FETCH_TIMEOUT_MS,
                        1000
                    );

                    dump.shardedAnnotations[shard][url][annotationId] = {
                        id: annotation.id,
                        url: annotation.url,
                        content: annotation.content,
                        author: annotation.author,
                        timestamp: annotation.timestamp,
                        isDeleted: annotation.isDeleted || false,
                        screenshot: annotation.screenshot || null,
                        comments: Object.fromEntries(comments),
                    };
                }
            }
        }

        // 6. Fetch Known Peers
        console.log('Fetching known peers...');
        const peers = await fetchWithRealTime(
            gun,
            'knownPeers',
            (peer, peerId, items) => {
                if (peer && peer.url && peer.timestamp) {
                    items.set(peerId, {
                        url: peer.url,
                        timestamp: peer.timestamp,
                        lastSeen: new Date(peer.timestamp).toISOString(),
                    });
                }
            }
        );
        dump.knownPeers = Object.fromEntries(peers);

        // 7. Fetch Admins
        console.log('Fetching admins...');
        const admins = await fetchWithRealTime(
            gun,
            'admins',
            (data, did, items) => {
                if (data) {
                    items.add(did);
                }
            }
        );
        dump.admins = [...admins.map(item => item[0])];

        // 8. Write the dump to a file
        console.log('Writing dump to file...');
        const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
        await fs.writeFile(outputPath, JSON.stringify(dump, null, 2), 'utf8');
        console.log(`Data dump written to ${outputPath}`);

    } catch (error) {
        console.error('Error dumping Gun server data:', error.message);
    } finally {
        // Clean up Gun instance
        gun.off();
    }
}

// Run the script
try {
    await dumpGunData();
} catch (err) {
    console.error('Script failed:', err);
    process.exit(1);
}