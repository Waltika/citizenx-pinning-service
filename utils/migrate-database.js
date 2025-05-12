import Gun from 'gun';
import 'gun/sea.js';

const gun = Gun({
    peers: ['https://citizen-x-bootsrap.onrender.com/gun'],
    radisk: true,
    localStorage: false
});

async function migrateDatabase() {
    console.log('Starting database migration...');

    // Helper function to normalize URLs
    function normalizeUrl(url) {
        try {
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
        } catch (err) {
            console.log(`Invalid URL: ${url}, skipping...`);
            return url; // Return original URL if normalization fails
        }
    }

    // Helper function to get shard key
    function getShardKey(url) {
        const normalizedUrl = normalizeUrl(url);
        let domain;
        try {
            const urlObj = new URL(normalizedUrl);
            domain = urlObj.hostname.replace(/\./g, '_');
        } catch (err) {
            console.log(`Cannot parse URL for sharding: ${normalizedUrl}, using default domain`);
            domain = 'unknown';
        }
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

    // Retry helper function
    async function retryOperation(operation, maxRetries = 3, delay = 1000) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                return await operation();
            } catch (err) {
                console.error(`Attempt ${attempt}/${maxRetries} failed: ${err.message}`);
                if (attempt < maxRetries) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    throw err;
                }
            }
        }
    }

    // Collect all domains from the legacy 'annotations' node
    const domains = new Set();
    const highTrafficDomains = ['google_com', 'facebook_com', 'twitter_com'];
    const legacyAnnotations = gun.get('annotations');

    console.log('Discovering domains from legacy annotations...');
    await new Promise((resolve) => {
        legacyAnnotations.map().once((data, url) => {
            if (!url) return;
            try {
                const normalizedUrl = normalizeUrl(url);
                const urlObj = new URL(normalizedUrl);
                const domain = urlObj.hostname.replace(/\./g, '_');
                domains.add(domain);
            } catch (err) {
                console.log(`Skipping invalid URL: ${url}`, err.message);
            }
        });
        setTimeout(resolve, 40000);
    });

    console.log('Domains found:', Array.from(domains));

    // Populate known_nodes with domains and sub-shards
    console.log('Populating known_nodes...');
    const knownNodes = gun.get('known_nodes');
    for (const domain of domains) {
        try {
            await retryOperation(() => new Promise((resolve, reject) => {
                knownNodes.get(`annotations_${domain}`).put({ domain }, (ack) => {
                    if (ack.err) {
                        reject(new Error(`Failed to update known_nodes for domain ${domain}: ${ack.err}`));
                    } else {
                        console.log(`Updated known_nodes for domain ${domain}`);
                        resolve();
                    }
                });
            }));
        } catch (err) {
            console.error(`Failed to update known_nodes for ${domain} after retries: ${err.message}`);
        }
        if (highTrafficDomains.includes(domain)) {
            for (let i = 0; i < 10; i++) {
                const subShard = `annotations_${domain}_shard_${i}`;
                try {
                    await retryOperation(() => new Promise((resolve, reject) => {
                        knownNodes.get(subShard).put({ domain: `${domain}_shard_${i}` }, (ack) => {
                            if (ack.err) {
                                reject(new Error(`Failed to update known_nodes for sub-shard ${subShard}: ${ack.err}`));
                            } else {
                                console.log(`Updated known_nodes for sub-shard ${subShard}`);
                                resolve();
                            }
                        });
                    }));
                } catch (err) {
                    console.error(`Failed to update known_nodes for ${subShard} after retries: ${err.message}`);
                }
            }
        }
    }

    // Step 1: Migrate annotations and separate metadata
    console.log('Step 1: Migrating annotations and separating metadata...');
    const metadataNode = gun.get('metadata');
    const legacyDataNode = gun.get('legacy_data');

    await new Promise((resolve) => {
        legacyAnnotations.map().once(async (data, url) => {
            if (!url) return;

            const annotations = legacyAnnotations.get(url);
            annotations.map().once(async (annotation, id) => {
                if (!annotation || !id) return;

                if (annotation === null) {
                    console.log(`Skipping tombstone: annotations/${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            annotations.get(id).put(null, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to remove tombstone: ${ack.err}`));
                                } else {
                                    resolvePut();
                                }
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to remove tombstone ${id} after retries: ${err.message}`);
                    }
                    return;
                }

                // Check for markup data
                if (id.includes('replicationMarker') || id.includes('Marker') || id.includes('migrationMarker')) {
                    console.log(`Moving markup data to metadata: ${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            metadataNode.get(url).get(id).put(annotation, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to move markup data: ${ack.err}`));
                                } else {
                                    annotations.get(id).put(null);
                                    resolvePut();
                                }
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to move markup data ${id} after retries: ${err.message}`);
                    }
                    return;
                }

                // Check for unexpected data (e.g., did:key:... without full annotation structure)
                if (id.startsWith('did:key:') && !(annotation.id && annotation.url && annotation.content && annotation.author && annotation.timestamp)) {
                    console.log(`Moving unexpected data to legacy_data: ${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            legacyDataNode.get(url).get(id).put(annotation, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to move unexpected data: ${ack.err}`));
                                } else {
                                    annotations.get(id).put(null);
                                    resolvePut();
                                }
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to move unexpected data ${id} after retries: ${err.message}`);
                    }
                    return;
                }

                // Validate and migrate annotation
                if (!annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                    console.log(`Skipping invalid annotation: ${url}/${id}`, JSON.stringify(annotation));
                    return;
                }

                // Skip deleted annotations
                if (annotation.isDeleted) {
                    console.log(`Skipping deleted annotation: ${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            annotations.get(id).put(null, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to remove deleted annotation: ${ack.err}`));
                                } else {
                                    resolvePut();
                                }
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to remove deleted annotation ${id} after retries: ${err.message}`);
                    }
                    return;
                }

                const normalizedUrl = normalizeUrl(annotation.url);
                const { domainShard, subShard } = getShardKey(normalizedUrl);
                const targetNode = subShard ? gun.get(subShard).get(normalizedUrl) : gun.get(domainShard).get(normalizedUrl);
                const indexedNode = gun.get(`annotations_by_url/${normalizedUrl}`);

                // Fetch comments
                const comments = await new Promise((resolveComments) => {
                    const commentList = [];
                    annotations.get(id).get('comments').map().once((comment) => {
                        if (comment && comment.id && comment.author && comment.content && comment.timestamp) {
                            commentList.push({
                                id: comment.id,
                                content: comment.content,
                                author: comment.author,
                                timestamp: comment.timestamp,
                                isDeleted: comment.isDeleted || false,
                                annotationId: comment.annotationId || id,
                                signature: comment.signature || '',
                                nonce: comment.nonce || ''
                            });
                        }
                    });
                    setTimeout(() => resolveComments(commentList), 3000);
                });

                const annotationData = {
                    id: annotation.id,
                    url: normalizedUrl,
                    content: annotation.content || '',
                    author: annotation.author || '',
                    timestamp: annotation.timestamp || Date.now(),
                    isDeleted: annotation.isDeleted || false,
                    text: annotation.text || '',
                    screenshot: annotation.screenshot || '',
                    signature: annotation.signature || '',
                    nonce: annotation.nonce || '',
                    metadata: annotation.metadata || {}
                };

                const indexAnnotation = {
                    id: annotationData.id,
                    url: annotationData.url,
                    content: annotationData.content,
                    author: annotationData.author,
                    timestamp: annotationData.timestamp,
                    isDeleted: annotationData.isDeleted,
                    text: annotationData.text,
                    screenshot: annotationData.screenshot,
                    signature: annotationData.signature,
                    nonce: annotationData.nonce,
                    metadata: annotationData.metadata
                };

                console.log(`Migrating annotation from legacy: ${url}/${id} to ${domainShard}${subShard ? `/${subShard}` : ''}`);
                try {
                    await retryOperation(() => new Promise((resolvePut, reject) => {
                        // Write annotation data (without comments array)
                        targetNode.get(id).put(annotationData, (ack) => {
                            if (ack.err) {
                                reject(new Error(`Failed to migrate annotation to shard: ${ack.err}`));
                                return;
                            }

                            console.log(`Successfully migrated annotation to shard: ${id}`);

                            // Write comments as individual nodes
                            Promise.all(comments.map(comment => {
                                return new Promise((resolveComment) => {
                                    targetNode.get(id).get('comments').get(comment.id).put(comment, (ack) => {
                                        if (ack.err) {
                                            console.error(`Failed to migrate comment ${comment.id}: ${ack.err}`);
                                        } else {
                                            console.log(`Migrated comment ${comment.id} for annotation ${id}`);
                                        }
                                        resolveComment();
                                    });
                                });
                            })).then(() => {
                                // Write index entry
                                retryOperation(() => new Promise((resolveIndex, rejectIndex) => {
                                    indexedNode.get(id).put(indexAnnotation, (ack) => {
                                        if (ack.err) {
                                            rejectIndex(new Error(`Failed to update index: ${ack.err}`));
                                        } else {
                                            console.log(`Updated index for annotation: ${id}`);
                                            // Remove from legacy
                                            retryOperation(() => new Promise((resolveRemove, rejectRemove) => {
                                                annotations.get(id).put(null, (ack) => {
                                                    if (ack.err) {
                                                        rejectRemove(new Error(`Failed to remove legacy annotation: ${ack.err}`));
                                                    } else {
                                                        console.log(`Removed legacy annotation: ${id}`);
                                                        resolveRemove();
                                                    }
                                                });
                                            })).then(() => resolveIndex()).catch(err => rejectIndex(err));
                                        }
                                    });
                                })).then(() => resolvePut()).catch(err => reject(err));
                            }).catch(err => reject(err));
                        });
                    }));
                } catch (err) {
                    console.error(`Failed to migrate annotation ${id} after retries: ${err.message}`);
                }
            });
        });
        setTimeout(resolve, 50000);
    });

    // Step 2: Process sharded nodes and ensure consistency
    console.log('Step 2: Processing sharded nodes...');
    for (const domain of domains) {
        const domainShard = `annotations_${domain}`;
        const shardNode = gun.get(domainShard);

        await new Promise((resolve) => {
            shardNode.map().once(async (data, url) => {
                if (!url) return;

                const annotations = shardNode.get(url);
                annotations.map().once(async (annotation, id) => {
                    if (!annotation || !id) return;

                    if (annotation === null) {
                        console.log(`Removing tombstone: ${domainShard}/${url}/${id}`);
                        try {
                            await retryOperation(() => new Promise((resolvePut, reject) => {
                                annotations.get(id).put(null, (ack) => {
                                    if (ack.err) {
                                        reject(new Error(`Failed to remove tombstone: ${ack.err}`));
                                    } else {
                                        resolvePut();
                                    }
                                });
                            }));
                        } catch (err) {
                            console.error(`Failed to remove tombstone ${id} after retries: ${err.message}`);
                        }
                        return;
                    }

                    // Check for markup data
                    if (id.includes('replicationMarker') || id.includes('Marker') || id.includes('migrationMarker')) {
                        console.log(`Moving markup data to metadata: ${domainShard}/${url}/${id}`);
                        try {
                            await retryOperation(() => new Promise((resolvePut, reject) => {
                                metadataNode.get(url).get(id).put(annotation, (ack) => {
                                    if (ack.err) {
                                        reject(new Error(`Failed to move markup data: ${ack.err}`));
                                    } else {
                                        annotations.get(id).put(null);
                                        resolvePut();
                                    }
                                });
                            }));
                        } catch (err) {
                            console.error(`Failed to move markup data ${id} after retries: ${err.message}`);
                        }
                        return;
                    }

                    // Check for unexpected data
                    if (id.startsWith('did:key:') && !(annotation.id && annotation.url && annotation.content && annotation.author && annotation.timestamp)) {
                        console.log(`Moving unexpected data to legacy_data: ${domainShard}/${url}/${id}`);
                        try {
                            await retryOperation(() => new Promise((resolvePut, reject) => {
                                legacyDataNode.get(url).get(id).put(annotation, (ack) => {
                                    if (ack.err) {
                                        reject(new Error(`Failed to move unexpected data: ${ack.err}`));
                                    } else {
                                        annotations.get(id).put(null);
                                        resolvePut();
                                    }
                                });
                            }));
                        } catch (err) {
                            console.error(`Failed to move unexpected data ${id} after retries: ${err.message}`);
                        }
                        return;
                    }

                    // Validate annotation
                    if (!annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                        console.log(`Skipping invalid annotation: ${domainShard}/${url}/${id}`, JSON.stringify(annotation));
                        return;
                    }

                    // Skip deleted annotations
                    if (annotation.isDeleted) {
                        console.log(`Skipping deleted annotation: ${domainShard}/${url}/${id}`);
                        try {
                            await retryOperation(() => new Promise((resolvePut, reject) => {
                                annotations.get(id).put(null, (ack) => {
                                    if (ack.err) {
                                        reject(new Error(`Failed to remove deleted annotation: ${ack.err}`));
                                    } else {
                                        resolvePut();
                                    }
                                });
                            }));
                        } catch (err) {
                            console.error(`Failed to remove deleted annotation ${id} after retries: ${err.message}`);
                        }
                        return;
                    }

                    const normalizedUrl = normalizeUrl(annotation.url);
                    const { domainShard: targetDomainShard, subShard } = getShardKey(normalizedUrl);
                    const targetNode = subShard ? gun.get(subShard).get(normalizedUrl) : gun.get(targetDomainShard).get(normalizedUrl);
                    const indexedNode = gun.get(`annotations_by_url/${normalizedUrl}`);

                    const comments = await new Promise((resolveComments) => {
                        const commentList = [];
                        annotations.get(id).get('comments').map().once((comment) => {
                            if (comment && comment.id && comment.author && comment.content && comment.timestamp) {
                                commentList.push({
                                    id: comment.id,
                                    content: comment.content,
                                    author: comment.author,
                                    timestamp: comment.timestamp,
                                    isDeleted: comment.isDeleted || false,
                                    annotationId: comment.annotationId || id,
                                    signature: comment.signature || '',
                                    nonce: comment.nonce || ''
                                });
                            }
                        });
                        setTimeout(() => resolveComments(commentList), 3000);
                    });

                    const annotationData = {
                        id: annotation.id,
                        url: normalizedUrl,
                        content: annotation.content || '',
                        author: annotation.author || '',
                        timestamp: annotation.timestamp || Date.now(),
                        isDeleted: annotation.isDeleted || false,
                        text: annotation.text || '',
                        screenshot: annotation.screenshot || '',
                        signature: annotation.signature || '',
                        nonce: annotation.nonce || '',
                        metadata: annotation.metadata || {}
                    };

                    const indexAnnotation = {
                        id: annotationData.id,
                        url: annotationData.url,
                        content: annotationData.content,
                        author: annotationData.author,
                        timestamp: annotationData.timestamp,
                        isDeleted: annotationData.isDeleted,
                        text: annotationData.text,
                        screenshot: annotationData.screenshot,
                        signature: annotationData.signature,
                        nonce: annotationData.nonce,
                        metadata: annotationData.metadata
                    };

                    console.log(`Ensuring annotation in correct shard: ${domainShard}/${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            // Write annotation data (without comments array)
                            targetNode.get(id).put(annotationData, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to ensure annotation in shard: ${ack.err}`));
                                    return;
                                }

                                console.log(`Ensured annotation in shard: ${id}`);

                                // Write comments as individual nodes
                                Promise.all(comments.map(comment => {
                                    return new Promise((resolveComment) => {
                                        targetNode.get(id).get('comments').get(comment.id).put(comment, (ack) => {
                                            if (ack.err) {
                                                console.error(`Failed to migrate comment ${comment.id}: ${ack.err}`);
                                            } else {
                                                console.log(`Migrated comment ${comment.id} for annotation ${id}`);
                                            }
                                            resolveComment();
                                        });
                                    });
                                })).then(() => {
                                    // Write index entry
                                    retryOperation(() => new Promise((resolveIndex, rejectIndex) => {
                                        indexedNode.get(id).put(indexAnnotation, (ack) => {
                                            if (ack.err) {
                                                rejectIndex(new Error(`Failed to update index: ${ack.err}`));
                                            } else {
                                                console.log(`Updated index for annotation: ${id}`);
                                                resolveIndex();
                                            }
                                        });
                                    })).then(() => resolvePut()).catch(err => reject(err));
                                }).catch(err => reject(err));
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to ensure annotation ${id} after retries: ${err.message}`);
                    }
                });
            });
            setTimeout(resolve, 50000);
        });

        // Process sub-shards for high-traffic domains
        if (highTrafficDomains.includes(domain)) {
            for (let i = 0; i < 10; i++) {
                const subShard = `annotations_${domain}_shard_${i}`;
                const subShardNode = gun.get(subShard);

                await new Promise((resolve) => {
                    subShardNode.map().once(async (data, url) => {
                        if (!url) return;

                        const annotations = subShardNode.get(url);
                        annotations.map().once(async (annotation, id) => {
                            if (!annotation || !id) return;

                            if (annotation === null) {
                                console.log(`Removing tombstone: ${subShard}/${url}/${id}`);
                                try {
                                    await retryOperation(() => new Promise((resolvePut, reject) => {
                                        annotations.get(id).put(null, (ack) => {
                                            if (ack.err) {
                                                reject(new Error(`Failed to remove tombstone: ${ack.err}`));
                                            } else {
                                                resolvePut();
                                            }
                                        });
                                    }));
                                } catch (err) {
                                    console.error(`Failed to remove tombstone ${id} after retries: ${err.message}`);
                                }
                                return;
                            }

                            // Check for markup data
                            if (id.includes('replicationMarker') || id.includes('Marker') || id.includes('migrationMarker')) {
                                console.log(`Moving markup data to metadata: ${subShard}/${url}/${id}`);
                                try {
                                    await retryOperation(() => new Promise((resolvePut, reject) => {
                                        metadataNode.get(url).get(id).put(annotation, (ack) => {
                                            if (ack.err) {
                                                reject(new Error(`Failed to move markup data: ${ack.err}`));
                                            } else {
                                                annotations.get(id).put(null);
                                                resolvePut();
                                            }
                                        });
                                    }));
                                } catch (err) {
                                    console.error(`Failed to move markup data ${id} after retries: ${err.message}`);
                                }
                                return;
                            }

                            // Check for unexpected data
                            if (id.startsWith('did:key:') && !(annotation.id && annotation.url && annotation.content && annotation.author && annotation.timestamp)) {
                                console.log(`Moving unexpected data to legacy_data: ${subShard}/${url}/${id}`);
                                try {
                                    await retryOperation(() => new Promise((resolvePut, reject) => {
                                        legacyDataNode.get(url).get(id).put(annotation, (ack) => {
                                            if (ack.err) {
                                                reject(new Error(`Failed to move unexpected data: ${ack.err}`));
                                            } else {
                                                annotations.get(id).put(null);
                                                resolvePut();
                                            }
                                        });
                                    }));
                                } catch (err) {
                                    console.error(`Failed to move unexpected data ${id} after retries: ${err.message}`);
                                }
                                return;
                            }

                            // Validate annotation
                            if (!annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                                console.log(`Skipping invalid annotation: ${subShard}/${url}/${id}`, JSON.stringify(annotation));
                                return;
                            }

                            // Skip deleted annotations
                            if (annotation.isDeleted) {
                                console.log(`Skipping deleted annotation: ${subShard}/${url}/${id}`);
                                try {
                                    await retryOperation(() => new Promise((resolvePut, reject) => {
                                        annotations.get(id).put(null, (ack) => {
                                            if (ack.err) {
                                                reject(new Error(`Failed to remove deleted annotation: ${ack.err}`));
                                            } else {
                                                resolvePut();
                                            }
                                        });
                                    }));
                                } catch (err) {
                                    console.error(`Failed to remove deleted annotation ${id} after retries: ${err.message}`);
                                }
                                return;
                            }

                            const normalizedUrl = normalizeUrl(annotation.url);
                            const indexedNode = gun.get(`annotations_by_url/${normalizedUrl}`);

                            const comments = await new Promise((resolveComments) => {
                                const commentList = [];
                                annotations.get(id).get('comments').map().once((comment) => {
                                    if (comment && comment.id && comment.author && comment.content && comment.timestamp) {
                                        commentList.push({
                                            id: comment.id,
                                            content: comment.content,
                                            author: comment.author,
                                            timestamp: comment.timestamp,
                                            isDeleted: comment.isDeleted || false,
                                            annotationId: comment.annotationId || id,
                                            signature: comment.signature || '',
                                            nonce: comment.nonce || ''
                                        });
                                    }
                                });
                                setTimeout(() => resolveComments(commentList), 3000);
                            });

                            const annotationData = {
                                id: annotation.id,
                                url: normalizedUrl,
                                content: annotation.content || '',
                                author: annotation.author || '',
                                timestamp: annotation.timestamp || Date.now(),
                                isDeleted: annotation.isDeleted || false,
                                text: annotation.text || '',
                                screenshot: annotation.screenshot || '',
                                signature: annotation.signature || '',
                                nonce: annotation.nonce || '',
                                metadata: annotation.metadata || {}
                            };

                            const indexAnnotation = {
                                id: annotationData.id,
                                url: annotationData.url,
                                content: annotationData.content,
                                author: annotationData.author,
                                timestamp: annotationData.timestamp,
                                isDeleted: annotationData.isDeleted,
                                text: annotationData.text,
                                screenshot: annotationData.screenshot,
                                signature: annotationData.signature,
                                nonce: annotationData.nonce,
                                metadata: annotationData.metadata
                            };

                            console.log(`Ensuring annotation in sub-shard: ${subShard}/${url}/${id}`);
                            try {
                                await retryOperation(() => new Promise((resolvePut, reject) => {
                                    // Write annotation data (without comments array)
                                    subShardNode.get(url).get(id).put(annotationData, (ack) => {
                                        if (ack.err) {
                                            reject(new Error(`Failed to ensure annotation in sub-shard: ${ack.err}`));
                                            return;
                                        }

                                        console.log(`Ensured annotation in sub-shard: ${id}`);

                                        // Write comments as individual nodes
                                        Promise.all(comments.map(comment => {
                                            return new Promise((resolveComment) => {
                                                subShardNode.get(url).get(id).get('comments').get(comment.id).put(comment, (ack) => {
                                                    if (ack.err) {
                                                        console.error(`Failed to migrate comment ${comment.id}: ${ack.err}`);
                                                    } else {
                                                        console.log(`Migrated comment ${comment.id} for annotation ${id}`);
                                                    }
                                                    resolveComment();
                                                });
                                            });
                                        })).then(() => {
                                            // Write index entry
                                            retryOperation(() => new Promise((resolveIndex, rejectIndex) => {
                                                indexedNode.get(id).put(indexAnnotation, (ack) => {
                                                    if (ack.err) {
                                                        rejectIndex(new Error(`Failed to update index: ${ack.err}`));
                                                    } else {
                                                        console.log(`Updated index for annotation: ${id}`);
                                                        resolveIndex();
                                                    }
                                                });
                                            })).then(() => resolvePut()).catch(err => reject(err));
                                        }).catch(err => reject(err));
                                    });
                                }));
                            } catch (err) {
                                console.error(`Failed to ensure annotation ${id} in sub-shard after retries: ${err.message}`);
                            }
                        });
                    });
                    setTimeout(resolve, 50000);
                });
            }
        }
    }

    // Step 3: Clean up index node
    console.log('Step 3: Cleaning up index node...');
    const indexNode = gun.get('annotations_by_url');
    await new Promise((resolve) => {
        indexNode.map().once((data, url) => {
            if (!url) return;

            const annotations = indexNode.get(url);
            annotations.map().once((annotation, id) => {
                if (!annotation || !id) return;

                if (annotation === null) {
                    console.log(`Removing tombstone from index: ${url}/${id}`);
                    annotations.get(id).put(null);
                    return;
                }

                if (!annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                    console.log(`Removing invalid index entry: ${url}/${id}`, JSON.stringify(annotation));
                    annotations.get(id).put(null);
                    return;
                }

                if (annotation.isDeleted) {
                    console.log(`Removing deleted index entry: ${url}/${id}`);
                    annotations.get(id).put(null);
                    return;
                }
            });
        });
        setTimeout(resolve, 50000);
    });

    // Step 4: Migrate knownPeers to metadata/peers
    console.log('Step 4: Migrating knownPeers to metadata/peers...');
    const knownPeers = gun.get('knownPeers');
    await new Promise((resolve) => {
        knownPeers.map().once(async (data, id) => {
            if (!id) return;

            if (data === null) {
                console.log(`Removing tombstone from knownPeers: ${id}`);
                try {
                    await retryOperation(() => new Promise((resolvePut, reject) => {
                        knownPeers.get(id).put(null, (ack) => {
                            if (ack.err) {
                                reject(new Error(`Failed to remove tombstone: ${ack.err}`));
                            } else {
                                resolvePut();
                            }
                        });
                    }));
                } catch (err) {
                    console.error(`Failed to remove tombstone ${id} after retries: ${err.message}`);
                }
                return;
            }

            console.log(`Moving peer data to metadata/peers: ${id}`);
            try {
                await retryOperation(() => new Promise((resolvePut, reject) => {
                    metadataNode.get('peers').get(id).put(data, (ack) => {
                        if (ack.err) {
                            reject(new Error(`Failed to move peer data: ${ack.err}`));
                        } else {
                            knownPeers.get(id).put(null, (ack) => {
                                if (ack.err) {
                                    console.error(`Failed to remove legacy peer data: ${ack.err}`);
                                }
                                resolvePut();
                            });
                        }
                    });
                }));
            } catch (err) {
                console.error(`Failed to move peer data ${id} after retries: ${err.message}`);
            }
        });
        setTimeout(resolve, 50000);
    });

    // Step 5: Move unexpected data to legacy_data
    console.log('Step 5: Moving unexpected data to legacy_data...');
    await new Promise((resolve) => {
        legacyAnnotations.map().once(async (data, url) => {
            if (!url) return;

            const annotations = legacyAnnotations.get(url);
            annotations.map().once(async (annotation, id) => {
                if (!annotation || !id) return;

                if (annotation === null) return;

                // Check for unexpected data
                if (id.startsWith('did:key:') && !(annotation.id && annotation.url && annotation.content && annotation.author && annotation.timestamp)) {
                    console.log(`Moving unexpected data to legacy_data: ${url}/${id}`);
                    try {
                        await retryOperation(() => new Promise((resolvePut, reject) => {
                            legacyDataNode.get(url).get(id).put(annotation, (ack) => {
                                if (ack.err) {
                                    reject(new Error(`Failed to move unexpected data: ${ack.err}`));
                                } else {
                                    annotations.get(id).put(null, (ack) => {
                                        if (ack.err) {
                                            console.error(`Failed to remove legacy unexpected data: ${ack.err}`);
                                        }
                                        resolvePut();
                                    });
                                }
                            });
                        }));
                    } catch (err) {
                        console.error(`Failed to move unexpected data ${id} after retries: ${err.message}`);
                    }
                }
            });
        });
        setTimeout(resolve, 50000);
    });

    console.log('Migration complete.');
    process.exit(0);
}

migrateDatabase().catch(err => {
    console.error('Error during migration:', err);
    process.exit(1);
});