import {Express, Request, Response} from 'express';
import axios from 'axios';
import DOMPurify from 'dompurify';
import {JSDOM} from 'jsdom';

// Setup DOMPurify with JSDOM for sanitization
const window: any = new JSDOM('').window;
const purify = DOMPurify(window);

// Load Grok API key from secure storage
let grokApiKey: string = process.env.GROK_KEY || '';

export function setupFallacyAnalysisRoute(app: Express, gun: any): void {
    app.post('/api/analyze-fallacies', async (req: Request, res: Response) => {
        const {text} = req.body;

        // Input validation
        if (!text || typeof text !== 'string') {
            console.error('Invalid text input for fallacy analysis', {text});
            return res.status(400).json({error: 'Text is required and must be a string'});
        }

        try {
            // Sanitize input text and limit to 1000 characters
            const sanitizedText = purify.sanitize(text).substring(0, 1000);
            console.log(`Sanitized text: ${sanitizedText}`);

            // Validate API key
            if (!grokApiKey) {
                console.error('Grok API key is not set');
                return res.status(500).json({error: 'API key not configured'});
            }

            // Call Grok API for logical fallacy analysis
            console.log('Making Grok API request...');
            const response = await axios.post(
                'https://api.x.ai/v1/chat/completions',
                {
                    model: 'grok-3',
                    messages: [
                        {
                            role: 'user',
                            content: `Analyze the following text for logical fallacies and return a JSON object with:
- fallacies: An array of objects, each containing:
  - type: The type of fallacy (e.g., "Ad Hominem", "Strawman").
  - description: A brief explanation of the fallacy.
  - excerpt: The specific text segment where the fallacy occurs.
  - severity: A score from 1 (minor) to 5 (severe).
- summary: A concise summary of the analysis.
- confidence: A score from 0 to 1 indicating confidence in the analysis.
Provide clear explanations for each fallacy to educate the user.

Text: ${sanitizedText}

Return JSON:
{
  "fallacies": [
    {
      "type": "Ad Hominem",
      "description": "Attacking the person instead of their argument.",
      "excerpt": "The author is just a biased journalist.",
      "severity": 3
    }
  ],
  "summary": "The text contains an ad hominem fallacy.",
  "confidence": 0.9
}`
                        }
                    ],
                    max_tokens: 300,
                    temperature: 0.7
                },
                {
                    headers: {
                        Authorization: `Bearer ${grokApiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 10000, // 10-second timeout
                }
            );

            const analysis = JSON.parse(response.data.choices[0].message.content);
            console.log(`Analysis data: ${JSON.stringify(analysis, null, 2)}`);

            // Validate analysis response
            if (!analysis.fallacies || !Array.isArray(analysis.fallacies) || !analysis.summary || typeof analysis.confidence !== 'number') {
                console.error('Invalid Grok API response format', {response: analysis});
                return res.status(500).json({error: 'Invalid response from analysis service'});
            }

            console.log(`Analysis details - fallacies: ${JSON.stringify(analysis.fallacies)}, summary: ${analysis.summary}, confidence: ${analysis.confidence}`);

            // Return analysis to client
            res.json({
                fallacies: analysis.fallacies,
                summary: analysis.summary,
                confidence: analysis.confidence,
            });
        } catch (error: any) {
            console.error('Error analyzing logical fallacies', {
                message: error.message,
                code: error.code,
                response: error.response ? {
                    status: error.response.status,
                    data: error.response.data,
                    headers: error.response.headers,
                } : null,
                request: {
                    url: error.config?.url,
                    method: error.config?.method,
                    headers: error.config?.headers,
                    data: error.config?.data,
                },
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