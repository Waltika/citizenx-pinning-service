/**
 * Strips HTML tags from a string and returns plain text.
 * @param html The HTML string to strip.
 * @returns The plain text with HTML tags removed.
 */
export function stripHtml(html: string): string {
    return html.replace(/<[^>]*>/g, '');
}