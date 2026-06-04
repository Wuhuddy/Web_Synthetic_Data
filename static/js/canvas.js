/* ── Canvas Renderer ──────────────────────────────────────────────── */
const CanvasRenderer = {
    canvas: null,
    ctx: null,
    scale: 1.0,

    init() {
        this.canvas = document.getElementById('preview-canvas');
        this.ctx = this.canvas.getContext('2d');
        this._resize();
        window.addEventListener('resize', () => this._resize());
    },

    _resize() {
        const container = this.canvas.parentElement;
        const pad = 8;
        const maxW = container.clientWidth - pad;
        const maxH = container.clientHeight - pad;
        this.scale = Math.min(maxW / 451, maxH / 363);
        this.canvas.style.width = `${Math.round(451 * this.scale)}px`;
        this.canvas.style.height = `${Math.round(363 * this.scale)}px`;
    },

    screenToImage(sx, sy) {
        const r = this.canvas.getBoundingClientRect();
        return {
            x: Math.round(Math.max(0, Math.min((sx - r.left) / this.scale, 451))),
            y: Math.round(Math.max(0, Math.min((sy - r.top) / this.scale, 363))),
        };
    },

    drawImage(img) {
        this.ctx.clearRect(0, 0, 451, 363);
        this.ctx.drawImage(img, 0, 0, 451, 363);
        document.getElementById('canvas-placeholder').style.display = 'none';
    },

    drawBase64(b64) {
        const img = new Image();
        img.onload = () => {
            this.ctx.clearRect(0, 0, 451, 363);
            this.ctx.drawImage(img, 0, 0, 451, 363);
            document.getElementById('canvas-placeholder').style.display = 'none';
        };
        img.src = `data:image/png;base64,${b64}`;
    },

    /** Draw a selection rectangle overlay on top of current content */
    drawSelectionRect(rx, ry, rw, rh, color = '#4ecca3') {
        this.ctx.save();
        // Semi-transparent fill
        this.ctx.fillStyle = 'rgba(78, 204, 163, 0.15)';
        this.ctx.fillRect(rx, ry, rw, rh);
        // Dashed border
        this.ctx.strokeStyle = color;
        this.ctx.lineWidth = 1.5;
        this.ctx.setLineDash([5, 3]);
        this.ctx.strokeRect(rx, ry, rw, rh);
        this.ctx.setLineDash([]);
        this.ctx.restore();
    },

    getBase64() {
        return this.canvas.toDataURL('image/png');
    },

    clear() {
        this.ctx.clearRect(0, 0, 451, 363);
        document.getElementById('canvas-placeholder').style.display = 'block';
    },
};
