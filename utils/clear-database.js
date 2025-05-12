import Gun from 'gun';

const gun = Gun({ peers: ['https://citizen-x-bootsrap.onrender.com/gun'] });

const nodes = [
    'annotations',
    'annotations_by_url',
    'known_nodes',
    'profiles',
    'securityLogs',
    'rateLimits',
    'metadata',
    'knownPeers',
    'admins',
    'deletions',
    'versions',
    'legacy_data',
    'annotations_extensions',
    'annotations_citizenx_app',
    'annotations_dashboard_render_com',
    'annotations_forum_vivaldi_net',
    'annotations_search_google_com',
    'annotations_www_aaa_com',
    'annotations_x_com',
    'annotations_x_com_shard_0',
    'annotations_x_com_shard_1',
    'annotations_x_com_shard_2',
    'annotations_x_com_shard_3',
    'annotations_x_com_shard_4',
    'annotations_x_com_shard_5',
    'annotations_x_com_shard_6',
    'annotations_x_com_shard_7',
    -    'annotations_x_com_shard_8',
    'annotations_x_com_shard_9'
];

async function clearNode(node) {
    console.log(`Clearing node: ${node}`);
    await new Promise((resolve) => {
        gun.get(node).map().once((data, key) => {
            gun.get(node).get(key).put(null, (ack) => {
                if (ack.err) {
                    console.error(`Failed to clear subnode ${key} in ${node}: ${ack.err}`);
                } else {
                    console.log(`Cleared subnode ${key} in ${node}`);
                }
            });
        });
        // Wait for all subnodes to be processed
        setTimeout(resolve, 1000);
    });
}

async function clearDatabase() {
    for (const node of nodes) {
        await clearNode(node);
    }
    console.log('Database clearing completed');
    process.exit(0);
}

clearDatabase().catch(err => {
    console.error('Error clearing database:', err);
    process.exit(1);
});