// citizenx-pinning-service/test-replication.js
import { createHelia } from 'helia';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { createOrbitDB } from '@orbitdb/core';
import { multiaddr } from '@multiformats/multiaddr';

const bootstrapNodes = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPAeL4N3XUjZx4j4vJqJ5gMhW8f1z2W9z5pQ',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAx2BN6eJ2B2kB4fTdhFVvNx2jdhqWvT9nHmtjNx',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2Ec7tF1R8h6b9XyXzH6j8N2uD4v6q5Z9kM7uR5vM',
];

async function testReplication() {
    console.log('Starting replication test...');

    // Create first Helia instance (simulating the pinning service)
    const ipfs1 = await createHelia({
        libp2p: {
            addresses: {
                listen: ['/ip4/0.0.0.0/tcp/4001/ws'],
            },
            transports: [
                webSockets(),
                circuitRelayTransport({
                    discoverRelays: 1,
                }),
            ],
            peerDiscovery: [
                bootstrap({
                    list: bootstrapNodes,
                }),
            ],
            services: {
                identify: identify(),
                pubsub: gossipsub({ allowSubscribeToAllTopics: true }),
            },
            connectionManager: {
                autoDial: true,
                minConnections: 1,
            },
        },
    });

    // Wait for IPFS1 to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('IPFS1 multiaddrs:', ipfs1.libp2p.getMultiaddrs().map(addr => addr.toString()));

    // Create second Helia instance (simulating the extension)
    const ipfs2 = await createHelia({
        libp2p: {
            addresses: {
                listen: ['/ip4/0.0.0.0/tcp/4002/ws'],
            },
            transports: [
                webSockets(),
                circuitRelayTransport({
                    discoverRelays: 1,
                }),
            ],
            peerDiscovery: [
                bootstrap({
                    list: bootstrapNodes,
                }),
            ],
            services: {
                identify: identify(),
                pubsub: gossipsub({ allowSubscribeToAllTopics: true }),
            },
            connectionManager: {
                autoDial: true,
                minConnections: 1,
            },
        },
    });

    console.log('IPFS2 multiaddrs:', ipfs2.libp2p.getMultiaddrs().map(addr => addr.toString()));

    // Manually dial IPFS1 from IPFS2 using a specific multiaddr
    const ipfs1Addr = multiaddr(`/ip4/127.0.0.1/tcp/4001/ws/p2p/${ipfs1.libp2p.peerId.toString()}`);
    await ipfs2.libp2p.dial(ipfs1Addr);
    console.log('IPFS2 dialed IPFS1');

    ipfs1.libp2p.addEventListener('peer:connect', (event) => {
        const peerId = event.detail?.remotePeer?.toString() || 'unknown';
        console.log('IPFS1 connected to peer:', peerId);
    });

    ipfs2.libp2p.addEventListener('peer:connect', (event) => {
        const peerId = event.detail?.remotePeer?.toString() || 'unknown';
        console.log('IPFS2 connected to peer:', peerId);
    });

    ipfs1.libp2p.services.pubsub.addEventListener('message', (event) => {
        console.log('IPFS1 received pubsub message:', {
            topic: event.detail.topic,
            data: event.detail.data.toString(),
            from: event.detail.from.toString(),
        });
    });

    ipfs2.libp2p.services.pubsub.addEventListener('message', (event) => {
        console.log('IPFS2 received pubsub message:', {
            topic: event.detail.topic,
            data: event.detail.data.toString(),
            from: event.detail.from.toString(),
        });
    });

    const orbitdb1 = await createOrbitDB({ ipfs: ipfs1, id: 'pinning-service', directory: './orbitdb/1' });
    const orbitdb2 = await createOrbitDB({ ipfs: ipfs2, id: 'extension', directory: './orbitdb/2' });

    const db1 = await orbitdb1.open('test-db', {
        type: 'documents',
        accessController: {
            type: 'orbitdb',
            write: ['*'],
        },
    });

    const db2 = await orbitdb2.open(db1.address, {
        type: 'documents',
        accessController: {
            type: 'orbitdb',
            write: ['*'],
        },
    });

    console.log('DB1 address:', db1.address.toString());
    console.log('DB2 address:', db2.address.toString());

    db2.events.on('join', (peerId, heads) => {
        console.log('DB2 peer joined:', { peerId, heads });
    });

    db2.events.on('update', (entry) => {
        console.log('DB2 update:', entry);
    });

    db2.events.on('replicate', (address) => {
        console.log('DB2 replication started for address:', address);
    });

    db2.events.on('replicate.progress', (address, hash, entry, progress, total) => {
        console.log('DB2 replication progress:', { address, hash, entry, progress, total });
    });

    db2.events.on('replicated', (address) => {
        console.log('DB2 replicated from address:', address);
    });

    // Add an entry to DB1
    await db1.put({ _id: 'test1', text: 'Hello World 1' });
    console.log('Added entry to DB1');

    // Wait for replication to complete
    let db2Updated = false;
    await new Promise((resolve) => {
        db2.events.on('update', () => {
            db2Updated = true;
            resolve();
        });
        setTimeout(() => {
            if (!db2Updated) {
                console.log('Replication timeout');
                resolve();
            }
        }, 10000);
    });

    await db1.close();
    await orbitdb1.stop();
    await ipfs1.stop();

    await db2.close();
    await orbitdb2.stop();
    await ipfs2.stop();

    console.log('Test complete');
}

testReplication().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});