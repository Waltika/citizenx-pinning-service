import {Express, Request, Response} from "express";
import {fromUrlSafeBase64} from "../utils/fromUrlSafeBase64.js";
import {normalizeUrl} from "../utils/normalizeUrl.js";
import {getShardKey} from "../utils/shardUtils.js";
import {addAnnotationToSitemap} from "../utils/sitemap/addAnnotationsToSitemap.js";
import {getProfileWithRetries} from "../data/getProfileWithRetries.js";
import {Metadata} from "../types/types.js";
import {fetchPageMetadata} from "../utils/fetchPageMetadata.js";
import {stripHtml} from "../utils/stripHtml.js";
import {publicUrl, websiteUrl} from "../config/index.js";
import {appendUtmParams} from "../utils/appendUtmParams.js";
import {cacheNewAnnotation, subscribeToNewDomain} from "./setupHomepageRoute.js";

export function setupAnnotationRoute(app: Express, gun: any) {
    app.get('/:annotationId/:base64Url', async (req: Request, res: Response) => {
        console.log(`[DEBUG] /:annotationId/:base64Url called with annotationId: ${req.params.annotationId}, base64Url: ${req.params.base64Url}`);

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

            addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp).then(_r => {
            });
            cacheNewAnnotation(annotation, gun, subShard || domainShard).then(_r => {
            });
            subscribeToNewDomain(gun, annotation.url);

            console.log(`[DEBUG] Annotation found:`, annotationId);
            const profile = await getProfileWithRetries(gun, annotation.author);
            console.log(`[DEBUG] Fetched profile for author: ${annotation.author}, profile:`, profile);
            let metadata: Metadata = await fetchPageMetadata(cleanUrl);
            console.log(`[DEBUG] Fetched metadata for url: ${cleanUrl}, metadata:`, metadata);
            const annotationNoHTML = stripHtml(annotation.content);
            const description = annotationNoHTML.length > 160 ? `${annotationNoHTML.slice(0, 157)}...` : annotationNoHTML;

            // Use title from annotation, fallback to hostname-based title
            const title = annotation.title || `Annotation on ${new URL(cleanUrl).hostname}`;

            const defaultImage = 'https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png';
            const image = annotation.screenshot
                ? `${publicUrl}/image/${annotationId}/${base64Url}/image.png`
                : metadata.ogImage || defaultImage;
            const canonicalUrl = `${publicUrl}/${annotationId}/${base64Url}`;
            const baseViewUrl = `${websiteUrl}/view-annotations?annotationId=${annotationId}&url=${encodeURIComponent(originalUrl)}`;
            const viewUrl = appendUtmParams(baseViewUrl, req.query);

            const keywords = annotationNoHTML
                .split(/\s+/)
                .filter(word => word.length > 3)
                .slice(0, 10)
                .join(', ');

            // Prepare share text (matches client logic)
            const plainContent = annotationNoHTML;
            const truncatedContent = plainContent.trim()
                ? plainContent.length > 100
                    ? plainContent.substring(0, 100) + '...'
                    : plainContent
                : 'No content available';
            const shareText = `Check out this annotation: "${truncatedContent}" by ${profile.handle || 'Unknown'} #CitizenX`;
            const longShareUrl = `${publicUrl}/viewannotation/${annotationId}/${base64Url}`;

            const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta name="description" content="${description}">
    <meta name="keywords" content="${keywords}">
    <meta name="author" content="${profile.handle}">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${description}">
    <meta property="og:image" content="${image}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:type" content="article">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${description}">
    <meta name="twitter:image" content="${image}">
    <link rel="canonical" href="${canonicalUrl}">
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-YDDS5BJ90C"></script>
    <script>
        window.dataLayer = window.dataLayer || [];
        function gtag(){dataLayer.push(arguments);}
        gtag('js', new Date());
        gtag('config', 'G-YDDS5BJ90C');
    </script>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
            background-color: #f5f5f5;
        }
        .header {
            display: flex;
            justify-content: flex-start;
            align-items: center;
            margin-bottom: 20px;
        }
        .back-arrow {
            width: 32px;
            height: 32px;
            fill: #333;
        }
        .annotation-container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
        }
        .annotation-header {
            display: flex;
            align-items: center;
            margin-bottom: 15px;
        }
        .author-img {
            width: 40px;
            height: 40px;
            border-radius: 50%;
            margin-right: 12px;
        }
        .author-name {
            font-weight: bold;
            color: #333;
            font-size: 1.2em;
        }
        .timestamp {
            color: #666;
            font-size: 0.9em;
        }
        .content {
            margin-bottom: 20px;
            color: #444;
            font-size: 16px;
        }
        .screenshot {
            max-width: 100%;
            border-radius: 8px;
            margin-bottom: 20px;
            border: 1px solid #ddd;
        }
        .button-container {
            display: flex;
            gap: 10px;
        }
        .view-link, .share-button {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            height: 32px;
            min-height: 32px;
            padding: 4px 8px;
            background-color: #000000;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            border: none;
            font-family: 'Roboto', Arial, sans-serif;
            font-size: 0.875rem;
            font-weight: 500;
            line-height: 1.75;
            transition: background-color 0.3s ease;
            cursor: pointer;
            touch-action: manipulation; /* Improve touch responsiveness */
        }
        .view-link:hover, .share-button:hover {
            background-color: #393b3c;
        }
        .share-button:disabled {
            background-color: #cccccc;
            cursor: not-allowed;
        }
        .share-icon {
            width: 18px;
            height: 18px;
            margin-right: 4px;
            fill: white;
        }
        .tooltip {
            position: relative;
            display: inline-block;
        }
        .tooltip .tooltiptext {
            visibility: hidden;
            width: 120px;
            background-color: #555;
            color: #fff;
            text-align: center;
            border-radius: 6px;
            padding: 5px;
            position: absolute;
            z-index: 1;
            bottom: 125%;
            left: 50%;
            margin-left: -60px;
            opacity: 0;
            transition: opacity 0.3s;
        }
        .tooltip:hover .tooltiptext {
            visibility: visible;
            opacity: 1;
        }
        #toast {
            position: fixed;
            bottom: 20px;
            right: 20px;
            padding: 10px 20px;
            border-radius: 6px;
            color: white;
            font-size: 14px;
            display: none;
            z-index: 1000;
            aria-live: polite;
        }
        #toast.success {
            background-color: #19571b;
        }
        #toast.error {
            background-color: #f44336;
        }
    </style>
