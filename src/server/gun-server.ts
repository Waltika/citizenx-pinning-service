import Gun from 'gun';
import http from 'http';
import express, {Express, Response} from 'express';
import cors from 'cors';
import fs from 'fs';
import {limiter} from './utils/rateLimit.js';
import {setupAnnotationDebugApiRoute} from "./endpoints/api/debug/setupAnnotationDebugApiRoute.js";
import {baseDataDir, dataDir, initialPeers, publicUrl} from './config/index.js';
import {setupViewAnnotationRoute} from "./endpoints/setupViewAnnotationRoute.js";
import {bootstrapSiteMapIfNotExist} from "./utils/bootstrapSitemap.js";
import {setupSitemapRoute} from "./endpoints/api/SEO/setupSitemapRoute.js";
import {setupRebuildSitemapRoute} from "./endpoints/api/SEO/setupRebuildSitemapRoute.js";
import {setupAnnotationRoute} from "./endpoints/setupAnnotationRoute.js";
import {setupImageRoute} from "./endpoints/setupImageRoute.js";
import {setupAnnotationApiRoute} from "./endpoints/api/setupAnnotationApiRoute.js";
import {setupPageMetadataEndpoint} from "./endpoints/api/setupPageMetadataEndpoint.js";
import {setupHomepageRoute} from "./endpoints/setupHomepageRoute.js";
import {setupPutHook} from "./data/setupPutHook.js";
import {setupIndexNowEndpoint} from "./endpoints/api/SEO/setupIndexNowEndPoint.js";
import {setupIndexNowKeyEndpoint} from "./endpoints/api/SEO/setupIndexNowKeyEndpoint.js";
import {setupGenerateMetadataEndpoint} from "./endpoints/api/setupGenerateMetadataEndpoint.js";
import {setupYandexIconRoute} from "./endpoints/api/SEO/setupYandexIconRoute.js";
import {setupShortenRoute} from "./endpoints/api/setupShortenRoute.js";

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

await bootstrapSiteMapIfNotExist(gun);

setupShortenRoute(app);
setupYandexIconRoute(app);
setupGenerateMetadataEndpoint(app);
setupIndexNowKeyEndpoint(app);
setupIndexNowEndpoint(app);
setupSitemapRoute(app);
setupRebuildSitemapRoute(app, gun);
setupPutHook(gun);
setupAnnotationApiRoute(app, gun);
setupPageMetadataEndpoint(app, gun);
setupImageRoute(app, gun);
setupAnnotationRoute(app, gun);
setupViewAnnotationRoute(app, gun);
setupAnnotationDebugApiRoute(app, gun);
setupHomepageRoute(app, gun);

app.get('/health', (_req: any, res: Response) => res.status(200).json({status: 'ok'}));

console.log(`Gun server running on port ${port}`);
console.log(`Public URL: ${publicUrl}/gun`);
console.log(`Initial peers: ${initialPeers.join(', ')}`);