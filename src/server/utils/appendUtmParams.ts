import {ParsedQs} from "qs";

export function appendUtmParams(baseUrl: string, utmParams: ParsedQs): string {
    const url = new URL(baseUrl);
    const validUtmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    validUtmKeys.forEach(key => {
        const value = utmParams[key];
        if (typeof value === 'string') {
            url.searchParams.set(key, value);
        }
    });
    return url.toString();
}