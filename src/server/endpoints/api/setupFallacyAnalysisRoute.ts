import {Express, Request, Response} from 'express';
import axios from 'axios';
import DOMPurify from 'dompurify';
import {JSDOM} from 'jsdom';
import {v4 as uuidv4} from 'uuid';

// Setup DOMPurify with JSDOM for sanitization
const window: any = new JSDOM('').window;
const purify = DOMPurify(window);

// Load Grok API key from secure storage
let grokApiKey: string = process.env.GROK_KEY || '';

export function setupFallacyAnalysisRoute(app: Express, gun: any): void {
    app.post('/api/analyze-fallacies', async (req: Request, res: Response) => {
        const {text, annotationId, url} = req.body;

        // Input validation
        if (!text || typeof text !== 'string') {
            console.error('Invalid text input for fallacy analysis', {annotationId, url});
            return res.status(400).json({error: 'Text is required and must be a string'});
        }

        try {
            // Sanitize input text
            const sanitizedText = purify.sanitize(text);

            // Call Grok API for logical fallacy analysis
            const response = await axios.post(
                'https://api.x.ai/v1/grok/analyze',
                {
                    text: sanitizedText,
                    task: 'identify_logical_fallacies',
                    instructions: `
                        Analyze the provided text for logical fallacies. Return a JSON object with:
                        - fallacies: An array of objects, each containing:
                          - type: The type of fallacy (e.g., "Ad Hominem", "Strawman").
                          - description: A brief explanation of the fallacy.
                          - excerpt: The specific text segment where the fallacy occurs.
                          - severity: A score from 1 (minor) to 5 (severe).
                        - summary: A concise summary of the analysis.
                        - confidence: A score from 0 to 1 indicating confidence in the analysis.
                        Provide explanations for each fallacy to educate the user.
                    `,
                },
                {
                    headers: {
                        Authorization: `Bearer ${grokApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000, // 10-second timeout
                }
            );

            const analysis = response.data;

            // Validate analysis response
            if (!analysis.fallacies || !Array.isArray(analysis.fallacies) || !analysis.summary || typeof analysis.confidence !== 'number') {
                console.error('Invalid Grok API response format', {response: analysis});
                return res.status(500).json({error: 'Invalid response from analysis service'});
            }

            // Store analysis in Gun.js if annotationId and url are provided
            if (annotationId && url) {
                const sanitizedUrl = purify.sanitize(url);
                let domain: string;
                try {
                    domain = new URL(sanitizedUrl).hostname.replace(/\./g, '_');
                } catch (error: any) {
                    console.error('Invalid URL format', {url: sanitizedUrl, error: error.message});
                    return res.status(400).json({error: 'Invalid URL format'});
                }

                const fallacyNode = `annotations_${domain}/${sanitizedUrl}/${annotationId}/fallacies`;

                // Store fallacy analysis with timestamp and unique ID
                const fallacyData = {
                    id: uuidv4(),
                    fallacies: analysis.fallacies,
                    summary: analysis.summary,
                    confidence: analysis.confidence,
                    timestamp: new Date().toISOString(),
                    isDeleted: false,
                };

                gun.get(fallacyNode).put(fallacyData, (ack: any) => {
                    if (ack.err) {
                        console.error('Failed to store fallacy analysis in Gun.js', {error: ack.err, fallacyNode});
                    } else {
                        console.info('Stored fallacy analysis in Gun.js', {fallacyNode, annotationId});
                    }
                });
            }

            // Return analysis to client
            res.json({
                fallacies: analysis.fallacies,
                summary: analysis.summary,
                confidence: analysis.confidence,
            });
        } catch (error: any) {
            console.error('Error analyzing logical fallacies', {
                error: error.message,
                annotationId,
                url,
            });

            if (error.response) {
                // Handle API-specific errors
                res.status(error.response.status).json({
                    error: 'Analysis service error',
                    details: error.response.data,
                });
            } else if (error.code === 'ECONNABORTED') {
                // Handle timeout
                res.status(504).json({error: 'Analysis request timed out'});
            } else {
                // Handle other errors
                res.status(500).json({error: 'Internal server error'});
            }
        }
    });
}