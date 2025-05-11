import Gun from 'gun';
import WebSocket from 'ws';

const gunServerUrl = 'https://citizen-x-bootsrap.onrender.com/gun';
const wsServerUrl = gunServerUrl.replace('https://', 'wss://');

async function testServerConnectivity() {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        attempt++;
        try {
            await new Promise((resolve, reject) => {
                const ws = new WebSocket(wsServerUrl);
                const timeout = setTimeout(() => {
                    ws.close();
                    reject(new Error(`Timeout connecting to ${wsServerUrl}`));
                }, 5000);

                ws.on('open', () => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve();
                });

                ws.on('error', (error) => {
                    clearTimeout(timeout);
                    reject(error);
                });
            });
            console.log(`WebSocket connection successful (attempt ${attempt}):`, wsServerUrl);
            return true;
        } catch (error) {
            console.error(`WebSocket connection failed (attempt ${attempt}):`, error.message);
            if (attempt === maxRetries) {
                return false;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
    return false;
}

const gun = Gun({
    peers: [gunServerUrl],
    radisk: false // Disable local storage to avoid caching
});

async function clearKnownPeers() {
    console.log('Starting cleanup of knownPeers dataset...');

    // Test server connectivity
    if (!(await testServerConnectivity())) {
        console.error('Aborting cleanup due to server unresponsiveness.');
        process.exit(1);
    }

    // Pre-cleanup write test
    console.log('Performing pre-cleanup write test...');
    try {
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout during pre-cleanup write test'));
            }, 10000);
            gun.get('test').put({ ping: Date.now() }, (ack) => {
                clearTimeout(timeout);
                if (ack.err) {
                    reject(new Error(`Pre-cleanup write test failed: ${ack.err}`));
                } else {
                    console.log('Pre-cleanup write test successful');
                    resolve();
                }
            });
        });
    } catch (error) {
        console.error('Pre-cleanup write test failed:', error.message);
        process.exit(1);
    }

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
        attempt++;
        console.log(`Cleanup attempt ${attempt} of ${maxRetries}...`);

        try {
            // Collect all peer IDs
            const peerIds = new Set();
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.error('Timeout collecting peer IDs');
                    reject(new Error('Timeout collecting peer IDs'));
                }, 15000);
                gun.get('knownPeers').map().once((peer, id) => {
                    if (id) {
                        peerIds.add(id);
                        console.log(`Found peer entry: ${id}, URL: ${peer?.url || 'no url'}`);
                    }
                });
                setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                }, 10000);
            }).catch(error => {
                console.warn(`Continuing after error collecting IDs: ${error.message}`);
            });

            if (peerIds.size === 0) {
                console.log('No peers found to remove.');
                break;
            }

            // Remove each peer with put(null)
            for (const id of peerIds) {
                console.log(`Removing peer entry with put(null): ${id}`);
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        console.error(`Timeout waiting for put(null) acknowledgment: ${id}`);
                        reject(new Error(`Timeout for ${id}`));
                    }, 30000); // Increased to 30 seconds
                    gun.get('knownPeers').get(id).put(null, (ack) => {
                        clearTimeout(timeout);
                        if (ack.err) {
                            console.error(`Failed to remove peer entry with put(null): ${id}, Error: ${ack.err}`);
                        } else {
                            console.log(`Successfully removed peer entry with put(null): ${id}`);
                        }
                        resolve();
                    });
                }).catch(error => {
                    console.warn(`Continuing after error for ${id}: ${error.message}`);
                });
            }

            // Wait for changes to propagate
            await new Promise(resolve => setTimeout(resolve, 30000));

            // Verify cleanup
            console.log('Verifying cleanup...');
            let remainingPeers = 0;
            const remainingIds = new Set();
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    console.error('Timeout verifying cleanup');
                    reject(new Error('Timeout verifying cleanup'));
                }, 15000);
                gun.get('knownPeers').map().once((peer, id) => {
                    if (peer && id) {
                        console.log(`Remaining peer after put(null): ${id}, URL: ${peer.url || 'no url'}`);
                        remainingPeers++;
                        remainingIds.add(id);
                    }
                });
                setTimeout(() => {
                    clearTimeout(timeout);
                    resolve();
                }, 10000);
            }).catch(error => {
                console.warn(`Continuing after error verifying cleanup: ${error.message}`);
            });

            // If peers remain, try put({})
            if (remainingPeers > 0) {
                console.warn(`Warning: ${remainingPeers} peers remain after put(null). Trying put({})...`);
                for (const id of remainingIds) {
                    console.log(`Removing peer entry with put({}): ${id}`);
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            console.error(`Timeout waiting for put({}) acknowledgment: ${id}`);
                            reject(new Error(`Timeout for ${id}`));
                        }, 30000);
                        gun.get('knownPeers').get(id).put({}, (ack) => {
                            clearTimeout(timeout);
                            if (ack.err) {
                                console.error(`Failed to remove peer entry with put({}): ${id}, Error: ${ack.err}`);
                            } else {
                                console.log(`Successfully removed peer entry with put({}): ${id}`);
                            }
                            resolve();
                        });
                    }).catch(error => {
                        console.warn(`Continuing after error for ${id}: ${error.message}`);
                    });
                }

                // Wait again
                await new Promise(resolve => setTimeout(resolve, 30000));

                // Verify after put({})
                remainingPeers = 0;
                remainingIds.clear();
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        console.error('Timeout verifying cleanup after put({})');
                        reject(new Error('Timeout verifying cleanup'));
                    }, 15000);
                    gun.get('knownPeers').map().once((peer, id) => {
                        if (peer && id) {
                            console.log(`Still remaining peer after put({}): ${id}, URL: ${peer.url || 'no url'}`);
                            remainingPeers++;
                            remainingIds.add(id);
                        }
                    });
                    setTimeout(() => {
                        clearTimeout(timeout);
                        resolve();
                    }, 10000);
                }).catch(error => {
                    console.warn(`Continuing after error verifying cleanup: ${error.message}`);
                });

                // If still remaining, try unsetting fields
                if (remainingPeers > 0) {
                    console.warn(`Warning: ${remainingPeers} peers remain after put({}). Trying to unset fields...`);
                    for (const id of remainingIds) {
                        console.log(`Unsetting fields for peer entry: ${id}`);
                        await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => {
                                console.error(`Timeout waiting for field unset acknowledgment: ${id}`);
                                reject(new Error(`Timeout for ${id}`));
                            }, 30000);
                            gun.get('knownPeers').get(id).put({ url: null, timestamp: null }, (ack) => {
                                clearTimeout(timeout);
                                if (ack.err) {
                                    console.error(`Failed to unset fields for peer entry: ${id}, Error: ${ack.err}`);
                                } else {
                                    console.log(`Successfully unset fields for peer entry: ${id}`);
                                }
                                resolve();
                            });
                        }).catch(error => {
                            console.warn(`Continuing after error for ${id}: ${error.message}`);
                        });
                    }

                    // Final wait and check
                    await new Promise(resolve => setTimeout(resolve, 30000));
                    remainingPeers = 0;
                    await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => {
                            console.error('Timeout verifying final cleanup');
                            reject(new Error('Timeout verifying final cleanup'));
                        }, 15000);
                        gun.get('knownPeers').map().once((peer, id) => {
                            if (peer && id) {
                                console.log(`Still remaining peer after unset: ${id}, URL: ${peer.url || 'no url'}`);
                                remainingPeers++;
                                remainingIds.add(id);
                            }
                        });
                        setTimeout(() => {
                            clearTimeout(timeout);
                            resolve();
                        }, 10000);
                    }).catch(error => {
                        console.warn(`Continuing after error verifying final cleanup: ${error.message}`);
                    });

                    // If still remaining, try clearing entire knownPeers
                    if (remainingPeers > 0) {
                        console.warn(`Warning: ${remainingPeers} peers remain after unsetting fields. Trying to clear entire knownPeers...`);
                        await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => {
                                console.error('Timeout waiting for knownPeers clear acknowledgment');
                                reject(new Error('Timeout clearing knownPeers'));
                            }, 30000);
                            gun.get('knownPeers').put(null, (ack) => {
                                clearTimeout(timeout);
                                if (ack.err) {
                                    console.error(`Failed to clear knownPeers: Error: ${ack.err}`);
                                } else {
                                    console.log('Successfully cleared knownPeers');
                                }
                                resolve();
                            });
                        }).catch(error => {
                            console.warn(`Continuing after error clearing knownPeers: ${error.message}`);
                        });

                        // Final verification
                        remainingPeers = 0;
                        await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => {
                                console.error('Timeout verifying final cleanup after clearing knownPeers');
                                reject(new Error('Timeout verifying final cleanup'));
                            }, 15000);
                            gun.get('knownPeers').map().once((peer, id) => {
                                if (peer && id) {
                                    console.log(`Still remaining peer after clearing knownPeers: ${id}, URL: ${peer.url || 'no url'}`);
                                    remainingPeers++;
                                }
                            });
                            setTimeout(() => {
                                clearTimeout(timeout);
                                resolve();
                            }, 10000);
                        }).catch(error => {
                            console.warn(`Continuing after error verifying final cleanup: ${error.message}`);
                        });

                        if (remainingPeers > 0) {
                            console.error(`Error: ${remainingPeers} peers still remain after all attempts. Check server persistence or network issues.`);
                            throw new Error('Failed to clear all peers');
                        }
                    }
                }
            }

            console.log('Cleanup of knownPeers completed successfully.');
            return;
        } catch (error) {
            console.error(`Error during cleanup attempt ${attempt}:`, error);
            if (attempt === maxRetries) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }
}

clearKnownPeers().then(() => {
    console.log('Script completed successfully.');
    setTimeout(() => process.exit(0), 1000);
}).catch(error => {
    console.error('Cleanup failed:', error);
    process.exit(1);
});