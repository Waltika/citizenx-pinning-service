import axios from 'axios';
import { stripHtml } from './stripHtml.js';

// Cache for Grok API responses (key: content hash, value: {title, anchorText})
const metadataCache = new Map<string, {title: string, anchorText: string}>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Simple hash function for caching
function simpleHash(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString();
}

export async function generateMetadata(content: string, url: string, author: string): Promise<{title: string, anchorText: string}> {
    const cleanContent = stripHtml(content).substring(0, 1000); // Limit content size
    const cacheKey = simpleHash(cleanContent + url + author);

    // Check cache
    const cached = metadataCache.get(cacheKey);
    if (cached) {
        console.log(`[Grok API] Using cached metadata for key: ${cacheKey}`);
        return cached;
    }

    try {
        const response = await axios.post(
            'https://api.x.ai/v1/chat/completions',
            {
                model: 'grok-3',
                messages: [
                    {
                        role: 'user',
                        content: `Given the following annotation content and metadata, generate:
1. A title (max 60 characters) that summarizes the main theme, includes primary keywords for SEO, and excludes the author name. Pose as a question if the content is questioning.
2. An anchor text (3-7 words) that is concise, keyword-rich, and encourages clicks.
Focus on education-related themes if present.

Content: ${cleanContent}
URL: ${url}
Author: ${author}

Return JSON:
{
  "title": "Why Schools Feel Like Factories: Prussian Roots",
  "anchorText": "Schools as Factories"
}`
                    }
                ],
                max_tokens: 100,
                temperature: 0.7
            },
            {
                headers: {
                    'Authorization': `Bearer xai-HM2nA3pJAgZAaYe6WpDHIIrzpp3SnmpSQOaX2kJ75pHo77P06I1OzgCHycbo2zKOiZJf4OkuEHUWWYAf`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const result = JSON.parse(response.data.choices[0].message.content);
        const metadata = {
            title: result.title || `Annotation on ${new URL(url).hostname}`,
            anchorText: result.anchorText || 'View Annotation'
        };
        // Cache result
        metadataCache.set(cacheKey, metadata);
        setTimeout(() => metadataCache.delete(cacheKey), CACHE_TTL);
        console.log(`[Grok API] Generated metadata for key: ${cacheKey}`, metadata);
        return metadata;
    } catch (error) {
        console.error('[Grok API] Failed to generate metadata:', error);
        return {
            title: `Annotation on ${new URL(url).hostname}`,
            anchorText: 'View Annotation'
        };
    }
}