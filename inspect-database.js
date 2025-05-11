import Gun from 'gun';
import 'gun/sea.js';

const gun = Gun({
    peers: ['https://citizen-x-bootsrap.onrender.com/gun'],
    radisk: true,
    localStorage: false
});

async function inspectDatabase() {
    console.log('Starting comprehensive database inspection...');

    // Helper function to inspect a node and its children recursively
    async function inspectNode(node, path = '', depth = 0, visited = new Set(), retries = 3) {
        return new Promise((resolve) => {
            const indent = '  '.repeat(depth);
            let hasData = false;
            let attempt = 1;

            // Avoid infinite recursion by tracking visited nodes
            const nodeId = path; // Use full path for uniqueness
            if (visited.has(nodeId)) {
                console.log(`${indent}[Already Visited Node: ${path}]`);
                resolve();
                return;
            }
            visited.add(nodeId);

            console.log(`${indent}Inspecting Node: ${path} (Attempt ${attempt}/${retries})`);

            const processNode = () => {
                node.map().once((data, key, _, ev) => {
                    try {
                        if (key === undefined) return; // Skip undefined keys

                        hasData = true;
                        const newPath = path ? `${path}/${key}` : key;
                        console.log(`${indent}  Subnode: ${key}`);

                        if (data === null) {
                            console.log(`${indent}    [Tombstone]`);
                            return;
                        }

                        if (!data || typeof data !== 'object') {
                            console.log(`${indent}    Value: ${JSON.stringify(data)}`);
                            return;
                        }

                        // Check for markup or non-data fields
                        const isMarkup = key.includes('replicationMarker') || key.includes('Marker') || key === 'knownPeers' || key === 'rateLimits' || key === 'securityLogs';
                        if (isMarkup) {
                            console.log(`${indent}    [Markup/Metadata]: ${JSON.stringify(data, null, 2)}`);
                            return;
                        }

                        // Check for real annotation data
                        const isAnnotation = data.id && data.url && data.content && data.author && data.timestamp;
                        const isComment = data.id && !data.url && data.content && data.author && data.timestamp && path.includes('/comments/');

                        if (isAnnotation) {
                            console.log(`${indent}    [Annotation]: ID=${data.id}, URL=${data.url}, Author=${data.author}, Timestamp=${data.timestamp}`);
                            console.log(`${indent}      Content: ${data.content}`);
                            if (data.isDeleted) console.log(`${indent}      [Deleted]`);
                            if (data.screenshot) console.log(`${indent}      Screenshot: [Present]`);
                            if (data.signature) console.log(`${indent}      Signature: ${data.signature.slice(0, 10)}...`);
                            if (data.nonce) console.log(`${indent}      Nonce: ${data.nonce}`);
                            if (data.metadata) console.log(`${indent}      Metadata: ${JSON.stringify(data.metadata)}`);

                            // Inspect comments if present
                            console.log(`${indent}      Comments:`);
                            inspectNode(node.get(key).get('comments'), `${newPath}/comments`, depth + 2, visited, retries).catch(err => {
                                console.error(`${indent}      Error inspecting comments for ${newPath}: ${err.message}`);
                            });
                        } else if (isComment) {
                            console.log(`${indent}    [Comment]: ID=${data.id}, Author=${data.author}, Timestamp=${data.timestamp}`);
                            console.log(`${indent}      Content: ${data.content}`);
                            if (data.isDeleted) console.log(`${indent}      [Deleted]`);
                            if (data.signature) console.log(`${indent}      Signature: ${data.signature.slice(0, 10)}...`);
                            if (data.nonce) console.log(`${indent}      Nonce: ${data.nonce}`);
                        } else {
                            // Log all other data as unexpected
                            console.log(`${indent}    [Unexpected Data]: ${JSON.stringify(data, null, 2)}`);
                        }

                        // Recursively inspect subnodes if they exist
                        inspectNode(node.get(key), newPath, depth + 1, visited, retries).catch(err => {
                            console.error(`${indent}    Error inspecting subnode ${newPath}: ${err.message}`);
                        });
                    } catch (err) {
                        console.error(`${indent}    Error processing subnode ${key} at ${path}: ${err.message}`);
                        if (err.message.includes('Signature did not match')) {
                            console.error(`${indent}    Signature verification failed for subnode ${key}`);
                        }
                    }
                }, (err) => {
                    if (err) {
                        console.error(`${indent}    Error in once callback for ${path}: ${err.message}`);
                        if (err.message.includes('Signature did not match')) {
                            console.error(`${indent}    Signature verification failed for node ${path}`);
                        }
                    }
                });

                setTimeout(() => {
                    if (!hasData) {
                        console.log(`${indent}    [Empty Node]`);
                        resolve();
                    } else if (attempt < retries) {
                        attempt++;
                        console.log(`${indent}Retrying Node: ${path} (Attempt ${attempt}/${retries})`);
                        processNode();
                    } else {
                        resolve();
                    }
                }, 30000); // Increased to 30 seconds
            };

            processNode();
        });
    }

    // List of known top-level nodes to inspect
    const knownNodes = [
        'annotations',
        'annotations_by_url',
        'known_nodes',
        'profiles',
        'securityLogs',
        'rateLimits',
        'metadata',
        'knownPeers',
        'admins',
        'deletions',
        'versions',
        'legacy_data'
    ];

    // Known domains from migration
    const knownDomains = [
        'extensions',
        'citizenx_app',
        'dashboard_render_com',
        'forum_vivaldi_net',
        'search_google_com',
        'www_aaa_com',
        'x_com'
    ];
    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];

    // Track all top-level nodes found
    const discoveredNodes = new Set(knownNodes);

    // Start inspection from known top-level nodes
    console.log('Inspecting known top-level nodes...');
    const visited = new Set();
    for (const nodeName of knownNodes) {
        console.log(`Starting inspection of node: ${nodeName}`);
        await inspectNode(gun.get(nodeName), nodeName, 0, visited).catch(err => {
            console.error(`Error inspecting node ${nodeName}: ${err.message}`);
        });
    }

    // Inspect sharded nodes
    console.log('Inspecting sharded nodes...');
    for (const domain of knownDomains) {
        const domainShard = `annotations_${domain}`;
        console.log(`Inspecting shard: ${domainShard}`);
        await inspectNode(gun.get(domainShard), domainShard, 0, visited).catch(err => {
            console.error(`Error inspecting shard ${domainShard}: ${err.message}`);
        });

        if (highTrafficDomains.includes(domain)) {
            for (let i = 0; i < 10; i++) {
                const subShard = `${domainShard}_shard_${i}`;
                console.log(`Inspecting sub-shard: ${subShard}`);
                await inspectNode(gun.get(subShard), subShard, 0, visited).catch(err => {
                    console.error(`Error inspecting sub-shard ${subShard}: ${err.message}`);
                });
            }
        }
    }

    // Attempt to discover other top-level nodes by listening at the root
    console.log('Attempting to discover other top-level nodes from root...');
    await new Promise((resolve) => {
        const root = gun.get('/');
        let hasData = false;

        root.map().once((data, key) => {
            try {
                if (key === undefined || knownNodes.includes(key) || key.startsWith('annotations_')) return; // Skip known nodes and sharded nodes

                hasData = true;
                console.log(`Discovered new top-level node: ${key}`);
                discoveredNodes.add(key);
                inspectNode(gun.get(key), key, 0, visited).catch(err => {
                    console.error(`Error inspecting new top-level node ${key}: ${err.message}`);
                });
            } catch (err) {
                console.error(`Error processing root node ${key}: ${err.message}`);
                if (err.message.includes('Signature did not match')) {
                    console.error(`Signature verification failed at root for ${key}`);
                }
            }
        }, (err) => {
            if (err) {
                console.error(`Error in root once callback: ${err.message}`);
                if (err.message.includes('Signature did not match')) {
                    console.error(`Signature verification failed at root`);
                }
            }
        });

        setTimeout(() => {
            if (!hasData) {
                console.log('No additional top-level nodes discovered at root.');
            }
            resolve();
        }, 40000); // Increased to 40 seconds
    });

    // Log summary of discovered nodes
    console.log('Summary of top-level nodes discovered:');
    for (const node of discoveredNodes) {
        console.log(`- ${node}`);
    }

    console.log('Database inspection complete.');
    process.exit(0);
}

inspectDatabase().catch(err => {
    console.error('Error during inspection:', err);
    process.exit(1);
});