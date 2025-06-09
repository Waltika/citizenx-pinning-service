import {Express, Request, Response} from "express";
import {getIndexNowKey} from "../../../utils/sitemap/indexnow.js";

export function setupIndexNowKeyEndpoint(app : Express) {
// Serve IndexNow key file
    app.get('/:key.txt', (req: Request, res: Response) => {
        const key = getIndexNowKey();
        if (req.params.key === key) {
            res.set('Content-Type', 'text/plain');
            res.send(key);
        } else {
            res.status(404).send('Key not found');
        }
    });
}