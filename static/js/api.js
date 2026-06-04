/* ── API Client ──────────────────────────────────────────────────── */
const API = {
    async getImages() {
        const res = await fetch('/api/images');
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        return (await res.json()).images;
    },

    getImageUrl(imageId) {
        return `/api/image/${encodeURIComponent(imageId)}`;
    },

    async getImageInfo(imageId) {
        const res = await fetch(`/api/image/${encodeURIComponent(imageId)}/info`);
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        return res.json();
    },

    async composite(backgroundImageId, pasteOps) {
        const res = await fetch('/api/composite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ background_image_id: backgroundImageId, paste_ops: pasteOps }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Composite failed: ${res.status}`);
        }
        return res.json();
    },

    async cropDefect(sourceImageId, polygonPoints) {
        const res = await fetch('/api/crop-defect', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source_image_id: sourceImageId, polygon_points: polygonPoints }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Crop failed: ${res.status}`);
        }
        return res.json();
    },

    async saveResult(backgroundImageId, pasteOps, outputName) {
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ background_image_id: backgroundImageId, paste_ops: pasteOps, output_name: outputName || null }),
        });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.error || `Save failed: ${res.status}`);
        }
        return res.json();
    },
};
