// web/index.tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { AnnotationUI, storage } from '@waltika/citizenx-shared';

const { url = '', annotationId = '' } = window.__INITIAL_DATA__ || { url: '', annotationId: '' };

if (url && annotationId) {
    const container = document.getElementById('root');
    if (container) {
        createRoot(container).render(
            <AnnotationUI url={url} annotationId={annotationId} isWeb={true} storage={storage} />,
        );
    } else {
        console.error('Root container not found');
    }
} else {
    console.error('Required parameters (url, annotationId) not found');
}