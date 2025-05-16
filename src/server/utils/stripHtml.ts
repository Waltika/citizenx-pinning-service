/**
 * Strips HTML tags from a string and returns plain text.
 * @param html The HTML string to strip.
 * @returns The plain text with HTML tags removed.
 */
export function stripHtml(html: string): string {
    // Create a temporary DOM element to parse the HTML
    const div = document.createElement('div');
    div.innerHTML = html;
    // Get the text content, which removes HTML tags
    let text = div.textContent || div.innerText || '';
    // Replace multiple spaces with a single space and trim
    text = text.replace(/\s+/g, ' ').trim();
    return text;
}