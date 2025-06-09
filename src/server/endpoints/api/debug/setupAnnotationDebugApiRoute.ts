import {Express, Request, Response} from "express";
import {getShardKey} from "../../../utils/shardUtils.js";
import {Annotation} from "../../../types/types.js";


export function setupAnnotationDebugApiRoute(app: Express, gun: any) {
    app.get('/api/debug/annotations', async (req: Request, res: Response) => {
        const {url, annotationId} = req.query;
        console.log(`[DEBUG] /api/debug/annotations called with url: ${url}, annotationId: ${annotationId}`);

        if (!url || !annotationId) {
            console.log(`[DEBUG] Missing url or annotationId: url=${url}, annotationId=${annotationId}`);
            return res.status(400).json({error: 'Missing url or annotationId parameter'});
        }

        try {
            const {domainShard, subShard} = getShardKey(url as string);
            console.log(`[DEBUG] Sharding: domainShard=${domainShard}, subShard=${subShard}`);
            const annotationNodes = [
                gun.get(domainShard).get(url),
                ...(subShard ? [gun.get(subShard).get(url)] : []),
            ];

            const shardedData = await Promise.all(
                annotationNodes.map((node) =>
                    new Promise((resolve) => {
                        const annotationData: { annotation?: Annotation; comments: any[] } = {comments: []};
                        node.get(annotationId as string).once((annotation: any) => {
                            if (annotation) {
                                annotationData.annotation = {
                                    comments: annotation.comments,
                                    id: annotationId as string,
                                    url: annotation.url,
                                    content: annotation.content,
                                    author: annotation.author,
                                    timestamp: annotation.timestamp,
                                    isDeleted: annotation.isDeleted || false,
                                    screenshot: annotation.screenshot,
                                    metadata: annotation.metadata || {},
                                    title: annotation.title,
                                    anchorText: annotation.anchorText
                                };

                                const comments: any[] = [];
                                const commentIds = new Set();
                                let nodesProcessed = 0;
                                const totalNodes = annotationNodes.length;

                                const timeout = setTimeout(() => {
                                    nodesProcessed = totalNodes;
                                    resolve({annotation: annotationData.annotation, comments});
                                }, 500);

                                node.get(annotationId as string).get('comments').map().once((comment: any, commentId: string) => {
                                    console.log(`[DEBUG] Fetched comment for annotationId: ${annotationId}, commentId: ${commentId}, comment:`, comment);
                                    if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                        commentIds.add(commentId);
                                        comments.push({
                                            id: commentId,
                                            content: comment.content,
                                            author: comment.author,
                                            timestamp: comment.timestamp,
                                            isDeleted: comment.isDeleted || false,
                                        });
                                    }
                                    nodesProcessed++;
                                    if (nodesProcessed === totalNodes) {
                                        clearTimeout(timeout);
                                        resolve({annotation: annotationData.annotation, comments});
                                    }
                                });

                                if (nodesProcessed === 0) {
                                    setTimeout(() => {
                                        if (nodesProcessed === 0) {
                                            clearTimeout(timeout);
                                            resolve({annotation: annotationData.annotation, comments});
                                        }
                                    }, 100);
                                }
                            } else {
                                console.log(`[DEBUG] No annotation found for annotationId: ${annotationId}`);
                                resolve(null);
                            }
                        });
                    })
                )
            );

            console.log(`[DEBUG] Sharded data response:`, shardedData);
            res.json({
                shardedData: shardedData.filter(data => data !== null),
            });
        } catch (error) {
            console.error('[DEBUG] Error in /api/debug/annotations:', error);
            res.status(500).json({error: 'Internal server error'});
        }
    });
}