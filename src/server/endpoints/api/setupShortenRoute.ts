import {Express, Request, Response} from "express";
import axios from "axios";
import {baseDataDir} from "../../config/index.js";
import fs from "fs";

let shortIoApiKey: string = process.env.SHORT_IO_API_KEY || '';
const shortKeyPath: string = `${baseDataDir}/short.key`;
try {
    if (!shortIoApiKey && fs.existsSync(shortKeyPath)) {
        shortIoApiKey = fs.readFileSync(shortKeyPath, 'utf8').trim();
        console.log('Successfully read Short.io API key from', shortKeyPath);
    }
} catch (error) {
    console.error('Failed to read Short.io API key from', shortKeyPath, ':', error);
}

export function setupShortenRoute(app: Express) {
    app.post('/api/shorten', async (req: Request, res: Response) => {
        const {url} = req.body;

        console.log(`[DEBUG] /api/shorten called with url: ${url}`);

        if (!url) {
            console.log('[DEBUG] Missing url parameter');
            return res.status(400).json({error: 'Missing url parameter'});
        }

        try {
            const response = await axios.post(
                'https://api.short.io/links',
                {
                    originalURL: url,
                    domain: 'citizx.im',
                },
                {
                    headers: {
                        Authorization: shortIoApiKey,
                        'Content-Type': 'application/json',
                    },
                }
            );

            const shortUrl: string = response.data.shortURL;
            console.log(`[DEBUG] Successfully shortened URL: ${url} to ${shortUrl}`);
            res.json({shortUrl});
        } catch (error: any) {
            console.error('[DEBUG] Error shortening URL:', error.response?.data || error.message);
            res.status(500).json({error: 'Failed to shorten URL'});
        }
    });
}