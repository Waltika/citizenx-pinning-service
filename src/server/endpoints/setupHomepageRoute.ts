import {Express, Request, Response} from "express";
import {sitemapUrls} from "../utils/sitemap/addAnnotationsToSitemap.js";
import {appendUtmParams} from "../utils/appendUtmParams.js";

export function setupHomepageRoute(app: Express) {
// Homepage route
    app.get('/', (req: Request, res: Response) => {
        const recentAnnotations = Array.from(sitemapUrls)
            .sort((a, b) => b.timestamp - a.timestamp)
            .map(entry => {
                console.log(`Listing annotation: ${entry.url}`);
                const viewUrl = appendUtmParams(entry.url, req.query);
                // Format timestamp as human-readable date (e.g., "May 29, 2025, 5:23 PM")
                const timestampText = new Date(entry.timestamp).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                });
                return `<li><a href="${viewUrl}" class="annotation-link">Annotation from ${timestampText}</a></li>`;
            })
            .filter(Boolean)
            .join('');

        const ctaUrl = appendUtmParams('https://citizenx.app', req.query);
        const logoUrl = appendUtmParams('https://service.citizenx.app', req.query);

        const html = `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>CitizenX Annotations - Service</title>
    <meta name="description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation and annotate the web.">
    <link rel="canonical" href="https://service.citizenx.app">
    <link rel="icon" type="image/png" href="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png">
    <meta property="og:title" content="CitizenX Annotations - Service">
    <meta property="og:description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation.">
    <meta property="og:image" content="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png">
    <meta property="og:url" content="https://service.citizenx.app">
    <meta property="og:type" content="website">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="CitizenX Annotations - Service">
    <meta name="twitter:description" content="Explore web annotations created with CitizenX. Visit citizenx.app to join the conversation.">
    <meta name="twitter:image" content="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/680f776940da22ef40402db5_Screenshot%202025-04-28%20at%2014.40.29.png">
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
            margin: 0;
            padding: 20px;
            line-height: 1.6;
            background-color: #f5f5f5;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            min-height: 100vh;
        }
        .container {
            background: white;
            border-radius: 8px;
            padding: 20px;
            box-shadow: 0 2px 6px rgba(0,0,0,0.1);
            max-width: 800px;
            width: 100%;
            box-sizing: border-box;
            text-align: center;
        }
        .header {
            display: flex;
            justify-content: flex-start;
            align-items: center;
            margin-bottom: 20px;
        }
        .logo {
            width: 32px;
            height: 32px;
        }
        h1 {
            color: #333;
            font-size: 1.8rem;
        }
        p {
            color: #444;
            font-size: 1rem;
        }
        .cta {
            display: inline-block;
            padding: 10px 20px;
            background-color: #000000;
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 500;
            transition: background-color 0.3s ease;
        }
        .cta:hover {
            background-color: #393b3c;
        }
        .annotations {
            text-align: left;
            margin-top: 20px;
        }
        .annotations h2 {
            color: #333;
            font-size: 1.4rem;
            margin-bottom: 10px;
        }
        .annotations ul {
            list-style: none;
            padding: 0;
        }
        .annotations li {
            margin-bottom: 8px;
        }
        .annotation-link {
            color: #7593f4;
            text-decoration: none;
            display: inline-block;
            max-width: 100%;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .annotation-link:hover {
            text-decoration: underline;
        }
        /* Responsive adjustments */
        @media (max-width: 600px) {
            body {
                padding: 10px;
            }
            .container {
                padding: 15px;
            }
            h1 {
                font-size: 1.5rem;
            }
            .annotations h2 {
                font-size: 1.2rem;
            }
            p, .annotation-link {
                font-size: 0.9rem;
            }
            .cta {
                padding: 8px 16px;
                font-size: 0.9rem;
            }
        }
        @media (min-width: 601px) {
            .container {
                margin: 0 auto;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <a href="${logoUrl}">
                <img src="https://cdn.prod.website-files.com/680f69f3e9fbaac421f2d022/68108692c71e654b6795ed9b_icon32.png" alt="CitizenX Logo" class="logo">
            </a>
        </div>
        <h1>CitizenX Annotations</h1>
        <p>This service hosts web annotations created with CitizenX, a platform for collaborative web commentary.</p>
        <p><a href="${ctaUrl}" class="cta">Visit CitizenX to Start Annotating</a></p>
        <p>Explore existing annotations via our <a href="/sitemap.xml">sitemap</a>.</p>
        ${recentAnnotations ? `
        <div class="annotations">
            <h2>Recent Annotations</h2>
            <ul>${recentAnnotations}</ul>
        </div>` : ''}
    </div>
</body>
</html>
    `;
        res.set('Content-Type', 'text/html');
        res.send(html);
    });
}