</head>
<body>
    <div class="header">
        <a href="https://service.citizenx.app" title="Back to homepage" aria-label="Back to homepage">
            <svg class="back-arrow" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/>
            </svg>
        </a>
    </div>
    <div class="annotation-container">
        <H1 class="title">${annotation.title || `Annotation by ${profile.handle}`}</H1>
        <div class="annotation-header">
            ${profile.profilePicture ? `<img src="${profile.profilePicture}" alt="${profile.handle || 'User'}" class="author-img">` : ''}
            <div>
                <div class="author-name">${profile.handle || 'Anonymous'}</div>
                <div class="timestamp">${new Date(annotation.timestamp).toLocaleString()}</div>
            </div>
        </div>
        <div class="content">${annotation.content}</div>
        ${image !== defaultImage ? `<img src="${image}" alt="Annotation screenshot" class="screenshot">` : ''}
        <div class="button-container">
            <a href="${viewUrl}" class="view-link">Get the Extension to Annotate</a>
            <div class="tooltip">
                <button id="share-button" class="share-button" title="Share this annotation" aria-label="Share annotation">
                    <svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/>
                    </svg>
                    Share
                </button>
                <span class="tooltiptext">Share this annotation</span>
            </div>
        </div>
    </div>
    <div id="toast"></div>
    <script>
        const shareButton = document.getElementById('share-button');
        const toast = document.getElementById('toast');
        const isMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent);

        function showToast(message, type) {
            toast.textContent = message;
            toast.className = type;
            toast.style.display = 'block';
            setTimeout(() => {
                toast.style.display = 'none';
            }, 3000);
        }

        shareButton.addEventListener('click', async () => {
            shareButton.disabled = true;
            shareButton.textContent = 'Shortening...';
            try {
                const longUrl = '${longShareUrl.replace(/'/g, "\\'")}';
                let shareUrl = longUrl;
                try {
                    const response = await fetch('/api/shorten', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ url: longUrl })
                    });
                    if (!response.ok) { 
                        // noinspection ExceptionCaughtLocallyJS
                        throw new Error('Failed to shorten URL'); 
                    }
                    const data = await response.json();
                    shareUrl = data.shortUrl || longUrl;
                } catch (err) {
                    console.error('Failed to shorten URL:', err);
                    showToast('Failed to shorten URL, using long URL', 'error');
                }

                if (isMobile && navigator.share) {
                    try {
                        await navigator.share({
                            title: '${title.replace(/'/g, "\\'")}',
                            text: '${shareText.replace(/'/g, "\\'")}',
                            url: shareUrl
                        });
                        showToast('Shared successfully!', 'success');
                    } catch (shareErr) {
                        console.error('Failed to share on mobile:', shareErr);
                        showToast('Sharing failed, copying to clipboard', 'error');
                        await navigator.clipboard.writeText(shareUrl);
                        showToast('Link copied to clipboard!', 'success');
                    }
                } else {
                    await navigator.clipboard.writeText(shareUrl);
                    showToast('Link copied to clipboard!', 'success');
                }
            } catch (err) {
                console.error('Failed to copy share link:', err);
                showToast('Failed to copy link', 'error');
            } finally {
                shareButton.disabled = false;
                shareButton.innerHTML = '<svg class="share-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z"/></svg> Share';
            }
        });
    </script>
</body>
</html>
`;

            console.log(`[DEBUG] Sending HTML response for /${annotationId}/${base64Url}`);
            res.set('Content-Type', 'text/html');
            res.send(html);
        } catch (error) {
            console.error(`[ERROR] Error in /${annotationId}/${base64Url}:`, error);
            res.status(500).send('Internal server error');
        }
    });
}