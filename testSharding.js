import Gun from 'gun';
import { Annotation } from '@/types';
import { normalizeUrl } from '@/shared/utils/normalizeUrl';

async function testSharding() {
    console.log('Starting sharding test...');
    const gun = Gun({
        peers: [
            'http://localhost:8765/gun',
            'https://citizen-x-bootsrap.onrender.com/gun',
        ],
        radisk: false,
    });

    const testUrl = 'https://www.google.com/search?q=test';
    const normalizedUrl = normalizeUrl(testUrl);
    const domainShard = `annotations_google_com`;
    const subShard = `${domainShard}_shard_${Math.abs(simpleHash(normalizedUrl)) % 10}`;

    function simpleHash(str: string): number {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash;
        }
        return hash;
    }

    // Simulate 10,000 annotations
    const annotations: Annotation[] = [];
    for (let i = 0; i < 10000; i++) {
        annotations.push({
            id: `test-annotation-${i}`,
            url: normalizedUrl,
            content: `Test annotation ${i}`,
            author: 'test-did',
            timestamp: new Date().toISOString(),
            comments: [],
            isDeleted: false,
        });
    }

    console.log('Saving 10,000 annotations to shard:', subShard);
    const startTime = Date.now();
    await Promise.all(annotations.map(annotation =>
            new Promise<void>((resolve, reject) => {
                gun.get(subShard).get(normalizedUrl).get(annotation.id).put(annotation, (ack: any) => {
                    if (ack.err) {
                        console.error('Failed to save annotation:', ack.err);
                        reject(new Error(ack.err));
                    } else {
                        resolve();
                    }
                });
            })
    ));
    const saveTime = Date.now() - startTime;
    console.log(`Saved 10,000 annotations in ${saveTime}ms`);

    // Fetch annotations
    console.log('Fetching annotations from shards...');
    const fetchedAnnotations: Annotation[] = [];
    const nodes = [
        gun.get('annotations').get(normalizedUrl),
        gun.get(domainShard).get(normalizedUrl),
        gun.get(subShard).get(normalizedUrl),
    ];

    await Promise.all(nodes.map(node =>
            new Promise<void>((resolve) => {
                node.map().once((annotation: any) => {
                    if (annotation && !annotation.isDeleted) {
                        fetchedAnnotations.push({
                            id: annotation.id,
                            url: annotation.url,
                            content: annotation.content,
                            author: annotation.author,
                            timestamp: annotation.timestamp,
                            comments: [],
                            isDeleted: annotation.isDeleted || false,
                        });
                    }
                });
                setTimeout(resolve, 5000);
            })
    ));

    console.log(`Fetched ${fetchedAnnotations.length} annotations`);
    if (fetchedAnnotations.length === annotations.length) {
        console.log('Test passed: All annotations were saved and retrieved correctly');
    } else {
        console.error('Test failed: Mismatch in number of annotations');
    }

    // Verify data consistency
    const isConsistent = fetchedAnnotations.every((ann, index) =>
        ann.id === annotations[index].id && ann.content === annotations[index].content
    );
    console.log('Data consistency:', isConsistent ? 'Passed' : 'Failed');

    // Test existing data accessibility
    console.log('Testing access to existing (non-sharded) annotations...');
    const legacyAnnotations = await new Promise<Annotation[]>((resolve) => {
        const legacy: Annotation[] = [];
        gun.get('annotations').get(normalizedUrl).map().once((annotation: any) => {
            if (annotation && !annotation.isDeleted) {
                legacy.push({
                    id: annotation.id,
                    url: annotation.url,
                    content: annotation.content,
                    author: annotation.author,
                    timestamp: annotation.timestamp,
                    comments: [],
                    isDeleted: annotation.isDeleted || false,
                });
            }
        });
        setTimeout(() => resolve(legacy), 2000);
    });
    console.log(`Fetched ${legacyAnnotations.length} legacy annotations`);

    // Cleanup
    await Promise.all(annotations.map(annotation =>
            new Promise<void>((resolve) => {
                gun.get(subShard).get(normalizedUrl).get(annotation.id).put({ isDeleted: true }, () => resolve());
            })
    ));
    console.log('Cleaned up test annotations');
}

testSharding().catch(err => console.error('Test failed:', err));