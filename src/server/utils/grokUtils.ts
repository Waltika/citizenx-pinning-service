import axios from 'axios';
import {stripHtml} from './stripHtml.js';

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

let grokApiKey: string = process.env.GROK_KEY || '';

export async function generateMetadata(content: string, url: string): Promise<{ title: string, anchorText: string }> {
    const cleanContent = stripHtml(content).substring(0, 1000); // Limit content size
    try {
        const response = await axios.post(
            'https://api.x.ai/v1/chat/completions',
            {
                model: 'grok-3',
                messages: [
                    {
                        role: 'user',
                        content: `Given the following annotation content and URL, generate:
1. A title (max 60 characters) that summarizes the main theme, includes primary keywords for SEO, and excludes the author name. Pose as a question if the content is questioning.
2. An anchor text (3-7 words) that is concise, keyword-rich, and encourages clicks.
Focus on education-related themes if present.

Content: ${cleanContent}
URL: ${url}

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
                    'Authorization': `Bearer ${grokApiKey}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        const result = JSON.parse(response.data.choices[0].message.content);
        const metadata = {
            title: result.title || `Annotation on ${new URL(url).hostname}`,
            anchorText: result.anchorText || 'View Annotation'
        };
        console.log(`[Grok API] Generated metadata for content: ${cleanContent}`, metadata);
        return metadata;
    } catch (error) {
        console.error('[Grok API] Failed to generate metadata:', error);
        return {
            title: `Annotation on ${new URL(url).hostname}`,
            anchorText: 'View Annotation'
        };
    }
}