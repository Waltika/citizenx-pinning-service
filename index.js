// index.js
import { createHelia } from 'helia';
import { webSockets } from '@libp2p/websockets';
import { webRTC } from '@libp2p/webrtc';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';
import { bootstrap } from '@libp2p/bootstrap';
import { identify } from '@libp2p/identify';
import { FaultTolerance } from '@libp2p/interface';
import { createOrbitDB } from '@orbitdb/core';

// Bootstrap nodes (same as CitizenX)
const bootstrapNodes = [
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPAeL4N3XUjZx4j4vJqJ5gMhW8f1z2W9z5pQ',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmZa1sAx2BN6eJ2B2kB4fTdhFVvNx2jdhqWvT9nHmtjNx',
    '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2Ec7tF1R8h6b9XyXzH6j8N2uD4v6q5Z9kM7uR5vM'
];

async function startPinningService() {
    console.log('Starting CitizenX Pinning Service...');

    // Initialize Helia (IPFS) node with libp2p
    const ipfs = await createHelia({
        libp2p: {
            transports: [webSockets(), webRTC(), circuitRelayTransport()],
            transportManager: { faultTolerance: FaultTolerance.NO_FATAL },
            peerDiscovery: [
                bootstrap({
                    list: bootstrapNodes
                })
            ],
            services: {
                identify: identify(),
                pubsub: gossipsub()
            }
        }
    });

    console.log('Helia node started:', ipfs.libp2p.getMultiaddrs());

    // Log peer discovery events
    ipfs.libp2p.addEventListener('peer:discovery', (event) => {
        const peerId = event.detail.id.toString();
        console.log('Discovered peer:', peerId);
    });

    // Initialize OrbitDB
    const orbitdb = await createOrbitDB({ ipfs });
    console.log('OrbitDB initialized');

    // Open the databases
    const annotationsDb = await orbitdb.open('citizenx-annotations', { type: 'documents' });
    const profilesDb = await orbitdb.open('citizenx-profiles', { type: 'documents' });

    console.log('Databases opened:', {
        annotationsDb: annotationsDb.address.toString(),
        profilesDb: profilesDb.address.toString()
    });

    // Log replication events for annotations
    annotationsDb.events.on('update', (entry) => {
        console.log('Annotations database update:', entry);
    });

    // Log replication events for profiles
    profilesDb.events.on('update', (entry) => {
        console.log('Profiles database update:', entry);
    });

    // Load existing data from the databases using iterator()
    const annotations = [];
    try {
        for await (const doc of annotationsDb.iterator()) {
            annotations.push(doc);
        }
        console.log('Loaded annotations:', annotations);
    } catch (error) {
        console.error('Failed to load annotations:', error);
    }

    const profiles = [];
    try {
        for await (const doc of profilesDb.iterator()) {
            profiles.push(doc);
        }
        console.log('Loaded profiles:', profiles);
    } catch (error) {
        console.error('Failed to load profiles:', error);
    }

    // Keep the process running
    console.log('Pinning service running. Press Ctrl+C to stop.');
}

// Start the pinning service
startPinningService().catch((error) => {
    console.error('Failed to start pinning service:', error);
    process.exit(1);
});