// citizenx-pinning-service/index.js
import { createHelia } from 'helia';
import { webSockets } from '@libp2p/websockets';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { createOrbitDB } from '@orbitdb/core';
import { writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';

const bootstrapNodes = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPAeL4N3XUjZx4j4vJqJ5gMhW8f1z2W9z5pQ',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAx2BN6eJ2B2kB4fTdhFVvNx2jdhqWvT9nHmtjNx',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2Ec7tF1R8h6b9XyXzH6j8N2uD4v6q5Z9kM7uR5vM',
];

const ADDRESS_FILE = './database-addresses.json';

async function startPinningService() {
    console.log('Starting CitizenX Pinning Service...');

    const ipfs = await createHelia({
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

    console.log('Helia node started:', ipfs.libp2p.getMultiaddrs().map(addr => addr.toString()));
    console.log('Pinning service peer ID:', ipfs.libp2p.peerId.toString());

    // Wait for IPFS to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000));
    console.log('Finished waiting for IPFS initialization');

    ipfs.libp2p.addEventListener('peer:discovery', (event) => {
        const peerId = event.detail.id?.toString() || 'unknown';
        console.log('Discovered peer:', peerId);
    });

    ipfs.libp2p.addEventListener('peer:connect', (event) => {
        const peerId = event.detail?.remotePeer?.toString() || 'unknown';
        console.log('Connected to peer:', peerId);
    });

    ipfs.libp2p.services.pubsub.addEventListener('subscription-change', (event) => {
        const { peerId, subscriptions } = event.detail;
        console.log('Pubsub subscription change:', peerId?.toString() || 'unknown', subscriptions);
    });

    ipfs.libp2p.services.pubsub.addEventListener('message', (event) => {
        console.log('Received pubsub message:', {
            topic: event.detail.topic,
            data: event.detail.data.toString(),
            from: event.detail.from.toString(),
        });
    });

    setInterval(() => {
        const peers = ipfs.libp2p.getPeers();
        console.log('Connected peers:', peers.map(peer => peer.toString()));
    }, 30000);

    const orbitdb = await createOrbitDB({ ipfs, id: 'pinning-service', directory: './orbitdb/pinning' });
    console.log('OrbitDB initialized');

    let annotationsAddress, profilesAddress;

    if (existsSync(ADDRESS_FILE)) {
        const savedAddresses = JSON.parse(await readFile(ADDRESS_FILE, 'utf-8'));
        annotationsAddress = savedAddresses.annotationsDb;
        profilesAddress = savedAddresses.profilesDb;
        console.log('Loaded saved addresses:', savedAddresses);
    }

    const annotationsDb = await orbitdb.open('citizenx-annotations-v2', {
        type: 'documents',
        accessController: {
            type: 'orbitdb',
            write: ['*'],
        },
    });

    const profilesDb = await orbitdb.open('citizenx-profiles-v2', {
        type: 'documents',
        accessController: {
            type: 'orbitdb',
            write: ['*'],
        },
    });

    if (!annotationsAddress || !profilesAddress) {
        annotationsAddress = annotationsDb.address.toString();
        profilesAddress = profilesDb.address.toString();
        await writeFile(
            ADDRESS_FILE,
            JSON.stringify({
                annotationsDb: annotationsAddress,
                profilesDb: profilesAddress,
            }),
            'utf-8'
        );
        console.log('Saved new addresses to file:', { annotationsDb: annotationsAddress, profilesDb: profilesAddress });
    }

    console.log('Databases opened:', {
        annotationsDb: annotationsDb.address.toString(),
        profilesDb: profilesDb.address.toString(),
    });

    // Add a delay to ensure the database is fully subscribed
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log('Finished waiting for database subscription');

    annotationsDb.events.on('join', (peerId, heads) => {
        console.log('Annotations database peer joined:', { peerId, heads });
    });

    annotationsDb.events.on('update', (entry) => {
        console.log('Annotations database update:', entry);
    });

    annotationsDb.events.on('replicate', (address) => {
        console.log('Annotations database replication started for address:', address);
    });

    annotationsDb.events.on('replicate.progress', (address, hash, entry, progress, total) => {
        console.log('Annotations database replication progress:', {
            address,
            hash,
            entry,
            progress,
            total,
        });
    });

    annotationsDb.events.on('replicated', (address) => {
        console.log('Annotations database replicated from address:', address);
    });

    profilesDb.events.on('join', (peerId, heads) => {
        console.log('Profiles database peer joined:', { peerId, heads });
    });

    profilesDb.events.on('update', (entry) => {
        console.log('Profiles database update:', entry);
    });

    profilesDb.events.on('replicate', (address) => {
        console.log('Profiles database replication started for address:', address);
    });

    profilesDb.events.on('replicate.progress', (address, hash, entry, progress, total) => {
        console.log('Profiles database replication progress:', {
            address,
            hash,
            entry,
            progress,
            total,
        });
    });

    profilesDb.events.on('replicated', (address) => {
        console.log('Profiles database replicated from address:', address);
    });

    const annotationsTopic = annotationsDb.address.toString();
    const profilesTopic = profilesDb.address.toString();

    ipfs.libp2p.services.pubsub.subscribe(annotationsTopic);
    ipfs.libp2p.services.pubsub.subscribe(profilesTopic);

    console.log('Manually subscribed to topics:', { annotationsTopic, profilesTopic });

    setInterval(() => {
        const subscribedTopics = ipfs.libp2p.services.pubsub.getTopics();
        if (!subscribedTopics.includes(annotationsTopic)) {
            console.log('Annotations topic subscription lost, resubscribing...');
            ipfs.libp2p.services.pubsub.subscribe(annotationsTopic);
        } else {
            console.log('Still subscribed to annotations topic:', annotationsTopic);
        }
        if (!subscribedTopics.includes(profilesTopic)) {
            console.log('Profiles topic subscription lost, resubscribing...');
            ipfs.libp2p.services.pubsub.subscribe(profilesTopic);
        } else {
            console.log('Still subscribed to profiles topic:', profilesTopic);
        }
    }, 30000);

    const annotations = [];
    for await (const doc of annotationsDb.iterator()) {
        annotations.push(doc);
    }
    console.log('Loaded annotations:', annotations);

    const profiles = [];
    for await (const doc of profilesDb.iterator()) {
        profiles.push(doc);
    }
    console.log('Loaded profiles:', profiles);

    console.log('Pinning service running. Press Ctrl+C to stop.');
}

startPinningService().catch(err => {
    console.error('Error starting pinning service:', err);
    process.exit(1);
});