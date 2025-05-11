import Gun from 'gun';

const gunServerUrl = 'https://citizen-x-bootsrap.onrender.com/gun';

const gun = Gun([gunServerUrl]);

async function clearKnownPeers() {
    console.log('Starting cleanup of knownPeers dataset...');

    try {
        await new Promise((resolve) => {
            gun.get('knownPeers').map().once((peer, id) => {
                if (!id) {
                    console.log('Skipping empty ID');
                    return;
                }
                console.log(`Removing peer entry: ${id}, URL: ${peer?.url || 'no url'}`);
                gun.get('knownPeers').get(id).put(null, (ack) => {
                    if (ack.err) {
                        console.error(`Failed to remove peer entry: ${id}, Error: ${ack.err}`);
                    } else {
                        console.log(`Successfully removed peer entry: ${id}`);
                    }
                });
            });
            setTimeout(resolve, 5000); // Wait 5 seconds for removals
        });

        console.log('Cleanup of knownPeers completed.');
        await new Promise((resolve) => {
            gun.get('knownPeers').map().once((peer, id) => {
                if (peer && peer.url) {
                    console.log(`Remaining peer after cleanup: ${id}, URL: ${peer.url}`);
                }
            });
            setTimeout(resolve, 2000); // Wait 2 seconds to check remaining peers
        });
    } catch (error) {
        console.error('Error during knownPeers cleanup:', error);
        process.exit(1);
    }
}

clearKnownPeers().then(() => {
    console.log('Script completed successfully.');
    setTimeout(() => process.exit(0), 1000); // Exit after 1 second
}).catch(error => {
    console.error('Cleanup failed:', error);
    process.exit(1);
});