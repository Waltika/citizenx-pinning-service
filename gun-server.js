import Gun from 'gun';
import 'gun/axe.js'; // Enable AXE relay
import http from 'http';

const multicastConfig = { host: '233.255.255.255', port: 8765 }; // Define multicast config separately

const server = http.createServer().listen(8765);
const gun = Gun({
    web: server,
    radisk: true, // Enable persistence to disk (stores data in radata folder)
    multicast: multicastConfig, // Enable multicast for local discovery
});

console.log('Gun server running on port 8765');
console.log(`Multicast on ${multicastConfig.host}:${multicastConfig.port}`);

// Log data updates for debugging
gun.on('put', (data) => {
    if (data.put && data.put['#'].startsWith('profiles')) {
        console.log('Profiles updated:', JSON.stringify(data.put, null, 2));
    }
    if (data.put && data.put['#'].startsWith('annotations')) {
        console.log('Annotations updated:', JSON.stringify(data.put, null, 2));
    }
});