import {createRoot} from 'react-dom/client';
import {AnnotationUI} from '../../CitizenX/packages/shared/src/components/AnnotationUI';
import {storage} from "../../CitizenX/packages/shared/src/storage/StorageRepository";

// Example values (adjust based on your context)
const url = window.location.href; // Or your specific URL source
const annotationId = new URLSearchParams(window.location.search).get('annotationId') || 'default-id'; // Example


const root = createRoot(document.getElementById('root')!);
root.render(
    <AnnotationUI
        url={url}
        annotationId={annotationId}
        isWeb={true} // Web context
        storage={storage}
    />
);