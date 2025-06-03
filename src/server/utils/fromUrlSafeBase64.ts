export function fromUrlSafeBase64(urlSafeBase64: string): string {
    let base64 = urlSafeBase64.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return base64;
}