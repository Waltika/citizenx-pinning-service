import RateLimit from 'express-rate-limit';
import {Request} from 'express';

export interface RateLimitRecord {
    count: number;
    startTime: number;
}

export interface PeerData {
    url?: string;
    timestamp: number;
    lastConnection: number;
}

export const limiter = RateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    keyGenerator: (req: Request) => req.ip || 'unknown',
    message: 'Too many requests, please try again later.',
});

const rateLimits = new Map<string, RateLimitRecord>();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const MAX_ACTIONS_PER_WINDOW = 100;

export async function checkRateLimit(did: string, gun: any): Promise<void> {
    const now = Date.now();
    let record = rateLimits.get(did) || {count: 0, startTime: now};

    if (now - record.startTime > RATE_LIMIT_WINDOW) {
        record = {count: 0, startTime: now};
    }

    if (record.count >= MAX_ACTIONS_PER_WINDOW) {
        throw new Error('Rate limit exceeded');
    }

    record.count++;
    rateLimits.set(did, record);
    gun.get('rateLimits').get(did).put(record, (ack: any) => {
        if (ack.err) {
            console.error('Failed to update rate limit for DID:', did, ack.err);
        }
    });
}