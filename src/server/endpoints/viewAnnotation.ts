import {Express, Request, Response} from "express";
import {normalizeUrl} from "../utils/normalizeUrl.js";
import {getShardKey} from "../utils/shardUtils.js";
import {Metadata} from "../types/types.js";
import {fetchPageMetadata} from "../utils/fetchPageMetadata.js";
import {stripHtml} from "../utils/stripHtml.js";
import {fromUrlSafeBase64} from "../utils/fromUrlSafeBase64.js";
import {addAnnotationToSitemap} from "../utils/sitemap/addAnnotationsToSitemap.js";
import {publicUrl, websiteUrl} from "../config/index.js";
import {appendUtmParams} from "../utils/appendUtmParams.js";
import {getProfileWithRetries} from "../data/getProfileWithRetries.js";
import {subscribeToNewDomain} from "./setupHomepageRoute.js";

export function setupViewAnnotationRoute(app: Express, gun : any) {
// Update /viewannotation/... to add to sitemap
    app.get('/viewannotation/:annotationId/:base64Url', async (req: Request, res: Response) => {
        console.log(`[DEBUG] /viewannotation called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);
        console.log(`[DEBUG] Request headers:`, req.headers);
        console.log(`[DEBUG] Request query:`, req.query);

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

            let annotation: any = null;
            await Promise.all(
                annotationNodes.map(node =>
                    new Promise<void>((resolve) => {
                        node.get(annotationId).once((data: any) => {
                            console.log(`[DEBUG] Fetched annotation for annotationId: ${annotationId}, data:`, data);
                            if (data && !data.isDeleted) {
                                annotation = data;
                            }
                            resolve();
                        });
                    })
                )
            );

            if (!annotation || !annotation.url) {
                console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}, url: ${cleanUrl}`);
                return res.status(404).send('Annotation not found');
            }

            addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
            subscribeToNewDomain(gun, annotation.url);

            console.log(`[DEBUG] Annotation found:`, annotationId);
            const profile = await getProfileWithRetries(gun, annotation.author);
            console.log(`[DEBUG] Fetched profile for author: ${annotation.author}, profile:`, profile);
            let metadata: Metadata = await fetchPageMetadata(cleanUrl);
            console.log(`[DEBUG] Fetched metadata for url: ${cleanUrl}, metadata:`, metadata);
            const annotationNoHTML = stripHtml(annotation.content);
            const description = annotationNoHTML.length > 160 ? `${annotationNoHTML.slice(0, 157)}...` : annotationNoHTML;
            const title = `Annotation by ${profile.handle} on ${cleanUrl}`;
            const defaultImage = 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png';
            const image = metadata.ogImage
                ? metadata.ogImage
                : annotation.screenshot ? `${publicUrl}/image/${annotationId}/${base64Url}/image.png` : defaultImage;

            const baseCheckExtensionUrl = `${websiteUrl}/check-extension?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
            const baseViewAnnotationsUrl = `${websiteUrl}/view-annotations?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
            const checkExtensionUrl = appendUtmParams(baseCheckExtensionUrl, req.query);
            const viewAnnotationsUrl = appendUtmParams(baseViewAnnotationsUrl, req.query);

            const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta name="description" content="${description}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:url" content="${cleanUrl}">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${image}">
    <link rel="canonical" href="${cleanUrl}">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-YDDS5BJ90C"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-YDDS5BJ90C');
    </script>
</head>
<body>
    <script>
        (function() {
            let redirectHandled = false;
            function redirect(url) {
                console.log('[DEBUG] Redirecting to:', url);
                if (!redirectHandled) {
                    redirectHandled = true;
                    window.location.href = url;
                }
            }

            setTimeout(() => {
                const isChrome = /Chrome/.test(navigator.userAgent) && !/Edg|OPR/.test(navigator.userAgent);
                console.log('[DEBUG] Browser detection: isChrome=', isChrome);
                console.log('Original URL: ${originalUrl}');
                if (isChrome) {
                    redirect('${checkExtensionUrl}');
                } else {
                    redirect('${viewAnnotationsUrl}');
                }
            }, 500);
        })();
    </script>
</body>
</html>
        `;

            console.log(`[DEBUG] Sending HTML response for /viewannotation`);
            res.set('Content-Type', 'text/html');
            res.send(html);
        } catch (error) {
            console.error(`[DEBUG] Error in /viewannotation:`, error);
            res.status(500).send('Internal server error');
        }
    });
}