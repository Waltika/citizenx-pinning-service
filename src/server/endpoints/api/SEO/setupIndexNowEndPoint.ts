import {limiter} from "../../../utils/rateLimit.js";
import {Express, Request, Response} from "express";
import {indexNowQueue, submitIndexNowUrls} from "../../../utils/sitemap/indexnow.js";

export function setupIndexNowEndpoint(app: Express) {
// Manual IndexNow submission endpoint (optional)
    app.post('/api/indexnow', limiter, async (_req: Request, res: Response) => {
        try {
            await submitIndexNowUrls();
            res.status(200).json({message: 'IndexNow submission triggered', queueSize: indexNowQueue.size});
        } catch (error) {
            console.error('[IndexNow] Manual submission failed:', error);
            res.status(500).json({error: 'Failed to submit URLs to IndexNow'});
        }
    });
}