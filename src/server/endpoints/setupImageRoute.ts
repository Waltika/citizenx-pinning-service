import {Express, Request, Response} from "express";
import {fromUrlSafeBase64} from "../utils/fromUrlSafeBase64.js";
import {normalizeUrl} from "../utils/normalizeUrl.js";
import {getShardKey} from "../utils/shardUtils.js";
import {Annotation} from "../types/types.js";
import {addAnnotationToSitemap} from "../utils/sitemap/addAnnotationsToSitemap.js";
import sharp from "sharp";
import {subscribeToNewDomain} from "./setupHomepageRoute.js";

export function setupImageRoute(app: Express, gun: any) {
// Update /image/... to add to sitemap
    app.get('/image/:annotationId/:base64Url/image.png', async (req: Request, res: Response) => {
        console.log(`[DEBUG] /image called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);

        const {annotationId, base64Url} = req.params;

        if (!annotationId || !base64Url) {
            console.log(`[DEBUG] Missing parameters: annotationId=${annotationId}, base64Url=${base64Url}`);
            return res.status(400).send('Missing annotationId or base64Url');
        }

        let originalUrl: string;
        try {
            const standardBase64 = fromUrlSafeBase64(base64Url);
            console.log(`[DEBUG] Converted URL-safe Base64 to standard Base64: ${standardBase64}`);
            originalUrl = Buffer.from(standardBase64, 'base64').toString('utf8');
            console.log(`[DEBUG] Decoded base64Url to originalUrl: ${originalUrl}`);
            new URL(originalUrl);
        } catch (error) {
            console.error(`[DEBUG] Invalid base64Url: ${base64Url}, error:`, error);
            return res.status(400).send('Invalid base64Url');
        }

        try {
            const cleanUrl = normalizeUrl(new URL(originalUrl).href);
            console.log(`[DEBUG] Cleaned URL: ${cleanUrl}`);
            const {domainShard, subShard} = getShardKey(cleanUrl);
            console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
            const annotationNodes = [
                gun.get(domainShard).get(cleanUrl),
                ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
            ];

            const annotations = await Promise.all(
                annotationNodes.map(node =>
                    new Promise<Annotation | null>((resolve) => {
                        node.get(annotationId).once((data: any) => {
                            if (data && !data.isDeleted && typeof data.screenshot === 'string') {
                                resolve(data as Annotation);
                            } else {
                                resolve(null);
                            }
                        });
                    })
                )
            );

            const annotation = annotations.find(a => a !== null) || null;

            if (!annotation || !annotation.screenshot || !annotation.url) {
                console.log(`[DEBUG] No annotation or screenshot found for annotationId: ${annotationId}, url: ${cleanUrl}`);
                return res.status(404).send('Annotation or screenshot not found');
            }

            addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
            subscribeToNewDomain(gun, annotation.url);

            console.log(`[DEBUG] Annotation screenshot found, length: ${annotation.screenshot.length}`);
            const base64Match = annotation.screenshot.match(/^data:image\/(png|jpeg);base64,(.+)$/);
            if (!base64Match) {
                console.log(`[DEBUG] Invalid Base64 image format for annotationId: ${annotationId}`);
                return res.status(400).send('Invalid screenshot format');
            }

            const imageBuffer = Buffer.from(base64Match[2], 'base64');
            console.log(`[DEBUG] Decoded image buffer, size: ${imageBuffer.length} bytes`);

            const targetAspectRatio = 1.91;
            const targetWidth = 1200;
            const targetHeight = 630;

            try {
                const metadata = await sharp(imageBuffer).metadata();
                const width = metadata.width || targetWidth;
                const height = metadata.height || targetHeight;
                console.log(`[DEBUG] Original image dimensions: ${width}x${height}`);

                const currentAspectRatio = width / height;

                let left: number, top: number, cropWidth: number, cropHeight: number;

                if (currentAspectRatio > targetAspectRatio) {
                    cropHeight = height;
                    cropWidth = Math.floor(height * targetAspectRatio);
                    left = Math.floor((width - cropWidth) / 2);
                    top = 0;
                } else {
                    cropWidth = width;
                    cropHeight = Math.floor(width / targetAspectRatio);
                    left = 0;
                    top = 0;
                }

                console.log(`[DEBUG] Cropping to ${cropWidth}x${cropHeight} at (${left}, ${top})`);

                const processedBuffer = await sharp(imageBuffer)
                    .extract({left, top, width: cropWidth, height: cropHeight})
                    .resize({width: targetWidth, height: targetHeight, fit: 'fill'})
                    .toFormat("png")
                    .toBuffer();

                res.set('Content-Type', `image/${base64Match[1]}`);
                res.send(processedBuffer);
                console.log(`[DEBUG] Processed image sent, size: ${processedBuffer.length} bytes`);
            } catch (sharpError) {
                console.error(`[DEBUG] Error processing image with sharp:`, sharpError);
                res.set('Content-Type', `image/${base64Match[1]}`);
                res.send(imageBuffer);
            }
        } catch (error) {
            console.error(`[DEBUG] Error in /image:`, error);
            res.status(500).send('Internal server error');
        }
    });
}