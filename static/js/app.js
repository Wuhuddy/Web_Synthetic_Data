/* ── Main Application Controller ──────────────────────────────────── */
(function () {
    'use strict';

    const $ = (s) => document.querySelector(s);

    // ── State ──────────────────────────────────────────────────────────
    const state = {
        allImages: [],
        filteredIds: [],
        imageMap: {},
        imageCache: {},

        currentBgId: null,
        pastes: [],

        templates: [],
        activeTemplateIdx: null,

        // box selection on canvas
        selecting: false,             // mid-drag?
        selStart: null,               // {x, y} in image coords
        selEnd: null,                 // {x, y} in image coords
        // resolved paste rect (after mouse up)
        pasteRect: null,              // {x, y, w, h} in image coords, or null

        // per-paste params (applied on top of the rect-derived scale/position)
        scaleOverride: 1.0,   // multiplier on top of auto-scale from rect
        rotation: 0, shearX: 0, shearY: 0,
        brightness: 0, contrast: 1.0, hueShift: 0, saturationScale: 1.0,

        compositeBase64: null,
        labelFilter: 'all',
        defectLabelFilter: 'all',
        defectInvertFilter: false,
        hiddenSourceIds: new Set(),
        sourcesCollapsed: false,
        loading: false,
    };

    // ── DOM ─────────────────────────────────────────────────────────────
    const dom = {
        bgInfo: $('#bg-info'), bgIndex: $('#bg-index'),
        imageList: $('#image-list'), imageCount: $('#image-count'),
        labelFilter: $('#label-filter'),
        defectSourceList: $('#defect-source-list'),
        defectLabelFilter: $('#defect-label-filter'),
        templateList: $('#template-list'),
        templatePreview: $('#template-preview'),
        tpCanvas: $('#tp-canvas'),
        canvasPlaceholder: $('#canvas-placeholder'),
        pasteHint: $('#paste-hint'), pasteCount: $('#paste-count'),
        status: $('#status'),
        btnPrev: $('#btn-prev'), btnNext: $('#btn-next'),
        btnSave: $('#btn-save'), btnDownload: $('#btn-download'),
        outputName: $('#output-name'),
        btnUndo: $('#btn-undo'), btnClearTemplates: $('#btn-clear-templates'),
        btnToggleSources: $('#btn-toggle-sources'),
        btnRestoreSources: $('#btn-restore-sources'),
        btnInvertFilter: $('#btn-invert-filter'),
        btnPreview: $('#btn-preview'), btnApply: $('#btn-apply'),
        btnRandom: $('#btn-random'),
        slScale: null,                   // no longer needed but keep compat
        vlScale: null,
        slRotation: $('#slider-rotation'), vlRotation: $('#val-rotation'),
        slScale: $('#slider-scale'), vlScale: $('#val-scale'),
        slShearX: $('#slider-shearx'),   vlShearX: $('#val-shearx'),
        slShearY: $('#slider-sheary'),   vlShearY: $('#val-sheary'),
        slBrightness: $('#slider-brightness'), vlBrightness: $('#val-brightness'),
        slContrast: $('#slider-contrast'),   vlContrast: $('#val-contrast'),
        slHue: $('#slider-hue'),             vlHue: $('#val-hue'),
        slSaturation: $('#slider-saturation'), vlSaturation: $('#val-saturation'),
    };

    // ── Init ────────────────────────────────────────────────────────────
    async function init() {
        CanvasRenderer.init();
        bindEvents();
        await loadAllImages();
    }

    function bindEvents() {
        const cv = CanvasRenderer.canvas;

        // ── Drag-to-select rectangle on canvas ──────────────────────────
        cv.addEventListener('mousedown', (e) => {
            if (!state.currentBgId) { setStatus('Select a background first', 'error'); return; }
            if (state.activeTemplateIdx === null) { setStatus('Select a template first', 'error'); return; }
            const p = CanvasRenderer.screenToImage(e.clientX, e.clientY);
            state.selecting = true;
            state.selStart = p;
            state.selEnd = p;
            state.pasteRect = null;
            refreshCanvas();
        });

        cv.addEventListener('mousemove', (e) => {
            if (!state.selecting) return;
            state.selEnd = CanvasRenderer.screenToImage(e.clientX, e.clientY);
            refreshCanvas();
            // Draw live selection rect
            const r = selRect();
            CanvasRenderer.drawSelectionRect(r.x, r.y, r.w, r.h);
        });

        cv.addEventListener('mouseup', () => {
            if (!state.selecting) return;
            state.selecting = false;
            const r = selRect();
            if (r.w < 3 || r.h < 3) {
                state.pasteRect = null;
                refreshCanvas();
                setStatus('Drag too small — draw a larger rectangle', 'error');
                return;
            }
            state.pasteRect = r;
            refreshCanvas();
            CanvasRenderer.drawSelectionRect(r.x, r.y, r.w, r.h);
            dom.pasteHint.textContent = `Paste area: (${r.x},${r.y}) ${r.w}×${r.h}`;
            setStatus(`Area: ${r.w}×${r.h} — adjust sliders to tweak`);
            debounceRecomposite();  // auto-preview after drawing rect
        });

        cv.addEventListener('mouseleave', () => {
            if (state.selecting) {
                state.selecting = false;
                const r = selRect();
                if (r.w >= 3 && r.h >= 3) {
                    state.pasteRect = r;
                    refreshCanvas();
                    CanvasRenderer.drawSelectionRect(r.x, r.y, r.w, r.h);
                    debounceRecomposite();
                }
            }
        });

        // Buttons
        dom.btnPrev.addEventListener('click', goPrev);
        dom.btnNext.addEventListener('click', goNext);
        dom.btnSave.addEventListener('click', doSave);
        dom.btnDownload.addEventListener('click', doDownload);
        dom.btnUndo.addEventListener('click', doUndo);
        dom.btnClearTemplates.addEventListener('click', clearTemplates);
        dom.btnToggleSources.addEventListener('click', toggleSources);
        dom.btnRestoreSources.addEventListener('click', showAllSources);
        dom.btnInvertFilter.addEventListener('click', toggleInvertFilter);
        dom.btnPreview.addEventListener('click', doPreview);
        dom.btnApply.addEventListener('click', doApply);
        dom.btnRandom.addEventListener('click', randomizeParams);

        // Filters
        dom.labelFilter.addEventListener('change', () => {
            state.labelFilter = dom.labelFilter.value;
            renderImageList();
        });
        dom.defectLabelFilter.addEventListener('change', () => {
            state.defectLabelFilter = dom.defectLabelFilter.value;
            renderDefectSourceList();
        });

        // Sliders — live re-composite after first preview
        bindSlider(dom.slRotation, dom.vlRotation, (v) => { state.rotation = parseInt(v); return `${v}°`; });
        bindSlider(dom.slScale, dom.vlScale, (v) => { state.scaleOverride = parseFloat(v); return parseFloat(v).toFixed(2); });
        bindSlider(dom.slShearX, dom.vlShearX, (v) => { state.shearX = parseFloat(v); return parseFloat(v).toFixed(2); });
        bindSlider(dom.slShearY, dom.vlShearY, (v) => { state.shearY = parseFloat(v); return parseFloat(v).toFixed(2); });
        bindSlider(dom.slBrightness, dom.vlBrightness, (v) => { state.brightness = parseInt(v); return v; });
        bindSlider(dom.slContrast, dom.vlContrast, (v) => { state.contrast = parseFloat(v); return parseFloat(v).toFixed(2); });
        bindSlider(dom.slHue, dom.vlHue, (v) => { state.hueShift = parseInt(v); return v; });
        bindSlider(dom.slSaturation, dom.vlSaturation, (v) => { state.saturationScale = parseFloat(v); return parseFloat(v).toFixed(2); });

        // Also re-composite on slider change when draft is active
        [dom.slRotation, dom.slScale, dom.slShearX, dom.slShearY,
         dom.slBrightness, dom.slContrast, dom.slHue, dom.slSaturation].forEach(sl => {
            sl.addEventListener('input', debounceRecomposite);
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
            if (e.key === 'ArrowLeft') goPrev();
            if (e.key === 'ArrowRight') goNext();
            if (e.key === 's' && e.ctrlKey) { e.preventDefault(); doSave(); }
            if (e.key === 'Escape') { state.pasteRect = null; state.selecting = false; refreshCanvas(); }
        });
    }

    function bindSlider(slider, label, fn) {
        slider.addEventListener('input', () => { label.textContent = fn(slider.value); });
    }

    function selRect() {
        if (!state.selStart || !state.selEnd) return { x: 0, y: 0, w: 0, h: 0 };
        const x = Math.min(state.selStart.x, state.selEnd.x);
        const y = Math.min(state.selStart.y, state.selEnd.y);
        const w = Math.abs(state.selEnd.x - state.selStart.x);
        const h = Math.abs(state.selEnd.y - state.selStart.y);
        return { x, y, w, h };
    }

    function hasDraft() {
        return state.activeTemplateIdx !== null && state.pasteRect !== null;
    }

    let _recompositeTimer = null;
    let _recompositing = false;
    function debounceRecomposite() {
        if (!hasDraft()) return;
        if (_recompositeTimer) clearTimeout(_recompositeTimer);
        _recompositeTimer = setTimeout(async () => {
            if (_recompositing) return;
            _recompositing = true;
            try { await doPreview(true); } catch (_) {}
            _recompositing = false;
        }, 120);
    }

    // ── Load Data ───────────────────────────────────────────────────────
    async function loadAllImages() {
        try {
            state.allImages = await API.getImages();
            state.allImages.forEach(img => { state.imageMap[img.id] = img; });
            state.filteredIds = state.allImages.map(img => img.id);
            renderImageList();
            renderDefectSourceList();
            dom.imageCount.textContent = `(${state.allImages.length})`;
            if (state.allImages.length > 0) {
                await selectBackground(state.allImages[0].id);
            }
            setStatus('Ready — drag on canvas to select paste area');
        } catch (err) {
            dom.imageList.innerHTML = `<div class="loading">Error: ${err.message}</div>`;
            setStatus('Failed to load images', 'error');
        }
    }

    // ── Image List (Left) ───────────────────────────────────────────────
    function renderImageList() {
        let filtered;
        if (state.labelFilter === 'all') filtered = state.filteredIds;
        else filtered = state.filteredIds.filter(id => {
            const img = state.imageMap[id];
            return img.all_labels && img.all_labels.includes(state.labelFilter);
        });

        dom.imageList.innerHTML = '';
        filtered.forEach(id => {
            const img = state.imageMap[id];
            const div = document.createElement('div');
            div.className = 'image-item' + (id === state.currentBgId ? ' active' : '');
            div.dataset.id = id;
            div.title = `${img.filename}\nDefects: ${img.all_labels.join(', ') || 'none'}`;
            div.innerHTML = `
                <img class="thumb" src="${API.getImageUrl(id)}" loading="lazy">
                <div class="info">
                    <div class="name">${img.filename.substring(36, 50)}...</div>
                    <div class="labels">${renderLabels(img.all_labels)}</div>
                </div>`;
            div.addEventListener('click', () => selectBackground(id));
            dom.imageList.appendChild(div);
        });
        dom.imageCount.textContent = `(${filtered.length})`;
    }

    function renderLabels(labels) {
        if (!labels || labels.length === 0) return '<span class="lbl lbl-none">none</span>';
        return labels.map(l => `<span class="lbl lbl-${l}">${l}</span>`).join('');
    }

    // ── Background ──────────────────────────────────────────────────────
    async function selectBackground(imageId) {
        if (state.loading) return;
        state.loading = true;
        document.querySelectorAll('.image-item').forEach(el => {
            el.classList.toggle('active', el.dataset.id === imageId);
        });
        state.currentBgId = imageId;
        state.pastes = [];
        state.compositeBase64 = null;
        state.pasteRect = null;
        state.selStart = null; state.selEnd = null;
        if (_recompositeTimer) { clearTimeout(_recompositeTimer); _recompositeTimer = null; }

        const bgImg = await loadImage(API.getImageUrl(imageId));
        CanvasRenderer.drawImage(bgImg);
        state.imageCache[imageId] = bgImg;

        const img = state.imageMap[imageId];
        dom.bgInfo.textContent = `BG: ${img.filename.substring(36, 50)}... (${img.all_labels.join(',') || 'none'})`;
        const allIds = getFilteredIds();
        const idx = allIds.indexOf(imageId);
        dom.bgIndex.textContent = `${idx + 1} / ${allIds.length}`;
        updatePasteCount();
        dom.pasteHint.textContent = 'Drag on canvas to select paste area';
        setStatus(`Background: ${idx + 1}/${allIds.length}`);
        state.loading = false;
    }

    function getFilteredIds() {
        if (state.labelFilter === 'all') return state.filteredIds;
        return state.filteredIds.filter(id => {
            const img = state.imageMap[id];
            return img.all_labels && img.all_labels.includes(state.labelFilter);
        });
    }

    // ── Navigation ──────────────────────────────────────────────────────
    async function goPrev() { navigate(-1); }
    async function goNext() { navigate(1); }
    async function navigate(delta) {
        const ids = getFilteredIds();
        if (ids.length === 0) return;
        let idx = ids.indexOf(state.currentBgId);
        if (idx < 0) idx = 0;
        idx = (idx + delta + ids.length) % ids.length;
        await selectBackground(ids[idx]);
    }

    // ── Templates + Defect Sources ──────────────────────────────────────
    function renderDefectSourceList() {
        let images = state.allImages.filter(img =>
            img.shapes && img.shapes.length > 0 && !state.hiddenSourceIds.has(img.id)
        );
        if (state.defectLabelFilter !== 'all') {
            images = images.filter(img => {
                const has = img.all_labels && img.all_labels.includes(state.defectLabelFilter);
                return state.defectInvertFilter ? !has : has;
            });
        }

        dom.defectSourceList.innerHTML = '';
        images.forEach(img => {
            const div = document.createElement('div');
            div.className = 'defect-source-item';
            const shapesHtml = img.shapes.map((s, si) => {
                const key = `${img.id}_${si}`;
                const isAdded = state.templates.some(t => t.key === key);
                return `<span class="ds-shape lbl-${s.label} ${isAdded ? 'added' : ''}"
                    data-key="${key}" data-img="${img.id}" data-si="${si}"
                    title="${s.label} (${s.points.length} pts)">${s.label}</span>`;
            }).join('');
            div.innerHTML = `
                <img class="ds-thumb" src="${API.getImageUrl(img.id)}" loading="lazy">
                <div class="ds-info">
                    <div class="ds-name">${img.filename.substring(36, 50)}...</div>
                    <div class="ds-shapes">${shapesHtml}</div>
                </div>
                <span class="ds-remove" data-imgid="${img.id}" title="Remove">×</span>`;
            div.addEventListener('click', (e) => {
                if (e.target.classList.contains('ds-remove')) {
                    e.stopPropagation(); hideSource(e.target.dataset.imgid); return;
                }
                const shapeEl = e.target.closest('.ds-shape');
                if (shapeEl) {
                    const key = shapeEl.dataset.key, srcId = shapeEl.dataset.img, si = parseInt(shapeEl.dataset.si);
                    const existingIdx = state.templates.findIndex(t => t.key === key);
                    if (existingIdx >= 0) removeTemplate(existingIdx); else addTemplate(srcId, si);
                }
            });
            dom.defectSourceList.appendChild(div);
        });
    }

    function addTemplate(sourceId, shapeIndex) {
        const img = state.imageMap[sourceId];
        if (!img || !img.shapes[shapeIndex]) return;
        const shape = img.shapes[shapeIndex];
        const key = `${sourceId}_${shapeIndex}`;
        if (state.templates.some(t => t.key === key)) return;

        // Compute bounding box of polygon for scale calculation
        const pts = shape.points;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [px, py] of pts) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); }

        state.templates.push({
            key, sourceId, shapeIdx: shapeIndex,
            label: shape.label, polygonPoints: pts,
            defectW: maxX - minX, defectH: maxY - minY,
        });
        if (state.activeTemplateIdx === null && state.templates.length === 1) state.activeTemplateIdx = 0;
        renderTemplates(); renderDefectSourceList();
        setStatus(`Template added: ${shape.label}`);
    }

    function removeTemplate(idx) {
        if (idx < 0 || idx >= state.templates.length) return;
        state.templates.splice(idx, 1);
        if (state.activeTemplateIdx >= state.templates.length)
            state.activeTemplateIdx = state.templates.length > 0 ? state.templates.length - 1 : null;
        renderTemplates(); renderDefectSourceList();
    }

    function clearTemplates() {
        state.templates = []; state.activeTemplateIdx = null;
        renderTemplates(); renderDefectSourceList();
        dom.templatePreview.style.display = 'none';
        setStatus('Templates cleared');
    }

    function renderTemplates() {
        dom.templateList.innerHTML = '';
        if (state.templates.length === 0) {
            dom.templateList.innerHTML = '<div class="empty-hint">Click defect labels below to add</div>';
            return;
        }
        state.templates.forEach((t, i) => {
            const div = document.createElement('div');
            div.className = 'template-item' + (i === state.activeTemplateIdx ? ' selected' : '');
            div.innerHTML = `
                <img class="t-thumb" src="${API.getImageUrl(t.sourceId)}" loading="lazy">
                <div class="t-info">
                    <span class="t-label lbl-${t.label}">${t.label}</span>
                    <span style="font-size:10px;color:#888">${t.polygonPoints.length}pts</span>
                </div>
                <span class="t-remove" data-idx="${i}" title="Remove">×</span>`;
            div.addEventListener('click', (e) => {
                if (e.target.classList.contains('t-remove')) {
                    e.stopPropagation(); removeTemplate(i);
                } else { selectTemplate(i); }
            });
            dom.templateList.appendChild(div);
        });
    }

    function selectTemplate(idx) {
        state.activeTemplateIdx = idx;
        renderTemplates();
        if (idx !== null) {
            const t = state.templates[idx];
            setStatus(`Template: ${t.label} — drag on canvas to set paste area`);
            drawTemplatePreview(t);
            // If already have a rect, auto-recomposite
            debounceRecomposite();
        } else {
            dom.templatePreview.style.display = 'none';
        }
    }

    function drawTemplatePreview(template) {
        dom.templatePreview.style.display = '';
        const canvas = dom.tpCanvas;
        const ctx = canvas.getContext('2d');
        canvas.width = 451; canvas.height = 363;

        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            ctx.clearRect(0, 0, 451, 363);
            ctx.drawImage(img, 0, 0, 451, 363);

            // Draw polygon
            const pts = template.polygonPoints;
            if (pts && pts.length >= 3) {
                ctx.strokeStyle = '#4ecca3';
                ctx.fillStyle = 'rgba(78, 204, 163, 0.25)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(pts[0][0], pts[0][1]);
                for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Bounding box
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const [px, py] of pts) { minX = Math.min(minX, px); minY = Math.min(minY, py); maxX = Math.max(maxX, px); maxY = Math.max(maxY, py); }
                ctx.strokeStyle = '#e94560';
                ctx.lineWidth = 1;
                ctx.setLineDash([3, 3]);
                ctx.strokeRect(minX, minY, maxX - minX, maxY - minY);
                ctx.setLineDash([]);
            }

            // Scale canvas display
            const container = canvas.parentElement;
            const maxW = container.clientWidth - 8;
            const scl = Math.min(maxW / 451, 220 / 363, 1.0);
            canvas.style.width = `${Math.round(451 * scl)}px`;
            canvas.style.height = `${Math.round(363 * scl)}px`;
        };
        img.src = API.getImageUrl(template.sourceId);
    }

    function toggleSources() {
        state.sourcesCollapsed = !state.sourcesCollapsed;
        const list = dom.defectSourceList;
        const filterRow = document.querySelector('.source-filter-row');
        if (state.sourcesCollapsed) {
            list.style.display = 'none';
            if (filterRow) filterRow.style.display = 'none';
            dom.btnToggleSources.textContent = '+';
        } else {
            list.style.display = '';
            if (filterRow) filterRow.style.display = '';
            dom.btnToggleSources.textContent = '−';
        }
    }

    function toggleInvertFilter() {
        state.defectInvertFilter = !state.defectInvertFilter;
        dom.btnInvertFilter.classList.toggle('active', state.defectInvertFilter);
        setStatus(state.defectInvertFilter ? `NOT ${state.defectLabelFilter}` : state.defectLabelFilter);
        renderDefectSourceList();
    }

    function hideSource(sourceId) {
        state.hiddenSourceIds.add(sourceId);
        state.templates = state.templates.filter(t => t.sourceId !== sourceId);
        if (state.activeTemplateIdx !== null && state.activeTemplateIdx >= state.templates.length)
            state.activeTemplateIdx = state.templates.length > 0 ? state.templates.length - 1 : null;
        renderDefectSourceList(); renderTemplates();
        setStatus(`Hidden: ${state.hiddenSourceIds.size} source(s)`);
    }

    function showAllSources() {
        state.hiddenSourceIds.clear();
        renderDefectSourceList();
        setStatus('All sources restored');
    }

    // ── Compositing ─────────────────────────────────────────────────────
    function buildPasteOp() {
        if (state.activeTemplateIdx === null) return null;
        if (!state.pasteRect) return null;
        const t = state.templates[state.activeTemplateIdx];
        const r = state.pasteRect;

        // Scale defect to fill the selected rectangle, then apply user override
        const defectW = t.defectW || 20;
        const defectH = t.defectH || 20;
        const scaleX = r.w / defectW;
        const scaleY = r.h / defectH;
        const autoScale = Math.min(scaleX, scaleY);  // fit inside

        return {
            source_image_id: t.sourceId,
            polygon_points: t.polygonPoints,
            position_x: r.x + r.w / 2,   // paste at center of rect
            position_y: r.y + r.h / 2,
            scale: autoScale * (state.scaleOverride || 1.0),
            rotation: state.rotation,
            shear_x: state.shearX,
            shear_y: state.shearY,
            brightness: state.brightness,
            contrast: state.contrast,
            hue_shift: state.hueShift,
            saturation_scale: state.saturationScale,
        };
    }

    async function doPreview(silent) {
        if (!state.currentBgId) { setStatus('Select a background', 'error'); return; }
        const newOp = buildPasteOp();
        if (!newOp) { if (!silent) setStatus('Select a template and draw a rectangle on canvas', 'error'); return; }

        if (!silent) setStatus('Previewing...');
        try {
            const allOps = [...state.pastes, newOp];
            const result = await API.composite(state.currentBgId, allOps);
            CanvasRenderer.drawBase64(result.composite_base64);
            state.compositeBase64 = result.composite_base64;
            if (state.pasteRect) {
                const r = state.pasteRect;
                CanvasRenderer.drawSelectionRect(r.x, r.y, r.w, r.h);
            }
            if (!silent) setStatus('Preview ready — adjust sliders to tweak', 'success');
        } catch (err) {
            if (!silent) setStatus(`Error: ${err.message}`, 'error');
        }
    }

    async function doApply() {
        if (!state.currentBgId) { setStatus('Select a background', 'error'); return; }
        const newOp = buildPasteOp();
        if (!newOp) { setStatus('Select a template and draw a rectangle', 'error'); return; }

        setStatus('Saving paste...');
        try {
            state.pastes.push(newOp);
            const result = await API.composite(state.currentBgId, state.pastes);
            CanvasRenderer.drawBase64(result.composite_base64);
            state.compositeBase64 = result.composite_base64;
            if (state.pasteRect) {
                const r = state.pasteRect;
                CanvasRenderer.drawSelectionRect(r.x, r.y, r.w, r.h);
            }
            state.pasteRect = null; // reset for next paste
            if (_recompositeTimer) { clearTimeout(_recompositeTimer); _recompositeTimer = null; }
            updatePasteCount();
            setStatus(`Paste saved! Total: ${state.pastes.length}. Draw a new rect for next paste.`, 'success');
        } catch (err) {
            setStatus(`Error: ${err.message}`, 'error');
        }
    }

    async function doSave() {
        if (!state.currentBgId || state.pastes.length === 0) { setStatus('Nothing to save', 'error'); return; }
        setStatus('Saving to disk...');
        try {
            const outName = dom.outputName.value.trim() || null;
            const result = await API.saveResult(state.currentBgId, state.pastes, outName);

            // Remove consumed source images from local state
            if (result.consumed_source_ids) {
                result.consumed_source_ids.forEach(id => { state.hiddenSourceIds.add(id); });
                state.templates = state.templates.filter(t => !result.consumed_source_ids.includes(t.sourceId));
                if (state.activeTemplateIdx !== null && state.activeTemplateIdx >= state.templates.length) {
                    state.activeTemplateIdx = state.templates.length > 0 ? state.templates.length - 1 : null;
                }
                renderDefectSourceList();
                renderTemplates();
            }

            // Reset canvas to clean background — bg stays reusable
            state.pastes = [];
            state.compositeBase64 = null;
            state.pasteRect = null;
            state.selStart = null; state.selEnd = null;
            state.rotation = 0; state.shearX = 0; state.shearY = 0;
            state.brightness = 0; state.contrast = 1.0; state.hueShift = 0; state.saturationScale = 1.0;
            if (_recompositeTimer) { clearTimeout(_recompositeTimer); _recompositeTimer = null; }

            // Reload clean background onto canvas
            const bgImg = state.imageCache[state.currentBgId];
            if (bgImg) CanvasRenderer.drawImage(bgImg);
            updatePasteCount();
            dom.pasteHint.textContent = 'Drag on canvas to select new paste area';
            syncSliders();

            setStatus(`Saved: ${result.saved_path}. Draw a new box for next paste.`, 'success');
        } catch (err) { setStatus(`Error: ${err.message}`, 'error'); }
    }

    async function doUndo() {
        if (state.pastes.length === 0) { setStatus('Nothing to undo', 'error'); return; }
        state.pastes.pop();
        updatePasteCount();
        if (state.pastes.length === 0) {
            const bgImg = state.imageCache[state.currentBgId];
            if (bgImg) CanvasRenderer.drawImage(bgImg);
            else { const img = await loadImage(API.getImageUrl(state.currentBgId)); CanvasRenderer.drawImage(img); state.imageCache[state.currentBgId] = img; }
            state.compositeBase64 = null;
        } else {
            try {
                const result = await API.composite(state.currentBgId, state.pastes);
                CanvasRenderer.drawBase64(result.composite_base64);
                state.compositeBase64 = result.composite_base64;
            } catch (err) { setStatus(`Error: ${err.message}`, 'error'); }
        }
        setStatus(`Undone. Remaining: ${state.pastes.length}`);
    }

    async function doDownload() {
        if (!state.currentBgId) return;
        let b64 = state.compositeBase64;
        if (!b64 && state.pastes.length > 0) {
            const r = await API.composite(state.currentBgId, state.pastes);
            b64 = r.composite_base64;
        }
        if (!b64) b64 = CanvasRenderer.getBase64();
        const a = document.createElement('a');
        a.download = `aug_${state.currentBgId}.png`;
        a.href = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
        a.click();
        setStatus('Downloaded');
    }

    function refreshCanvas() {
        if (state.compositeBase64) CanvasRenderer.drawBase64(state.compositeBase64);
        else if (state.currentBgId && state.imageCache[state.currentBgId]) CanvasRenderer.drawImage(state.imageCache[state.currentBgId]);
    }

    function updatePasteCount() {
        dom.pasteCount.style.display = state.pastes.length > 0 ? 'inline' : 'none';
        dom.pasteCount.textContent = `Pastes: ${state.pastes.length}`;
    }

    // ── Randomize ───────────────────────────────────────────────────────
    function randomizeParams() {
        state.rotation = randInt(-40, 40);
        state.shearX = rand(-0.15, 0.15); state.shearY = rand(-0.15, 0.15);
        state.brightness = randInt(-30, 30); state.contrast = rand(0.6, 1.5);
        state.hueShift = randInt(-20, 20); state.saturationScale = rand(0.6, 1.5);
        syncSliders(); setStatus('Randomized');
    }

    function syncSliders() {
        const pairs = [
            [dom.slScale, state.scaleOverride], [dom.slRotation, state.rotation],
            [dom.slShearX, state.shearX], [dom.slShearY, state.shearY],
            [dom.slBrightness, state.brightness], [dom.slContrast, state.contrast],
            [dom.slHue, state.hueShift], [dom.slSaturation, state.saturationScale],
        ];
        pairs.forEach(([sl, val]) => { sl.value = val; sl.dispatchEvent(new Event('input')); });
    }

    // ── Helpers ─────────────────────────────────────────────────────────
    function loadImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image(); img.crossOrigin = 'anonymous';
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(`Failed to load: ${url}`));
            img.src = url;
        });
    }

    function setStatus(msg, cls = '') { dom.status.textContent = msg; dom.status.className = 'status ' + cls; }
    function rand(min, max) { return Math.round((min + Math.random() * (max - min)) * 100) / 100; }
    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

    init();
})();
