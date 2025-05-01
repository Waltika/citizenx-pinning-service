import Gun from 'gun';
import http from 'http';

// Default port for the Gun server (Render will set PORT automatically)
const port = process.env.PORT || 8765;

// Hardcode the public URL for Render
const publicUrl = 'https://citizen-x-bootsrap.onrender.com';

// Initial list of known peers (empty since this is the first bootstrap node)
const initialPeers = [];

// Create an HTTP server for Gun
const server = http.createServer(Gun.serve(import.meta.url)).listen(port);
const gun = Gun({
    web: server,
    peers: initialPeers,
    file: 'gun-data',
    radisk: true,
});

// Register this server's URL in the knownPeers node
const peerId = `${publicUrl}-${Date.now()}`; // Unique ID for this server instance
gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
    if (ack.err) {
        console.error('Failed to register server in knownPeers:', ack.err);
    } else {
        console.log(`Registered server in knownPeers: ${publicUrl}/gun`);
    }
});

// Keep the entry alive by periodically updating the timestamp
setInterval(() => {
    gun.get('knownPeers').get(peerId).put({ url: `${publicUrl}/gun`, timestamp: Date.now() }, (ack) => {
        if (ack.err) {
            console.error('Failed to update server timestamp in knownPeers:', ack.err);
        }
    });
}, 5 * 60 * 1000); // Update every 5 minutes

// Clean up stale peers (older than 10 minutes)
setInterval(() => {
    gun.get('knownPeers').map().once((peer, id) => {
        if (peer && peer.url && peer.timestamp) {
            const now = Date.now();
            const age = now - peer.timestamp;
            if (age > 10 * 60 * 1000) { // 10 minutes
                console.log('Removing stale peer:', peer.url);
                gun.get('knownPeers').get(id).put(null);
            }
        }
    });
}, 5 * 60 * 1000); // Check every 5 minutes

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.length > 0 ? initialPeers.join(', ') : 'none'}`);

// Log peer connections
gun.on('hi', (peer) => {
    console.log('Connected to peer:', peer);
});