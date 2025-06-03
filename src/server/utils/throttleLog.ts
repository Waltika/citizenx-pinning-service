// Throttle logging with expiration
const logThrottle: Map<string, number> = new Map();
const LOG_THROTTLE_TTL = 3600000; // 1 hour in milliseconds

export function throttleLog(message: string, interval: number = 60000): boolean {
    const now = Date.now();
    const lastTime = logThrottle.get(message) || 0;
    if (now - lastTime < interval) return false;
    logThrottle.set(message, now);
    setTimeout(() => logThrottle.delete(message), LOG_THROTTLE_TTL);
    return true;
}