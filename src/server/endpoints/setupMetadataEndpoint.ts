import { Express, Request, Response } from 'express';
import { generateMetadata } from '../utils/grokUtils.js';
import { limiter } from '../utils/rateLimit.js';

export function setupGenerateMetadataEndpoint(app: Express) {
    app.post('/api/generate-metadata', limiter, async (req: Request, res: Response) => {
        const { content, url} = req.body;
        if (!content || !url) {
            console.log(`[Generate Metadata] Missing parameters: content=${!!content}, url=${!!url}`);
            return res.status(400).json({ error: 'Missing content, url, or author' });
        }

        try {
            const metadata = await generateMetadata(content, url);
            console.log(`[Generate Metadata] Generated metadata for ${url}:`, metadata);
            res.status(200).json(metadata);
        } catch (error) {
            console.error(`[Generate Metadata] Error generating metadata for ${url}:`, error);
            res.status(500).json({ error: 'Failed to generate metadata' });
        }
    });
}