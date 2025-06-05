import Gun from 'gun';
import http from 'http';
import express, {Express, Response} from 'express';
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
import {setupIndexNowEndpoint} from "./endpoints/setupIndexNowEndPoint.js";
import {setupIndexNowKeyEndpoint} from "./endpoints/setupIndexNowKeyEndpoint.js";
import {setupGenerateMetadataEndpoint} from "./endpoints/setupMetadataEndpoint.js";

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

setupGenerateMetadataEndpoint(app);
setupIndexNowKeyEndpoint(app);
setupIndexNowEndpoint(app);
setupSitemapRoute(app);
setupRebuildSitemapRoute(app, gun);
setupPutHook(gun);
setupAnnotationApi(app, gun);
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