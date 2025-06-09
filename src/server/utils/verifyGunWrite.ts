import SEA from 'gun/sea.js';
import {checkRateLimit} from './rateLimit.js';
import {IGunInstance} from 'gun';

export async function verifyGunWrite(data: any, key: string, msg: any, eve: any, gun: IGunInstance<any>): Promise<boolean> {
    if (key === 'test' || key.startsWith('knownPeers')) {
        if (data === null) {
            console.log(`SEA: Allowing null write for ${key}`);
            return true;
        }
        if (key.startsWith('knownPeers')) {
            if (!data || !data.url || !data.timestamp) {
                console.warn(`SEA: Rejecting invalid knownPeers write: ${key}`);
                return false;
            }
            const validUrlPattern = /^https:\/\/[a-zA-Z0-9-.]+\.[a-zA-Z]{2,}(:\d+)?\/gun$/;
            if (!validUrlPattern.test(data.url)) {
                console.warn(`SEA: Rejecting knownPeers write with invalid URL: ${data.url}`);
                return false;
            }
            if (data.url === `${msg.publicUrl}/gun` && key !== msg.peerId) {
                return false;
            }
            return true;
        }
        return true;
    }

    if (data === null || key.includes('replicationMarker') || !data.id) {
        return true;
    }

    if (!data || typeof data !== 'object') {
        console.warn(`SEA: Rejecting invalid data: ${key}`);
        return false;
    }

    const did = data.author || (data.deletion && data.deletion.author);
    if (!did) {
        console.error(`SEA: Write rejected: Missing author DID for key: ${key}`);
        return false;
    }

    try {
        await checkRateLimit(did, gun);
    } catch (error) {
        console.error(`SEA: Write rejected: Rate limit exceeded for DID: ${did}`);
        return false;
    }

    if (data.isDeleted) {
        const deletionNode = gun.get('deletions').get(key);
        const deletionData: any = await new Promise((resolve) => {
            deletionNode.once((d) => resolve(d));
        });

        if (!deletionData || !deletionData.signature || !deletionData.author) {
            console.error(`SEA: Deletion rejected: Missing deletion signature for key: ${key}`);
            gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                action: 'delete',
                key,
                error: 'Missing deletion signature',
                timestamp: Date.now(),
            });
            return false;
        }

        try {
            const publicKey = await extractPublicKeyFromDID(deletionData.author);
            const verified = await SEA.verify(JSON.stringify({
                key,
                timestamp: deletionData.timestamp,
                nonce: deletionData.nonce,
            }), publicKey);

            if (!verified) {
                console.error(`SEA: Deletion rejected: Invalid signature for key: ${key}`);
                gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                    action: 'delete',
                    key,
                    error: 'Invalid deletion signature',
                    timestamp: Date.now(),
                });
                return false;
            }

            const now = Date.now();
            if (Math.abs(now - deletionData.timestamp) > 30 * 60 * 1000) {
                console.error(`SEA: Deletion rejected: Signature timestamp too old for key: ${key}`);
                gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                    action: 'delete',
                    key,
                    error: 'Signature timestamp too old',
                    timestamp: Date.now(),
                });
                return false;
            }

            const isAdmin = await new Promise((resolve) => {
                gun.get('admins').get(did).once((data) => resolve(!!data));
            });
            const targetNode = gun.get(key.split('/')[0]).get(key.split('/')[1]).get(key.split('/')[2]);
            const targetData: any = await new Promise((resolve) => {
                targetNode.once((d) => resolve(d));
            });

            if (!isAdmin && deletionData.author !== targetData.author) {
                console.error(`SEA: Deletion rejected: Unauthorized DID for key: ${key}`);
                gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                    action: 'delete',
                    key,
                    error: 'Unauthorized DID',
                    timestamp: Date.now(),
                });
                return false;
            }

            return true;
        } catch (error) {
            console.error(`SEA: Deletion verification failed for key: ${key}`, error);
            gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                action: 'delete',
                key,
                error: (error as Error).message,
                timestamp: Date.now(),
            });
            return false;
        }
    }

    if (!data.signature || !data.author) {
        console.warn(`SEA: Write rejected: Missing signature or author for key: ${key}`);
        gun.get('securityLogs').get(did).get(Date.now().toString()).put({
            action: 'write',
            key,
            error: 'Missing signature or author',
            timestamp: Date.now(),
        });
        return false;
    }

    try {
        const publicKey = await extractPublicKeyFromDID(data.author);
        const dataToVerify = {
            id: data.id,
            url: data.url,
            content: data.content,
            author: data.author,
            timestamp: data.timestamp,
            nonce: data.nonce,
        };
        const verified = await SEA.verify(JSON.stringify(dataToVerify), publicKey);

        if (!verified) {
            console.error(`SEA: Write rejected: Invalid signature for key: ${key}`);
            gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                action: 'write',
                key,
                error: 'Invalid signature',
                timestamp: Date.now(),
            });
            return false;
        }

        const now = Date.now();
        if (Math.abs(now - data.timestamp) > 30 * 60 * 1000) {
            console.error(`SEA: Write rejected: Signature timestamp too old for key: ${key}`);
            gun.get('securityLogs').get(did).get(Date.now().toString()).put({
                action: 'write',
                key,
                error: 'Signature timestamp too old',
                timestamp: Date.now(),
            });
            return false;
        }

        const versionKey = `${key}/versions/${data.timestamp}`;
        gun.get(versionKey).put(data, (ack: any) => {
            if (ack.err) {
                console.error(`Failed to store version for key: ${versionKey}`, ack.err);
            }
        });

        return true;
    } catch (error) {
        console.error(`SEA: Verification failed for key: ${key}`, error);
        gun.get('securityLogs').get(did).get(Date.now().toString()).put({
            action: 'write',
            key,
            error: (error as Error).message,
            timestamp: Date.now(),
        });
        return false;
    }
}

export async function extractPublicKeyFromDID(did: string): Promise<string> {
    if (!did.startsWith('did:key:')) {
        throw new Error('Invalid DID format');
    }
    const keyPart = did.split('did:key:')[1];
    return keyPart;
}