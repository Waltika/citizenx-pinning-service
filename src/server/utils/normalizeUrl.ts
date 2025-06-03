// File: src/shared/utils/normalizeUrl.ts
export function normalizeUrl(url: string): string {
    // Remove duplicate protocols (e.g., https://https://)
    let cleanUrl = url.replace(/^(https?:\/\/)+/, 'https://');
    // Remove non-functional parameters (e.g., UTM parameters)
    const urlObj = new URL(cleanUrl);
    const params = new URLSearchParams(urlObj.search);
    const utmKeys = [];
    for (const key of params.keys()) {
        if (key.startsWith('utm_')) {
            utmKeys.push(key);
        }
    }
    utmKeys.forEach(key => params.delete(key));
    urlObj.search = params.toString();
    // Remove trailing slashes from final URL
    return urlObj.toString().replace(/\/+$/, '');
}