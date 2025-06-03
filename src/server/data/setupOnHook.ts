import {throttleLog} from "../utils/throttleLog.js";

export function setupOnHook(gun: any) {
// Log incoming messages
    gun._.on('in', (msg: { put?: Record<string, any> }) => {
        if (msg.put) {
            const souls = Object.keys(msg.put).join(', ');
            if (throttleLog(`write_${souls}`, 60000)) {
                console.log(`Incoming write request for souls: ${souls}`);
            }
        }
    });
}