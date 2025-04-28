import Gun from 'gun';
import http from 'http';

// Default port for the Gun server
const port = process.env.PORT || 8765;

// Public URL of this server (must be provided by the user, e.g., via ngrok)
const publicUrl = process.env.PUBLIC_URL;

// Initial list of known peers (can be empty if this is the first server)
const initialPeers = process.env.GUN_PEERS ? process.env.GUN_PEERS.split(',') : [];

// Validate public URL
if (!publicUrl) {
    console.error('PUBLIC_PUURL environment variable is required. Please set the public URL of this server (e.g., https://abc123.ngrok.io).');
    process.exit(1);
}

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

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.length > 0 ? initialPeers.join(', ') : 'none'}`);

// Log peer connections
gun.on('hi', (peer) => {
    console.log('Connected to peer:', peer);
});