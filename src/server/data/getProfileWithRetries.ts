// Profile cache
const profileCache = new Map<string, { handle: string; profilePicture?: string }>();

export function clearProfileCache() {
    profileCache.clear();
}

export async function getProfileWithRetries(gun: any, did: string, retries: number = 5, delay: number = 100): Promise<{
    handle: string;
    profilePicture?: string
}> {
    if (profileCache.has(did)) {
        return profileCache.get(did)!;
    }

    for (let attempt = 1; attempt <= retries; attempt++) {
        const profile = await new Promise<{ handle: string; profilePicture?: string } | null>((resolve) => {
            gun.get('profiles').get(did).once((data: any) => {
                if (data && data.handle) {
                    resolve({
                        handle: data.handle,
                        profilePicture: data.profilePicture,
                    });
                } else {
                    gun.get(`user_${did}`).get('profile').once((userData: any) => {
                        if (userData && userData.handle) {
                            resolve({
                                handle: userData.handle,
                                profilePicture: userData.profilePicture,
                            });
                        } else {
                            resolve(null);
                        }
                    });
                }
            });
        });

        if (profile) {
            profileCache.set(did, profile);
            setTimeout(() => profileCache.delete(did), 5 * 60 * 1000);
            return profile;
        }

        console.log(`Retrying profile fetch for DID: ${did}, attempt ${attempt}/${retries}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
    }

    console.error('Failed to load profile for DID after retries:', did);
    return {handle: 'Unknown'};
}