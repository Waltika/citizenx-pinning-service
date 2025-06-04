import Gun from 'gun';
import http from 'http';
import express, {Request, Response, Express} from 'express';
import cors from 'cors';
import fs from 'fs';
import {limiter} from './utils/rateLimit.js';
import {setupAnnotationDebugApiRoute} from "./endpoints/api/debug/annotations.js";
import {baseDataDir, dataDir, initialPeers, publicUrl} from './config/index.js';
import {setupViewAnnotationRoute} from "./endpoints/viewAnnotation.js";
import {bootstrapSiteMapIfNotExist} from "./utils/bootstrapSitemap.js";
import {setupSitemapRoute} from "./endpoints/sitemap.js";
import {setupRebuildSitemapRoute} from "./endpoints/setupRebuildSitemapRoute.js";
import {setupAnnotationRoute} from "./endpoints/setupAnnoationRoute.js";
import {setupImageRoute} from "./endpoints/setupImageRoute.js";
import {setupAnnotationApi} from "./endpoints/api/setupAnnotationApi.js";
import {setupPageMetadataEndpoint} from "./endpoints/setupPageMetadataEndpoint.js";
import {setupHomepageRoute} from "./endpoints/setupHomepageRoute.js";
import {setupPutHook} from "./data/setupPutHook.js";
import {setupOnHook} from "./data/setupOnHook.js";
import {getIndexNowKey, indexNowQueue, submitIndexNowUrls} from "./utils/sitemap/indexnow.js";

const port: number = parseInt(process.env.PORT || '10000', 10);

const app: Express = express();

app.use(limiter);
app.use(express.json());
app.use(cors({
    origin: [
        'https://citizenx.app',
        'chrome-extension://mbmlbbmhjhcmmpbieofegoefkhnbjmbj',
        'chrome-extension://klblcgbgljcpamgpmdccefaalnhndjap',
    ],
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
    optionsSuccessStatus: 200,
}));

const server: http.Server = http.createServer(app).listen(port, () => {
    console.log(`Gun server running on port ${port}`);
});

try {
    if (!fs.existsSync(baseDataDir)) {
        fs.mkdirSync(baseDataDir, {recursive: true});
        console.log('Created base data directory:', baseDataDir);
    }
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, {recursive: true});
        console.log('Created data directory:', dataDir);
    }
} catch (error) {
    console.error('Failed to create data directories:', {baseDataDir, dataDir}, error);
    console.warn('Data persistence may not work without a persistent disk.');
}

const gun: any = (Gun as any)({
    web: server,
    peers: initialPeers,
    file: dataDir,
    radisk: true,
    batch: false,
});

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

// Manual IndexNow submission endpoint (optional)
app.post('/api/indexnow', limiter, async (_req: Request, res: Response) => {
    try {
        await submitIndexNowUrls();
        res.status(200).json({ message: 'IndexNow submission triggered', queueSize: indexNowQueue.size });
    } catch (error) {
        console.error('[IndexNow] Manual submission failed:', error);
        res.status(500).json({ error: 'Failed to submit URLs to IndexNow' });
    }
});

bootstrapSiteMapIfNotExist(gun);
setupSitemapRoute(app);
setupRebuildSitemapRoute(app, gun);
setupOnHook(gun);
setupPutHook(gun);
setupHomepageRoute(app);
setupAnnotationApi(app, gun);
setupPageMetadataEndpoint(app, gun);
setupImageRoute(app, gun);
setupAnnotationRoute(app, gun);
setupViewAnnotationRoute(app, gun);
setupAnnotationDebugApiRoute(app, gun);

app.get('/health', (_req: any, res: Response) => res.status(200).json({status: 'ok'}));

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.join(', ')}`);