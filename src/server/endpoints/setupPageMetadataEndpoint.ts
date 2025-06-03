import {Express, Request, Response} from "express";
import {Metadata} from "../types/types.js";
import {fetchPageMetadata} from "../utils/fetchPageMetadata.js";
import {normalizeUrl} from "../utils/normalizeUrl.js";
import {getShardKey} from "../utils/shardUtils.js";
import {addAnnotationToSitemap} from "../utils/sitemap/addAnnotationsToSitemap.js";

export function setupPageMetadataEndpoint(app: Express, gun: any) {
// Update /api/page-metadata to add to sitemap
    app.get('/api/page-metadata', async (req: Request, res: Response) => {
        const {url} = req.query;
        if (!url || typeof url !== 'string') {
            return res.status(400).json({error: 'Invalid URL'});
        }

        try {
            const metadata: Metadata = await fetchPageMetadata(url);
            const cleanUrl = normalizeUrl(new URL(url).href);
            const {domainShard, subShard} = getShardKey(cleanUrl);
            const annotationNodes = [
                gun.get(domainShard).get(cleanUrl),
                ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
            ];

            await Promise.all(
                annotationNodes.map(node =>
                    new Promise<void>((resolve) => {
                        node.map().once((annotation: any) => {
                            if (annotation && !annotation.isDeleted && annotation.id && annotation.url && annotation.timestamp) {
                                addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
                            }
                        });
                        setTimeout(resolve, 1000);
                    })
                )
            );

            res.json(metadata);
        } catch (error) {
            console.error('Error fetching metadata:', error);
            res.status(500).json({error: 'Failed to fetch metadata'});
        }
    });
}