import {Express, Request, Response} from "express";
import {clearProfileCache, getProfileWithRetries} from "../../data/getProfileWithRetries.js";
import {normalizeUrl} from "../../utils/normalizeUrl.js";
import {getShardKey} from "../../utils/shardUtils.js";
import {Annotation, Metadata} from "../../types/types.js";
import {addAnnotationToSitemap} from "../../utils/sitemap/addAnnotationsToSitemap.js";
import {fetchPageMetadata} from "../../utils/fetchPageMetadata.js";
import {throttleLog} from "../../utils/throttleLog.js";
import {cacheNewAnnotation, subscribeToNewDomain} from "../setupHomepageRoute.js";


// Annotation cache with expiration
const annotationCache = new Map<string, number>();
const ANNOTATION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes in milliseconds

export function setupAnnotationApi(app: Express, gun: any) {
// Update /api/annotations to add to sitemap
    app.get('/api/annotations', async (req: Request, res: Response) => {
        const totalStartTime = Date.now();
        const url = req.query.url as string | undefined;
        const annotationId = req.query.annotationId as string | undefined;

        if (!url) {
            console.log(`[Timing] Request failed: Missing url parameter`);
            return res.status(400).json({error: 'Missing url parameter'});
        }

        try {
            const cacheClearStart = Date.now();
            clearProfileCache();
            annotationCache.clear();
            const cacheClearEnd = Date.now();
            if (throttleLog('cache_clear', 3600000)) {
                console.log(`[Timing] Cleared caches in ${cacheClearEnd - cacheClearStart}ms`);
            }

            const cleanUrl = normalizeUrl(new URL(url).href);
            const {domainShard, subShard} = getShardKey(cleanUrl);
            const annotationNodes = [
                gun.get(domainShard).get(cleanUrl),
                ...(subShard ? [gun.get(subShard).get(cleanUrl)] : []),
            ];

            const annotations: Annotation[] = [];
            const loadedAnnotations = new Set<string>();
            const maxWaitTime = 5000;

            await new Promise<void>((resolve) => {
                const onAnnotation = (annotation: any) => {
                    if (!annotation || !annotation.id || !annotation.url || !annotation.content || !annotation.author || !annotation.timestamp) {
                        return;
                    }
                    const cacheKey = `${cleanUrl}:${annotation.id}`;
                    if (loadedAnnotations.has(annotation.id) || annotationCache.has(cacheKey)) {
                        return;
                    }
                    if (annotation.isDeleted) {
                        return;
                    }
                    loadedAnnotations.add(annotation.id);
                    annotationCache.set(cacheKey, Date.now());
                    setTimeout(() => annotationCache.delete(cacheKey), ANNOTATION_CACHE_TTL);
                    annotations.push({
                        comments: annotation.comments,
                        id: annotation.id,
                        url: annotation.url,
                        content: annotation.content,
                        author: annotation.author,
                        timestamp: annotation.timestamp,
                        screenshot: annotation.screenshot,
                        metadata: annotation.metadata || {},
                        isDeleted: annotation.isDeleted || false,
                        title: annotation.title,
                        anchorText: annotation.anchorText
                    });
                    addAnnotationToSitemap(annotation.id, annotation.url, annotation.timestamp);
                    cacheNewAnnotation(annotation, gun, subShard || domainShard);
                    subscribeToNewDomain(gun, annotation.url);
                };

                annotationNodes.forEach(node => {
                    node.map().on(onAnnotation, {change: true, filter: {isDeleted: false}});
                });

                setTimeout(() => {
                    annotationNodes.forEach(node => node.map().off());
                    resolve();
                }, maxWaitTime);
            });

            if (!annotations.length) {
                return res.status(404).json({error: 'No annotations found for this URL'});
            }

            annotations.sort((a, b) => b.timestamp - a.timestamp);

            const annotationsWithDetails = await Promise.all(
                annotations.map(async (annotation) => {
                    const profile = await getProfileWithRetries(gun, annotation.author);
                    const commentsData = await Promise.all(
                        annotationNodes.map((node) =>
                            new Promise<any[]>((resolve) => {
                                const commentList: any[] = [];
                                const commentIds = new Set<string>();
                                node.get(annotationId || annotation.id).get('comments').map().once((comment: any, commentId: string) => {
                                    if (comment && comment.id && comment.author && comment.content && !commentIds.has(commentId)) {
                                        commentIds.add(commentId);
                                        commentList.push({
                                            id: commentId,
                                            content: comment.content,
                                            author: comment.author,
                                            timestamp: comment.timestamp,
                                            isDeleted: comment.isDeleted || false,
                                        });
                                    }
                                });
                                setTimeout(() => resolve(commentList), 500);
                            })
                        )
                    );

                    const flattenedComments: any[] = [];
                    const seenCommentIds = new Set<string>();
                    for (const commentList of commentsData) {
                        for (const comment of commentList) {
                            if (!seenCommentIds.has(comment.id)) {
                                seenCommentIds.add(comment.id);
                                flattenedComments.push(comment);
                            }
                        }
                    }

                    const resolvedComments: any[] = [];
                    const resolvedCommentIds = new Set<string>();
                    for (const comment of flattenedComments) {
                        if (!resolvedCommentIds.has(comment.id)) {
                            resolvedCommentIds.add(comment.id);
                            if (!comment.isDeleted) {
                                resolvedComments.push(comment);
                            }
                        }
                    }

                    const commentsWithAuthors = await Promise.all(
                        resolvedComments.map(async (comment) => {
                            const commentProfile = await getProfileWithRetries(gun, comment.author);
                            return {
                                ...comment,
                                authorHandle: commentProfile.handle,
                            };
                        })
                    );

                    let metadata: Metadata | undefined;
                    if (!annotation.screenshot) {
                        metadata = await fetchPageMetadata(cleanUrl);
                    }

                    return {
                        ...annotation,
                        authorHandle: profile.handle,
                        authorProfilePicture: profile.profilePicture,
                        comments: commentsWithAuthors,
                        metadata,
                    };
                })
            );

            await Promise.all(
                annotationNodes.map(node =>
                    new Promise<void>((resolve) => {
                        node.put({replicationMarker: Date.now()}, (ack: any) => {
                            if (ack.err) {
                                console.error(`Failed to force replication for node: ${node._.get}, URL: ${cleanUrl}, Error:`, ack.err);
                            }
                            resolve();
                        });
                    })
                )
            );

            const endTime = Date.now();
            if (throttleLog('annotations_timing', 3600000)) {
                console.log(`[Timing] Total request time: ${endTime - totalStartTime}ms`);
            }

            res.json({annotations: annotationsWithDetails});
        } catch (error) {
            console.error('Error fetching annotations:', error);
            res.status(500).json({error: 'Internal server error'});
        }
    });
}