import {throttleLog} from "../utils/throttleLog.js";
import {verifyGunWrite} from "../utils/verifyGunWrite.js";
import {addAnnotationToSitemap} from "../utils/sitemap/addAnnotationsToSitemap.js";
import {publicUrl} from "../config/index.js";
import {PeerData} from "../utils/rateLimit.js";
import {subscribeToNewDomain} from "../endpoints/setupHomepageRoute.js";

export function setupPutHook(gun: any) {
// Modified put hook to capture annotation writes and update sitemap
    gun._.on('put' as any, async (msg: { souls?: string; data?: Record<string, any> }, eve: any) => {
        try {
            if (!msg.souls || !msg.data || typeof msg.data !== 'object') {
                if (throttleLog('invalid_put')) {
                    console.log('Skipping invalid put request', msg);
                }
                return;
            }
            const {data} = msg;
            for (const soul in data) {
                try {
                    if (soul === 'test' || soul.startsWith('knownPeers')) {
                        if (data[soul] === null) {
                            console.log(`Write detected: ${soul} (cleanup)`);
                            continue;
                        }
                        if (throttleLog(`write_${soul}`, 60000)) {
                            console.log(`Write detected: ${soul}`);
                        }
                        continue;
                    }
                    const nodeData = data[soul];
                    if (nodeData === null || soul.includes('replicationMarker')) {
                        if (throttleLog(`skip_${soul}`)) {
                            console.log(`Skipping SEA verification for soul: ${soul}`);
                        }
                        continue;
                    }
                    if (nodeData && typeof nodeData === 'object') {
                        const verified = await verifyGunWrite(nodeData, soul, msg, eve, gun);
                        if (!verified) {
                            console.warn(`Write rejected for soul: ${soul}, data:`, nodeData);
                            continue;
                        }
                        if (soul.includes('annotations_') && nodeData.id && nodeData.url && nodeData.timestamp) {
                            addAnnotationToSitemap(nodeData.id, nodeData.url, nodeData.timestamp);
                        } else if (soul.includes('annotations_')) {
                            console.log(`Skipped incomplete annotation write in ${soul}, data:`, nodeData);
                        }
                    }
                } catch (error) {
                    console.error(`Error processing soul: ${soul}, error:`, error);
                }
            }
        } catch (error) {
            console.error('Error in put hook:', error);
        }
    });

    const peerId: string = `${publicUrl}-bootstrap`;
    let serverPeerUpdateCount = 0;
    setInterval(() => {
        const now = Date.now();
        gun.get('knownPeers').get(peerId).put({
            url: `${publicUrl}/gun`,
            timestamp: now,
            lastConnection: now,
        }, (ack: any) => {
            serverPeerUpdateCount++;
            if (ack.err) {
                console.error(`Failed to update server peer lastConnection: ${ack.err}`);
            } else if (serverPeerUpdateCount % 10 === 0 || throttleLog('server_peer_update', 3600000)) {
                console.log(`Updated server peer lastConnection: ${peerId}`);
            }
        });
    }, 5 * 60 * 1000);

    const peerConnectionCount = new Map<string, number>();
    gun.on('hi', (peer: { url?: string }) => {
        if (peer.url) {
            console.log('Connected to peer:', peer.url);
            const peerId = peer.url.replace(/[^a-zA-Z0-9-]/g, '-') || `peer-${Date.now()}`;
            gun.get('knownPeers').get(peerId).once((data: any) => {
                const now = Date.now();
                const peerData: PeerData = {
                    url: peer.url,
                    timestamp: data?.timestamp || now,
                    lastConnection: now,
                };
                gun.get('knownPeers').get(peerId).put(peerData, (ack: any) => {
                    const count = (peerConnectionCount.get(peerId) || 0) + 1;
                    peerConnectionCount.set(peerId, count);
                    if (ack.err) {
                        console.error(`Failed to update lastConnection for peer ${peerId}:`, ack.err);
                    } else if (count % 10 === 0 || throttleLog(`peer_${peerId}_update`, 3600000)) {
                        console.log(`Updated lastConnection for peer: ${peerId}, URL: ${peer.url}`);
                    }
                });
            });
        }
    });
}