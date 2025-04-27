// citizenx-pinning-service/test-ipfs-core-address.js
import IPFS from 'js-ipfs';
import { createOrbitDB } from '@orbitdb/core';

async function testIpfsCoreAddress() {
    console.log('Starting JS-IPFS address test...');

    const ipfs = await IPFS.create({
        repo: './ipfs-repo',
        config: {
            Addresses: {
                Swarm: [
                    '/ip4/0.0.0.0/tcp/4002',
                    '/ip4/127.0.0.1/tcp/4003/ws',
                ],
            },
        },
    });

    console.log('IPFS node started:', ipfs);

    console.log('IPFS block API:', ipfs.block);

    const orbitdb = await createOrbitDB({ ipfs });

    console.log('OrbitDB instance created:', orbitdb);

    const db1 = await orbitdb.open('test-db', { type: 'documents' });
    const generatedAddress = db1.address.toString();
    console.log('Generated address:', generatedAddress);

    await db1.close();

    const db2 = await orbitdb.open('test-db', {
        type: 'documents',
        address: generatedAddress,
    });
    console.log('Reopened database with address:', db2.address.toString());

    await orbitdb.stop();
    await ipfs.stop();
}

testIpfsCoreAddress().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});