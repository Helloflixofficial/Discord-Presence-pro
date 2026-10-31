/* ═══════════════════════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════════════════════ */
const STORAGE_KEY = "customrp-presence";
const form = must("presence-form");
const notice = must("notice");
const fields = new Map();
const defaultNames = { 0: "Playing", 2: "Listening to", 3: "Watching", 5: "Competing in" };
let state;
let serverDefault = null;
/* Animation state (client-side) */
let activeTarget = "large";
let largeFrames = [];
let smallFrames = [];
let animPreviewTimer = null;
let animLargeIndex = 0;
let animSmallIndex = 0;
// Drag-and-drop reorder
let dragSrcId = null;
function getActiveFrames() {
    return activeTarget === "small" ? smallFrames : largeFrames;
}
function setActiveFrames(items) {
    if (activeTarget === "small") {
        smallFrames = items;
    }
    else {
        largeFrames = items;
    }
}
function updateTabCounts() {
    const largeEl = document.getElementById("large-tab-count");
    if (largeEl)
        largeEl.textContent = String(largeFrames.length);
    const smallEl = document.getElementById("small-tab-count");
    if (smallEl)
        smallEl.textContent = String(smallFrames.length);
    const currentCount = getActiveFrames().length;
    must("frame-count").textContent = String(currentCount);
}
function switchTab(target) {
    activeTarget = target;
    const largeTab = must("tab-large-frames");
    const smallTab = must("tab-small-frames");
    const dropLabel = document.getElementById("drop-target-label");
    if (target === "large") {
        largeTab.classList.add("active");
        largeTab.setAttribute("aria-selected", "true");
        smallTab.classList.remove("active");
        smallTab.setAttribute("aria-selected", "false");
        if (dropLabel)
            dropLabel.textContent = "PNG · JPG · WEBP · GIF · for LARGE IMAGE (up to 20 frames)";
    }
    else {
        smallTab.classList.add("active");
        smallTab.setAttribute("aria-selected", "true");
        largeTab.classList.remove("active");
        largeTab.setAttribute("aria-selected", "false");
        if (dropLabel)
            dropLabel.textContent = "PNG · JPG · WEBP · GIF · for SMALL IMAGE (up to 20 frames)";
    }
    updateTabCounts();
    renderFrameGrid();
    updateAnimControls();
    updateAnimPreviewStrip();
}
/* ═══════════════════════════════════════════════════════════════════════════
   BOOTSTRAP
═══════════════════════════════════════════════════════════════════════════ */
void bootstrap();
async function bootstrap() {
    document.querySelectorAll("[data-field]").forEach((field) => {
        const name = field.dataset.field;
        if (name)
            fields.set(name, field);
        field.addEventListener("input", handleFieldChange);
        field.addEventListener("change", handleFieldChange);
    });
    const response = await fetch("/api/config");
    const config = await response.json();
    serverDefault = config.defaultPresence;
    state = loadState(config.defaultPresence);
    writeStateToForm();
    render();
    bindActions();
    startLivePreviewClock();
    startSystemHealthPolling();
    await refreshStatus();
    await loadFrames();
    // Auto-connect to Discord on open, unless explicitly disconnected in this session
    const manuallyDisconnected = sessionStorage.getItem("customrp-manual-disconnect") === "true";
    if (!isBridgeConnected && !manuallyDisconnected && state.applicationId?.trim()) {
        console.log("Auto-connecting to Discord on open...");
        void postPresence("connect", true);
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   PRESENCE FORM BINDINGS
═══════════════════════════════════════════════════════════════════════════ */
function bindActions() {
    const triggerUpdate = () => {
        sessionStorage.removeItem("customrp-manual-disconnect");
        void postPresence("update");
    };
    must("connect").addEventListener("click", () => {
        sessionStorage.removeItem("customrp-manual-disconnect");
        void postPresence("connect");
    });
    must("quick-update").addEventListener("click", triggerUpdate);
    const btnUpdate = document.getElementById("buttons-update-btn");
    if (btnUpdate)
        btnUpdate.addEventListener("click", triggerUpdate);
    const topUpdate = document.getElementById("topbar-update");
    if (topUpdate)
        topUpdate.addEventListener("click", triggerUpdate);
    must("disconnect").addEventListener("click", () => void disconnect());
    must("export-preset").addEventListener("click", exportPreset);
    must("import-preset").addEventListener("click", () => must("preset-file").click());
    must("preset-file").addEventListener("change", (e) => void importPreset(e));
    must("reset-form").addEventListener("click", resetEditor);
    must("assets-link").addEventListener("click", (e) => { if (!state.applicationId)
        e.preventDefault(); });
    // ── Timer Presets (10m, 25m, 1h, 2h) ─────────────────────────────────
    document.querySelectorAll(".timer-preset-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
            const mins = Number(btn.dataset.minutes) || 0;
            state.timerOffsetMinutes = mins;
            setField("timerOffsetMinutes", mins);
            if (must("autosave").checked) {
                persistStateDebounced();
                pushToDiscordDebounced();
            }
            render();
        });
    });
    // ── Category Tabs bindings ───────────────────────────────────────────
    const categoryTabs = document.querySelectorAll(".nav-tab, .editor-tab");
    categoryTabs.forEach((tab) => {
        tab.addEventListener("click", () => {
            const targetId = tab.dataset.tab;
            if (!targetId)
                return;
            categoryTabs.forEach((t) => {
                t.classList.remove("active");
                t.setAttribute("aria-selected", "false");
            });
            tab.classList.add("active");
            tab.setAttribute("aria-selected", "true");
            document.querySelectorAll(".panel-section").forEach((panel) => {
                panel.classList.toggle("active", panel.id === targetId);
            });
            try {
                localStorage.setItem("customrp-active-tab", targetId);
            }
            catch { /* ignore */ }
        });
    });
    // ── Server Health Topbar Pill & Actions ───────────────────────────────
    const healthPill = document.getElementById("topbar-health-pill");
    if (healthPill) {
        healthPill.addEventListener("click", () => {
            const healthTab = document.querySelector('.nav-tab[data-tab="tab-health"]');
            if (healthTab)
                healthTab.click();
        });
    }
    const gotoHealth = document.getElementById("goto-health-tab");
    if (gotoHealth) {
        gotoHealth.addEventListener("click", () => {
            const healthTab = document.querySelector('.nav-tab[data-tab="tab-health"]');
            if (healthTab)
                healthTab.click();
        });
    }
    // Quick Chips under Details & State
    document.querySelectorAll(".chip-btn").forEach((chip) => {
        chip.addEventListener("click", () => {
            const target = chip.dataset.insertTarget;
            const val = chip.dataset.insertVal;
            if (!target || !val)
                return;
            const current = String(state[target] || "");
            const updated = current ? `${current} ${val}`.slice(0, 128) : val.slice(0, 128);
            state[target] = updated;
            setField(target, updated);
            if (must("autosave").checked) {
                persistStateDebounced();
                pushToDiscordDebounced();
            }
            render();
        });
    });
    // Tab 06 Server Health Buttons
    const btnInsertDetails = document.getElementById("btn-insert-health-details");
    if (btnInsertDetails) {
        btnInsertDetails.addEventListener("click", () => {
            state.line1Mode = "cpu";
            setField("line1Mode", "cpu");
            if (must("autosave").checked) {
                persistStateDebounced();
                pushToDiscordDebounced();
            }
            render();
            showNotice("Set Line 1 to CPU Usage Bar!", "success");
        });
    }
    const btnInsertState = document.getElementById("btn-insert-health-state");
    if (btnInsertState) {
        btnInsertState.addEventListener("click", () => {
            state.line2Mode = "ram";
            setField("line2Mode", "ram");
            if (must("autosave").checked) {
                persistStateDebounced();
                pushToDiscordDebounced();
            }
            render();
            showNotice("Set Line 2 to RAM Usage Bar!", "success");
        });
    }
    const btnCopyHealth = document.getElementById("btn-copy-health-bar");
    if (btnCopyHealth) {
        btnCopyHealth.addEventListener("click", () => {
            const barText = document.getElementById("health-hero-bar")?.textContent || "";
            if (barText) {
                void navigator.clipboard.writeText(barText).then(() => {
                    showNotice("Copied Server Health Bar to clipboard!", "success");
                }).catch(() => {
                    showNotice("Failed to copy", "error");
                });
            }
        });
    }
    const btnHealthRefresh = document.getElementById("health-refresh-btn");
    if (btnHealthRefresh) {
        btnHealthRefresh.addEventListener("click", () => void fetchSystemHealth());
    }
    // Restore active category tab if saved
    try {
        const savedTab = localStorage.getItem("customrp-active-tab");
        if (savedTab) {
            const targetBtn = document.querySelector(`.nav-tab[data-tab="${savedTab}"], .editor-tab[data-tab="${savedTab}"]`);
            if (targetBtn)
                targetBtn.click();
        }
    }
    catch { /* ignore */ }
    // Mobile preview toggle
    const mobileToggle = document.getElementById("mobile-preview-toggle");
    if (mobileToggle) {
        mobileToggle.addEventListener("click", () => {
            const preview = document.querySelector(".preview-pane");
            if (preview) {
                preview.scrollIntoView({ behavior: "smooth" });
            }
        });
    }
    // ── Animation Tabs bindings ──────────────────────────────────────────
    must("tab-large-frames").addEventListener("click", () => switchTab("large"));
    must("tab-small-frames").addEventListener("click", () => switchTab("small"));
    // ── Animation Frames bindings ──────────────────────────────────────────
    const dropZone = must("drop-zone");
    const fileInput = must("frame-file-input");
    const zipBtn = must("upload-zip-btn");
    const zipInput = must("zip-file-input");
    // Click on drop zone
    dropZone.addEventListener("click", () => fileInput.click());
    dropZone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ")
        fileInput.click(); });
    // Drag-and-drop onto the zone
    dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("drag-over"); });
    dropZone.addEventListener("dragleave", () => dropZone.classList.remove("drag-over"));
    dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        const files = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (files.length)
            void uploadImageFiles(files);
    });
    // File input change
    fileInput.addEventListener("change", () => {
        const files = Array.from(fileInput.files ?? []);
        if (files.length)
            void uploadImageFiles(files);
        fileInput.value = "";
    });
    // ZIP upload
    zipBtn.addEventListener("click", () => zipInput.click());
    zipInput.addEventListener("change", () => {
        const file = zipInput.files?.[0];
        if (file)
            void uploadZip(file);
        zipInput.value = "";
    });
    // Animation control buttons
    must("anim-play-btn").addEventListener("click", () => void startAnimation());
    must("anim-stop-btn").addEventListener("click", () => void stopAnimation());
    must("anim-clear-btn").addEventListener("click", () => void clearAllFrames());
    // Interval change listener
    const intervalInput = must("anim-interval");
    const onIntervalChange = () => {
        const intervalMs = getIntervalMs();
        if (largeFrames.length >= 2 || smallFrames.length >= 2) {
            startAnimPreview();
            if (largeFrames.length >= 2) {
                void fetch("/api/animation/start", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ target: "large", urls: largeFrames.map((f) => f.url), intervalMs })
                });
            }
            if (smallFrames.length >= 2) {
                void fetch("/api/animation/start", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ target: "small", urls: smallFrames.map((f) => f.url), intervalMs })
                });
            }
        }
    };
    intervalInput.addEventListener("change", onIntervalChange);
    intervalInput.addEventListener("input", onIntervalChange);
}
function getIntervalMs() {
    const input = document.getElementById("anim-interval");
    return Number(input?.value) || 50;
}
/* ═══════════════════════════════════════════════════════════════════════════
   LOAD FRAMES FROM SERVER
═══════════════════════════════════════════════════════════════════════════ */
async function loadFrames() {
    try {
        const [largeRes, smallRes] = await Promise.all([
            fetch("/api/frames?target=large"),
            fetch("/api/frames?target=small")
        ]);
        const largeData = (await largeRes.json());
        const smallData = (await smallRes.json());
        largeFrames = largeData.frames || [];
        smallFrames = smallData.frames || [];
        updateTabCounts();
        renderFrameGrid();
        startOrUpdatePreviews();
    }
    catch {
        showNotice("Could not load animation frames from server.", "error");
    }
}
function startOrUpdatePreviews() {
    updateAnimControls();
    if (largeFrames.length >= 2 || smallFrames.length >= 2) {
        startAnimPreview();
    }
    else {
        stopAnimPreview();
        updatePreview();
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD IMAGE FILES
═══════════════════════════════════════════════════════════════════════════ */
async function uploadImageFiles(files) {
    const current = getActiveFrames();
    const maxFrames = 20;
    const available = maxFrames - current.length;
    if (available <= 0) {
        showNotice(`Maximum ${maxFrames} frames reached for ${activeTarget} image. Delete some before adding more.`, "error");
        return;
    }
    const toUpload = files.slice(0, available);
    if (files.length > available) {
        showNotice(`Only ${available} slot(s) free. Uploading first ${available} files.`, "");
    }
    // Show skeleton cards
    const skeletonIds = toUpload.map(() => addSkeletonCard());
    const formData = new FormData();
    formData.append("target", activeTarget);
    toUpload.forEach((f) => formData.append("files", f));
    try {
        const res = await fetch("/api/frames/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "Upload failed.");
        // Remove skeletons and add real frames
        skeletonIds.forEach((id) => document.getElementById(id)?.remove());
        const inserted = data.frames ?? [];
        if (activeTarget === "small") {
            smallFrames.push(...inserted);
        }
        else {
            largeFrames.push(...inserted);
        }
        updateTabCounts();
        renderFrameGrid();
        // Auto-sync with bridge if >= 2 frames
        const targetFrames = getActiveFrames();
        if (targetFrames.length >= 2) {
            startOrUpdatePreviews();
            const intervalMs = getIntervalMs();
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ target: activeTarget, urls: targetFrames.map((f) => f.url), intervalMs })
            });
        }
        showNotice(`${inserted.length} frame(s) uploaded for ${activeTarget} image successfully.`, "success");
    }
    catch (err) {
        skeletonIds.forEach((id) => document.getElementById(id)?.remove());
        renderFrameGrid();
        showNotice(err instanceof Error ? err.message : "Upload failed.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD ZIP
═══════════════════════════════════════════════════════════════════════════ */
async function uploadZip(file) {
    showNotice(`Extracting ZIP and uploading frames for ${activeTarget} image…`);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("target", activeTarget);
    try {
        const res = await fetch("/api/frames/upload-zip", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "ZIP upload failed.");
        const inserted = data.frames ?? [];
        if (activeTarget === "small") {
            smallFrames.push(...inserted);
        }
        else {
            largeFrames.push(...inserted);
        }
        updateTabCounts();
        renderFrameGrid();
        const targetFrames = getActiveFrames();
        if (targetFrames.length >= 2) {
            startOrUpdatePreviews();
            const intervalMs = getIntervalMs();
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ target: activeTarget, urls: targetFrames.map((f) => f.url), intervalMs })
            });
        }
        showNotice(`${data.count ?? inserted.length} frame(s) imported from ZIP for ${activeTarget} image.`, "success");
    }
    catch (err) {
        showNotice(err instanceof Error ? err.message : "ZIP upload failed.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   DELETE FRAME
═══════════════════════════════════════════════════════════════════════════ */
async function deleteFrameById(id) {
    try {
        await fetch(`/api/frames/${id}`, { method: "DELETE" });
        if (activeTarget === "small") {
            smallFrames = smallFrames.filter((f) => f.id !== id);
        }
        else {
            largeFrames = largeFrames.filter((f) => f.id !== id);
        }
        updateTabCounts();
        renderFrameGrid();
        const targetFrames = getActiveFrames();
        if (targetFrames.length < 2) {
            void fetch("/api/animation/stop", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ target: activeTarget })
            });
        }
        startOrUpdatePreviews();
    }
    catch {
        showNotice("Could not delete frame.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   CLEAR ALL
═══════════════════════════════════════════════════════════════════════════ */
async function clearAllFrames() {
    if (!confirm(`Delete all animation frames for ${activeTarget} image? This cannot be undone.`))
        return;
    try {
        await fetch(`/api/frames?target=${activeTarget}`, { method: "DELETE" });
        await fetch("/api/animation/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: activeTarget })
        });
        if (activeTarget === "small") {
            smallFrames = [];
        }
        else {
            largeFrames = [];
        }
        updateTabCounts();
        renderFrameGrid();
        startOrUpdatePreviews();
        showNotice(`All ${activeTarget} animation frames cleared.`, "success");
    }
    catch {
        showNotice("Could not clear frames.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   ANIMATION CONTROLS
═══════════════════════════════════════════════════════════════════════════ */
async function startAnimation() {
    const current = getActiveFrames();
    if (current.length < 2) {
        showNotice(`Add at least 2 frames to start animation for ${activeTarget} image.`, "error");
        return;
    }
    const intervalMs = getIntervalMs();
    const urls = current.map((f) => f.url);
    try {
        const res = await fetch("/api/animation/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: activeTarget, urls, intervalMs })
        });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "Failed to start animation.");
        startOrUpdatePreviews();
        showNotice(`${activeTarget.toUpperCase()} animation started — ${current.length} frames cycling at ${intervalMs}ms.`, "success");
    }
    catch (err) {
        showNotice(err instanceof Error ? err.message : "Could not start animation.", "error");
    }
}
async function stopAnimation() {
    try {
        await fetch("/api/animation/stop", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ target: activeTarget })
        });
    }
    catch { /* best-effort */ }
    showNotice(`${activeTarget.toUpperCase()} animation stopped.`, "success");
    updateAnimControls();
}
function updateAnimControls() {
    const current = getActiveFrames();
    must("anim-play-btn").disabled = current.length < 2;
    must("anim-stop-btn").disabled = current.length < 2;
}
/* ═══════════════════════════════════════════════════════════════════════════
   LOCAL ANIMATION PREVIEW (in the Discord mock + strip)
═══════════════════════════════════════════════════════════════════════════ */
function startAnimPreview() {
    stopAnimPreview();
    const intervalMs = getIntervalMs();
    animLargeIndex = 0;
    animSmallIndex = 0;
    updateAnimPreviewStrip();
    animPreviewTimer = window.setInterval(() => {
        tickAnimPreview();
    }, intervalMs);
    tickAnimPreview(); // immediate first tick
}
function updateAnimPreviewStrip() {
    const activeFrames = getActiveFrames();
    const strip = must("anim-preview-strip");
    if (activeFrames.length < 2) {
        strip.classList.add("hidden");
        return;
    }
    strip.classList.remove("hidden");
    const stripFrames = must("anim-strip-frames");
    stripFrames.innerHTML = "";
    activeFrames.forEach((f, i) => {
        const div = document.createElement("div");
        div.className = "strip-frame";
        div.id = `strip-${i}`;
        const img = document.createElement("img");
        img.src = f.url;
        img.alt = f.file_name;
        div.appendChild(img);
        stripFrames.appendChild(div);
    });
    must("anim-strip-count").textContent = String(activeFrames.length);
}
function tickAnimPreview() {
    // Update large art if animating
    if (largeFrames.length >= 2) {
        animLargeIndex = (animLargeIndex + 1) % largeFrames.length;
        const url = largeFrames[animLargeIndex].url;
        const art = must("large-art");
        art.classList.add("has-image");
        art.style.backgroundImage = `url("${CSS.escape(url)}")`;
    }
    else if (!state?.largeKey) {
        const art = must("large-art");
        art.classList.remove("has-image");
        art.style.backgroundImage = "";
    }
    // Update small art if animating
    if (smallFrames.length >= 2) {
        animSmallIndex = (animSmallIndex + 1) % smallFrames.length;
        const url = smallFrames[animSmallIndex].url;
        const art = must("small-art");
        art.classList.add("has-image");
        art.style.backgroundImage = `url("${CSS.escape(url)}")`;
    }
    else if (!state?.smallKey) {
        const art = must("small-art");
        art.classList.remove("has-image");
        art.style.backgroundImage = "";
    }
    // Highlight strip frame for active target
    const activeFrames = getActiveFrames();
    if (activeFrames.length >= 2) {
        const activeIdx = activeTarget === "large" ? animLargeIndex : animSmallIndex;
        document.querySelectorAll(".strip-frame").forEach((el) => el.classList.remove("active"));
        document.getElementById(`strip-${activeIdx}`)?.classList.add("active");
    }
}
function stopAnimPreview() {
    if (animPreviewTimer !== null) {
        clearInterval(animPreviewTimer);
        animPreviewTimer = null;
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   FRAME GRID RENDERING
═══════════════════════════════════════════════════════════════════════════ */
function renderFrameGrid() {
    const grid = must("frame-grid");
    grid.innerHTML = "";
    const current = getActiveFrames();
    current.forEach((frame, index) => {
        const card = document.createElement("div");
        card.className = "frame-card";
        card.dataset.id = String(frame.id);
        card.draggable = true;
        card.id = `frame-card-${frame.id}`;
        const img = document.createElement("img");
        img.src = frame.url;
        img.alt = frame.file_name;
        img.className = "frame-img";
        card.appendChild(img);
        const overlay = document.createElement("div");
        overlay.className = "frame-overlay";
        const delBtn = document.createElement("button");
        delBtn.className = "frame-del-btn";
        delBtn.textContent = "✕";
        delBtn.title = "Delete frame";
        delBtn.addEventListener("click", (e) => { e.stopPropagation(); void deleteFrameById(frame.id); });
        overlay.appendChild(delBtn);
        const idxLabel = document.createElement("div");
        idxLabel.className = "frame-index";
        idxLabel.textContent = `#${index + 1}`;
        overlay.appendChild(idxLabel);
        card.appendChild(overlay);
        const nameTag = document.createElement("div");
        nameTag.className = "frame-name";
        nameTag.textContent = frame.file_name;
        card.appendChild(nameTag);
        // Drag events
        card.addEventListener("dragstart", (e) => {
            dragSrcId = frame.id;
            card.classList.add("dragging");
            e.dataTransfer.effectAllowed = "move";
        });
        card.addEventListener("dragend", () => card.classList.remove("dragging"));
        card.addEventListener("dragover", (e) => { e.preventDefault(); card.classList.add("drag-target"); });
        card.addEventListener("dragleave", () => card.classList.remove("drag-target"));
        card.addEventListener("drop", (e) => {
            e.preventDefault();
            card.classList.remove("drag-target");
            if (dragSrcId !== null && dragSrcId !== frame.id) {
                void reorderByDrop(dragSrcId, frame.id);
            }
        });
        grid.appendChild(card);
    });
    // Update count + button states
    must("frame-count").textContent = String(current.length);
    updateAnimControls();
}
function addSkeletonCard() {
    const grid = must("frame-grid");
    const id = `skeleton-${Date.now()}-${Math.random()}`;
    const card = document.createElement("div");
    card.className = "frame-card uploading";
    card.id = id;
    const img = document.createElement("img");
    img.className = "frame-img";
    card.appendChild(img);
    grid.appendChild(card);
    return id;
}
/* ═══════════════════════════════════════════════════════════════════════════
   DRAG-AND-DROP REORDER
═══════════════════════════════════════════════════════════════════════════ */
async function reorderByDrop(srcId, targetId) {
    const current = getActiveFrames();
    const srcIdx = current.findIndex((f) => f.id === srcId);
    const tgtIdx = current.findIndex((f) => f.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1)
        return;
    const reordered = [...current];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    setActiveFrames(reordered);
    renderFrameGrid();
    try {
        await fetch("/api/frames/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orderedIds: reordered.map((f) => f.id) })
        });
    }
    catch {
        showNotice("Could not save frame order.", "error");
    }
}
let saveTimer = null;
function persistStateDebounced() {
    if (saveTimer)
        window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
        persistState();
    }, 200);
}
let renderPending = false;
function scheduleRender() {
    if (renderPending)
        return;
    renderPending = true;
    window.requestAnimationFrame(() => {
        renderPending = false;
        render();
    });
}
let isBridgeConnected = false;
let discordPushTimer = null;
function pushToDiscordDebounced() {
    if (!isBridgeConnected || !state.applicationId.trim())
        return;
    if (discordPushTimer)
        window.clearTimeout(discordPushTimer);
    discordPushTimer = window.setTimeout(() => {
        void postPresence("update", true);
    }, 1000);
}
/* ═══════════════════════════════════════════════════════════════════════════
   PRESENCE FORM LOGIC
═══════════════════════════════════════════════════════════════════════════ */
function handleFieldChange(event) {
    const field = event.currentTarget;
    const key = field.dataset.field;
    let value = field.value;
    if (field instanceof HTMLInputElement && field.type === "checkbox")
        value = field.checked;
    if (["type", "display", "partySize", "partyMax"].includes(key))
        value = Number(field.value);
    state[key] = value;
    if (key === "partySize" && state.partySize > state.partyMax) {
        state.partyMax = state.partySize;
        setField("partyMax", state.partyMax);
    }
    if (must("autosave").checked) {
        persistStateDebounced();
        pushToDiscordDebounced();
    }
    scheduleRender();
}
function render() {
    updateCounters();
    updateConditionalFields();
    updatePreview();
    const id = state.applicationId.trim();
    must("assets-link").href = id
        ? `https://discord.com/developers/applications/${encodeURIComponent(id)}/rich-presence/assets`
        : "#";
}
function updateCounters() {
    for (const key of ["details", "state"]) {
        const counter = document.querySelector(`[data-counter-for="${key}"]`);
        if (counter)
            counter.textContent = `${state[key].length} / 128`;
    }
}
function updateConditionalFields() {
    const mode = state.timestampMode;
    const customEl = document.getElementById("custom-timestamps");
    if (customEl)
        customEl.classList.toggle("hidden", mode !== "custom");
    const customEndField = document.getElementById("custom-end-field");
    if (customEndField)
        customEndField.classList.toggle("hidden", !state.customTimestampEndEnabled);
    const offsetContainer = document.getElementById("timer-offset-container");
    const offsetLabel = document.getElementById("offset-label");
    if (offsetContainer) {
        const isOffset = mode === "elapsed-offset" || mode === "countdown";
        offsetContainer.classList.toggle("hidden", !isOffset);
        if (offsetLabel) {
            offsetLabel.textContent = mode === "countdown" ? "Minutes Remaining" : "Minutes Already Elapsed";
        }
    }
    const tzContainer = document.getElementById("country-tz-container");
    if (tzContainer) {
        tzContainer.classList.toggle("hidden", mode !== "country-timezone");
    }
    const partyDisabled = state.type !== 0;
    for (const key of ["partySize", "partyMax"]) {
        const input = fields.get(key);
        if (input)
            input.disabled = partyDisabled;
    }
    if (partyDisabled) {
        const pSize = fields.get("partySize");
        const pMax = fields.get("partyMax");
        if (pSize)
            pSize.value = "0";
        if (pMax)
            pMax.value = "0";
    }
}
let liveTimerInterval = null;
const sessionStartTime = Date.now();
function startLivePreviewClock() {
    if (liveTimerInterval)
        window.clearInterval(liveTimerInterval);
    liveTimerInterval = window.setInterval(() => {
        updateLiveTimestampText();
    }, 1000);
}
function updateLiveTimestampText() {
    const timeEl = document.getElementById("preview-time");
    if (!timeEl)
        return;
    const mode = state.timestampMode;
    if (mode === "none") {
        timeEl.classList.add("hidden");
        return;
    }
    timeEl.classList.remove("hidden");
    const now = Date.now();
    const offsetMins = Math.max(0, Number(state.timerOffsetMinutes) || 0);
    // Update country live clock badge if present
    const tzClock = document.getElementById("tz-live-clock");
    if (tzClock && mode === "country-timezone") {
        try {
            const tzTime = new Date().toLocaleTimeString("en-US", { timeZone: state.selectedTimezone || "UTC" });
            tzClock.textContent = `Current time: ${tzTime}`;
        }
        catch {
            tzClock.textContent = "";
        }
    }
    if (mode === "elapsed-offset") {
        const elapsedSeconds = Math.max(0, offsetMins * 60 + Math.floor((now - sessionStartTime) / 1000));
        timeEl.textContent = `🎮 ${formatDuration(elapsedSeconds)} elapsed`;
    }
    else if (mode === "countdown") {
        const remainingSeconds = Math.max(0, offsetMins * 60 - Math.floor((now - sessionStartTime) / 1000));
        timeEl.textContent = `⏳ ${formatDuration(remainingSeconds)} left`;
    }
    else if (mode === "country-timezone") {
        try {
            const tz = state.selectedTimezone || "UTC";
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: tz,
                hour: "numeric",
                minute: "numeric",
                second: "numeric",
                hour12: false
            }).formatToParts(new Date());
            const h = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
            const m = parts.find(p => p.type === "minute")?.value || "00";
            const s = parts.find(p => p.type === "second")?.value || "00";
            const hours12 = h % 12 || 12;
            const tzShort = tz.split("/").pop()?.replace(/_/g, " ") || tz;
            timeEl.textContent = `🌍 ${hours12}:${m}:${s} (${tzShort})`;
        }
        catch {
            timeEl.textContent = "🌍 Timezone active";
        }
    }
    else if (mode === "local-time") {
        const current = new Date();
        const hours12 = current.getHours() % 12 || 12;
        const mm = String(current.getMinutes()).padStart(2, "0");
        const ss = String(current.getSeconds()).padStart(2, "0");
        timeEl.textContent = `🕒 ${hours12}:${mm}:${ss} (12h Local)`;
    }
    else if (mode === "custom") {
        timeEl.textContent = state.customTimestampEndEnabled ? "📅 Custom range" : "📅 Custom timestamp";
    }
    else {
        // last-connection, startup, presence-update: live ticking counter
        const elapsedSeconds = Math.floor((now - sessionStartTime) / 1000);
        timeEl.textContent = `🎮 ${formatDuration(elapsedSeconds)} elapsed`;
    }
}
function formatDuration(totalSeconds) {
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const mm = String(minutes).padStart(2, "0");
    const ss = String(seconds).padStart(2, "0");
    if (hours > 0) {
        return `${hours}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
}
let cachedHealth = null;
const BAR_STYLES = {
    capsule: { fill: "▰", empty: "▱", wrap: ["", ""] },
    shade: { fill: "█", empty: "░", wrap: ["", ""] },
    medium: { fill: "█", empty: "▒", wrap: ["", ""] },
    square: { fill: "■", empty: "□", wrap: ["", ""] },
    circle: { fill: "●", empty: "○", wrap: ["", ""] },
    diamond: { fill: "◆", empty: "◇", wrap: ["", ""] },
    cyberpunk: { fill: "█", empty: "░", wrap: ["[", "]"] },
    line: { fill: "━", empty: "┈", wrap: ["", ""] },
    braille: { fill: "⣿", empty: "⣀", wrap: ["", ""] },
    ascii: { fill: "=", empty: " ", wrap: ["[", "]"] }
};
function renderBarClient(percentage, styleKey = "capsule", length = 10) {
    const s = BAR_STYLES[styleKey] || BAR_STYLES.capsule;
    const filled = Math.min(length, Math.max(0, Math.round((percentage / 100) * length)));
    const empty = length - filled;
    return s.wrap[0] + s.fill.repeat(filled) + s.empty.repeat(empty) + s.wrap[1];
}
function interpolateClientPlaceholders(val) {
    if (!val || !val.includes("{") || !cachedHealth?.ram)
        return val;
    const style = state.loadingBarStyle || "capsule";
    const ramBar = renderBarClient(cachedHealth.ram.percentage, style);
    const ramText = `${ramBar} ${cachedHealth.ram.percentage}% · RAM ${cachedHealth.ram.usedGb}/${cachedHealth.ram.totalGb} GB`;
    const cpuPct = cachedHealth.cpu?.usagePercent || 0;
    const cpuBar = renderBarClient(cpuPct, style);
    const cpuText = `${cpuBar} ${cpuPct}% · CPU ${cachedHealth.cpu?.cleanModel || cachedHealth.cpu?.model || "Processor"}`;
    const gpuPct = cachedHealth.gpu?.utilization || 0;
    const gpuBar = renderBarClient(gpuPct, style);
    const gpuText = `${gpuBar} ${gpuPct}% · GPU ${cachedHealth.gpu?.shortName || "GPU"}`;
    return val
        .replace(/{cpu}/gi, cpuText)
        .replace(/{cpu_bar}/gi, cpuBar)
        .replace(/{cpu_pct}/gi, `${cpuPct}%`)
        .replace(/{gpu}/gi, gpuText)
        .replace(/{gpu_bar}/gi, gpuBar)
        .replace(/{gpu_pct}/gi, `${gpuPct}%`)
        .replace(/{server_health}/gi, ramText)
        .replace(/{ram}/gi, ramText)
        .replace(/{ram_bar}/gi, ramBar)
        .replace(/{ram_pct}/gi, `${cachedHealth.ram.percentage}%`)
        .replace(/{ram_used}/gi, `${cachedHealth.ram.usedGb} GB`)
        .replace(/{ram_total}/gi, `${cachedHealth.ram.totalGb} GB`)
        .replace(/{hostname}/gi, cachedHealth.host?.hostname || "")
        .replace(/{uptime}/gi, cachedHealth.host?.uptimeFormatted || "")
        .replace(/{cpu_cores}/gi, `${cachedHealth.cpu?.cores || 0} Cores`);
}
async function fetchSystemHealth() {
    try {
        const style = state.loadingBarStyle || "capsule";
        const res = await fetch(`/api/system/health?style=${encodeURIComponent(style)}`);
        if (!res.ok)
            return;
        const data = await res.json();
        cachedHealth = data;
        // Update topbar pill
        const topbarText = document.getElementById("topbar-health-text");
        if (topbarText && data.ram) {
            topbarText.textContent = data.ram.formatted;
        }
        // Update Tab 06 UI elements
        const heroBar = document.getElementById("health-hero-bar");
        if (heroBar && data.ram)
            heroBar.textContent = data.ram.formatted;
        const meterFill = document.getElementById("health-meter-fill");
        if (meterFill && data.ram)
            meterFill.style.width = `${data.ram.percentage}%`;
        const ramUsed = document.getElementById("metric-ram-used");
        if (ramUsed && data.ram)
            ramUsed.textContent = `${data.ram.usedGb} GB`;
        const ramFree = document.getElementById("metric-ram-free");
        if (ramFree && data.ram)
            ramFree.textContent = `${data.ram.freeGb} GB`;
        const ramTotal = document.getElementById("metric-ram-total");
        if (ramTotal && data.ram)
            ramTotal.textContent = `${data.ram.totalGb} GB`;
        const ramPct = document.getElementById("metric-ram-pct");
        if (ramPct && data.ram)
            ramPct.textContent = `${data.ram.percentage}%`;
        const hostname = document.getElementById("spec-hostname");
        if (hostname && data.host)
            hostname.textContent = data.host.hostname;
        const platform = document.getElementById("spec-platform");
        if (platform && data.host)
            platform.textContent = data.host.platform;
        const uptime = document.getElementById("spec-uptime");
        if (uptime && data.host)
            uptime.textContent = data.host.uptimeFormatted;
        const nodeVer = document.getElementById("spec-node");
        if (nodeVer && data.process)
            nodeVer.textContent = `${data.process.nodeVersion} (Heap: ${data.process.heapUsedMb}MB)`;
        const cpuModel = document.getElementById("spec-cpu-model");
        if (cpuModel && data.cpu)
            cpuModel.textContent = data.cpu.model;
        const cpuCores = document.getElementById("spec-cpu-cores");
        if (cpuCores && data.cpu)
            cpuCores.textContent = `${data.cpu.cores} Cores`;
        const cpuLoad = document.getElementById("spec-cpu-load");
        if (cpuLoad && data.cpu)
            cpuLoad.textContent = `${data.cpu.usagePercent}%`;
        const gpuName = document.getElementById("spec-gpu-name");
        if (gpuName && data.gpu)
            gpuName.textContent = data.gpu.shortName || data.gpu.name;
        const gpuLoad = document.getElementById("spec-gpu-load");
        if (gpuLoad && data.gpu)
            gpuLoad.textContent = `${data.gpu.utilization}% (${data.gpu.usedGb}/${data.gpu.totalGb} GB)`;
        // Always re-render preview with latest stats
        updatePreview();
    }
    catch (err) {
        console.warn("Could not fetch server health:", err);
    }
}
function startSystemHealthPolling() {
    void fetchSystemHealth();
    window.setInterval(() => {
        void fetchSystemHealth();
    }, 3000);
}
function updatePreview() {
    const type = Number(state.type);
    text("preview-type", defaultNames[type] || "Playing");
    text("preview-name", state.name || "CustomRP");
    const style = state.loadingBarStyle || "capsule";
    // Dynamic bar re-renders using client's chosen style
    let cpuFormatted = cachedHealth?.cpu?.formatted || "⚡ CPU Usage";
    if (cachedHealth?.cpu) {
        const cBar = renderBarClient(cachedHealth.cpu.usagePercent, style);
        cpuFormatted = `${cBar} ${cachedHealth.cpu.usagePercent}% · CPU ${cachedHealth.cpu.cleanModel || cachedHealth.cpu.model}`;
    }
    let gpuFormatted = cachedHealth?.gpu?.formatted || "🎮 GPU Usage";
    if (cachedHealth?.gpu) {
        const gBar = renderBarClient(cachedHealth.gpu.utilization, style);
        gpuFormatted = `${gBar} ${cachedHealth.gpu.utilization}% · GPU ${cachedHealth.gpu.shortName}`;
    }
    let ramFormatted = cachedHealth?.ram?.formatted || "💾 RAM Usage";
    if (cachedHealth?.ram) {
        const rBar = renderBarClient(cachedHealth.ram.percentage, style);
        ramFormatted = `${rBar} ${cachedHealth.ram.percentage}% · RAM ${cachedHealth.ram.usedGb}/${cachedHealth.ram.totalGb} GB`;
    }
    // Update Bar Style preview badge
    const barStylePreview = document.getElementById("bar-style-preview");
    if (barStylePreview) {
        barStylePreview.textContent = renderBarClient(75, style);
    }
    // Update Hero & topbar with latest chosen style
    const heroBar = document.getElementById("health-hero-bar");
    if (heroBar && cachedHealth?.ram) {
        heroBar.textContent = ramFormatted;
    }
    const topbarText = document.getElementById("topbar-health-text");
    if (topbarText && cachedHealth?.ram) {
        topbarText.textContent = ramFormatted;
    }
    // Line 1 Resolution
    let line1Text = "";
    const l1Mode = state.line1Mode || "cpu";
    if (l1Mode === "cpu") {
        line1Text = cpuFormatted;
    }
    else if (l1Mode === "gpu") {
        line1Text = gpuFormatted;
    }
    else if (l1Mode === "ram") {
        line1Text = ramFormatted;
    }
    else if (l1Mode === "custom") {
        line1Text = interpolateClientPlaceholders(state.details || "");
    }
    else if (l1Mode === "none") {
        line1Text = "";
    }
    // Line 2 Resolution
    let line2Text = "";
    const l2Mode = state.line2Mode || "ram";
    if (l2Mode === "ram") {
        line2Text = ramFormatted;
    }
    else if (l2Mode === "cpu") {
        line2Text = cpuFormatted;
    }
    else if (l2Mode === "gpu") {
        line2Text = gpuFormatted;
    }
    else if (l2Mode === "custom") {
        line2Text = interpolateClientPlaceholders(state.state || "");
    }
    else if (l2Mode === "none") {
        line2Text = "";
    }
    const pDetails = document.getElementById("preview-details");
    if (pDetails) {
        pDetails.textContent = line1Text || "No details";
        pDetails.classList.toggle("hidden", !line1Text && l1Mode === "none");
    }
    const pState = document.getElementById("preview-state");
    if (pState) {
        pState.textContent = line2Text || "No state";
        pState.classList.toggle("hidden", !line2Text && l2Mode === "none");
    }
    // Update badges & summary boxes
    const b1 = document.getElementById("line1-live-badge");
    if (b1)
        b1.textContent = line1Text ? `Active: ${line1Text}` : "(Hidden)";
    const b2 = document.getElementById("line2-live-badge");
    if (b2)
        b2.textContent = line2Text ? `Active: ${line2Text}` : "(Hidden)";
    const s1 = document.getElementById("line1-summary-box");
    if (s1)
        s1.textContent = line1Text || "(Empty - Line 1 Hidden)";
    const s2 = document.getElementById("line2-summary-box");
    if (s2)
        s2.textContent = line2Text || "(Empty - Line 2 Hidden)";
    // Toggle custom text input containers
    const l1Container = document.getElementById("line1-custom-container");
    if (l1Container)
        l1Container.classList.toggle("hidden", l1Mode !== "custom");
    const l2Container = document.getElementById("line2-custom-container");
    if (l2Container)
        l2Container.classList.toggle("hidden", l2Mode !== "custom");
    updateLiveTimestampText();
    const party = document.querySelector("#preview-party");
    if (party) {
        const showParty = type === 0 && state.partySize > 0 && state.partyMax > 0;
        party.classList.toggle("hidden", !showParty);
        party.querySelector("span").textContent = `${state.partySize} / ${state.partyMax}`;
    }
    // Only update static art if that target is NOT animating
    if (largeFrames.length < 2) {
        updateArt("large-art", state.largeKey);
    }
    if (smallFrames.length < 2) {
        updateArt("small-art", state.smallKey);
    }
    const buttons = must("preview-buttons");
    buttons.innerHTML = "";
    for (const [label, url] of [[state.button1Text, state.button1Url], [state.button2Text, state.button2Url]]) {
        const trimmedLabel = label ? label.trim() : "";
        const trimmedUrl = url ? url.trim() : "";
        if (!trimmedLabel && !trimmedUrl)
            continue;
        const button = document.createElement("a");
        button.className = "preview-button";
        button.textContent = trimmedLabel || "Button";
        if (trimmedUrl) {
            const normalized = /^https?:\/\//i.test(trimmedUrl) ? trimmedUrl : `https://${trimmedUrl}`;
            button.href = normalized;
            button.target = "_blank";
            button.rel = "noopener noreferrer";
            button.title = `Opens ${normalized}`;
        }
        else {
            button.title = "Enter a URL in Section 06 to make this button clickable";
            button.classList.add("preview-button-pending");
        }
        buttons.append(button);
    }
}
function updateArt(id, value) {
    const art = must(id);
    const isUrl = /^https?:\/\//i.test(value.trim());
    art.classList.toggle("has-image", isUrl);
    art.style.backgroundImage = isUrl ? `url("${CSS.escape(value.trim())}")` : "";
}
function timestampLabel() {
    switch (state.timestampMode) {
        case "local-time": return "Local time · live";
        case "custom": return state.customTimestampEndEnabled ? "Custom range" : "Custom timestamp";
        case "presence-update": return "00:00 elapsed";
        case "startup": return "Since startup";
        default: return "Since connection";
    }
}
async function postPresence(action, silent = false) {
    if (!state.applicationId.trim()) {
        if (!silent) {
            showNotice("Add your Discord application ID before connecting.", "error");
            must("applicationId").focus();
        }
        return;
    }
    if (!silent) {
        showNotice(action === "connect" ? "Connecting to Discord…" : "Updating presence in Discord…");
    }
    try {
        const response = await fetch(`/api/presence/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(state)
        });
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error || "The local bridge could not complete the request.");
        isBridgeConnected = true;
        if (!silent) {
            showNotice(action === "connect"
                ? "Connected — your presence & buttons are live in Discord!"
                : "Presence & buttons updated live in Discord!", "success");
        }
        // If frames exist, ensure the animation cycling is active on Discord & in preview
        const intervalMs = getIntervalMs();
        if (largeFrames.length >= 2) {
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ target: "large", urls: largeFrames.map((f) => f.url), intervalMs })
            });
        }
        if (smallFrames.length >= 2) {
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ target: "small", urls: smallFrames.map((f) => f.url), intervalMs })
            });
        }
        startOrUpdatePreviews();
        await refreshStatus();
    }
    catch (error) {
        if (!silent) {
            showNotice(error instanceof Error ? error.message : "Could not reach the local bridge.", "error");
        }
        await refreshStatus();
    }
}
async function disconnect() {
    stopAnimPreview();
    isBridgeConnected = false;
    sessionStorage.setItem("customrp-manual-disconnect", "true");
    try {
        await fetch("/api/animation/stop", { method: "POST" });
        await fetch("/api/presence/disconnect", { method: "POST" });
        showNotice("Disconnected from Discord. Click 'Connect Discord' when you want to reconnect.", "success");
    }
    catch {
        showNotice("The local bridge is not reachable.", "error");
    }
    await refreshStatus();
}
async function refreshStatus() {
    try {
        const response = await fetch("/api/status");
        const status = await response.json();
        isBridgeConnected = Boolean(status.connected);
        must("bridge-dot").classList.toggle("connected", status.connected);
        text("bridge-copy", status.connected ? `Connected · ${status.applicationId || "Discord"}` : "Waiting for Discord");
    }
    catch {
        isBridgeConnected = false;
        text("bridge-copy", "Start the local server first");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   PERSISTENCE & DATABASE SYNC
═══════════════════════════════════════════════════════════════════════════ */
function persistState() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }
    catch { /* ignore */ }
    void saveStateToDatabase();
}
async function saveStateToDatabase() {
    try {
        await fetch("/api/presence/save", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(state)
        });
    }
    catch (err) {
        console.warn("Could not save presence to database:", err);
    }
}
function loadState(fallback) {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (fallback.applicationId && !stored?.applicationId) {
            return { ...fallback, ...stored, applicationId: fallback.applicationId };
        }
        return { ...fallback, ...stored, applicationId: stored?.applicationId || fallback.applicationId };
    }
    catch {
        return fallback;
    }
}
function writeStateToForm() {
    for (const [key, field] of fields) {
        const value = state[key];
        if (field instanceof HTMLInputElement && field.type === "checkbox")
            field.checked = Boolean(value);
        else
            field.value = String(value ?? "");
    }
}
function setField(key, value) {
    const field = fields.get(String(key));
    if (!field)
        return;
    if (field instanceof HTMLInputElement && field.type === "checkbox")
        field.checked = Boolean(value);
    else
        field.value = String(value);
}
function resetEditor() {
    if (!confirm("Reset the editor to its default values?"))
        return;
    state = serverDefault ? { ...serverDefault } : state;
    try {
        localStorage.removeItem(STORAGE_KEY);
    }
    catch { /* ignore */ }
    writeStateToForm();
    render();
    void saveStateToDatabase();
    showNotice("Editor reset.", "success");
}
/* ═══════════════════════════════════════════════════════════════════════════
   PRESET IMPORT / EXPORT
═══════════════════════════════════════════════════════════════════════════ */
function exportPreset() {
    const xml = buildLegacyXml(state);
    const blob = new Blob([xml], { type: "application/xml" });
    download(blob, "customrp-preset.crp");
    showNotice("Preset exported as a legacy-compatible .crp file.", "success");
}
async function importPreset(event) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file)
        return;
    try {
        const content = await file.text();
        const imported = content.trim().startsWith("<") ? parseLegacyXml(content) : parseJsonPreset(content);
        state = { ...state, ...imported };
        writeStateToForm();
        persistState();
        render();
        showNotice("Preset imported.", "success");
    }
    catch (error) {
        showNotice(error instanceof Error ? error.message : "That preset could not be read.", "error");
    }
    finally {
        input.value = "";
    }
}
function parseJsonPreset(content) {
    const raw = JSON.parse(content);
    return normalizePreset(raw);
}
function parseLegacyXml(content) {
    const xml = new DOMParser().parseFromString(content, "application/xml");
    if (xml.querySelector("parsererror"))
        throw new Error("This preset contains invalid XML.");
    const value = (name) => xml.querySelector(name)?.textContent?.trim() || "";
    return normalizePreset({
        ID: value("ID"), Type: value("Type"), Display: value("Display"), Name: value("Name"),
        Details: value("Details"), DetailsURL: value("DetailsURL"), State: value("State"),
        StateURL: value("StateURL"), PartySize: value("PartySize"), PartyMax: value("PartyMax"),
        Timestamps: value("Timestamps"), CustomTimestamp: value("CustomTimestamp"),
        CustomTimestampEndEnabled: value("CustomTimestampEndEnabled"),
        CustomTimestampEnd: value("CustomTimestampEnd"), LargeKey: value("LargeKey"),
        LargeText: value("LargeText"), LargeURL: value("LargeURL"), SmallKey: value("SmallKey"),
        SmallText: value("SmallText"), SmallURL: value("SmallURL"),
        Button1Text: value("Button1Text"), Button1URL: value("Button1URL"),
        Button2Text: value("Button2Text"), Button2URL: value("Button2URL")
    });
}
function normalizePreset(raw) {
    const textValue = (...keys) => {
        for (const key of keys)
            if (raw[key] !== undefined && raw[key] !== null)
                return String(raw[key]);
        return "";
    };
    const type = Number(textValue("type", "Type"));
    const display = Number(textValue("display", "Display"));
    const timestamps = Number(textValue("timestamps", "Timestamps"));
    const timestampMap = ["last-connection", "startup", "local-time", "custom", "presence-update"];
    return {
        applicationId: textValue("applicationId", "ID"),
        type: [0, 2, 3, 5].includes(type) ? type : 0,
        display: [0, 1, 2].includes(display) ? display : 0,
        name: textValue("name", "Name"), details: textValue("details", "Details"),
        detailsUrl: textValue("detailsUrl", "DetailsURL"), state: textValue("state", "State"),
        stateUrl: textValue("stateUrl", "StateURL"),
        partySize: Number(textValue("partySize", "PartySize")) || 0,
        partyMax: Number(textValue("partyMax", "PartyMax")) || 0,
        timestampMode: timestampMap[timestamps] || "last-connection",
        customTimestampStart: toLocalDateTime(textValue("customTimestampStart", "CustomTimestamp")),
        customTimestampEndEnabled: textValue("customTimestampEndEnabled", "CustomTimestampEndEnabled").toLowerCase() === "true",
        customTimestampEnd: toLocalDateTime(textValue("customTimestampEnd", "CustomTimestampEnd")),
        largeKey: textValue("largeKey", "LargeKey"), largeText: textValue("largeText", "LargeText"),
        largeUrl: textValue("largeUrl", "LargeURL"), smallKey: textValue("smallKey", "SmallKey"),
        smallText: textValue("smallText", "SmallText"), smallUrl: textValue("smallUrl", "SmallURL"),
        button1Text: textValue("button1Text", "Button1Text"), button1Url: textValue("button1Url", "Button1URL"),
        button2Text: textValue("button2Text", "Button2Text"), button2Url: textValue("button2Url", "Button2URL")
    };
}
function buildLegacyXml(config) {
    const f = {
        ID: config.applicationId, Type: config.type, Display: config.display, Name: config.name,
        Details: config.details, DetailsURL: config.detailsUrl, State: config.state,
        StateURL: config.stateUrl, PartySize: config.partySize, PartyMax: config.partyMax,
        Timestamps: ["last-connection", "startup", "local-time", "custom", "presence-update"].indexOf(config.timestampMode),
        CustomTimestamp: config.customTimestampStart, CustomTimestampEndEnabled: config.customTimestampEndEnabled,
        CustomTimestampEnd: config.customTimestampEnd, LargeKey: config.largeKey, LargeText: config.largeText,
        LargeURL: config.largeUrl, SmallKey: config.smallKey, SmallText: config.smallText,
        SmallURL: config.smallUrl, Button1Text: config.button1Text, Button1URL: config.button1Url,
        Button2Text: config.button2Text, Button2URL: config.button2Url
    };
    const body = Object.entries(f).map(([key, value]) => `  <${key}>${escapeXml(String(value))}</${key}>`).join("\n");
    return `<?xml version="1.0" encoding="utf-8"?>\n<Preset xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">\n${body}\n</Preset>\n`;
}
/* ═══════════════════════════════════════════════════════════════════════════
   UTILITIES
═══════════════════════════════════════════════════════════════════════════ */
function toLocalDateTime(value) {
    if (!value)
        return new Date().toISOString().slice(0, 16);
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value.slice(0, 16) : new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
function escapeXml(value) {
    return value.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", "\"": "&quot;" })[c] || c);
}
function download(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
}
function showNotice(message, kind = "") {
    notice.textContent = message;
    notice.className = `notice show ${kind}`;
    if (!kind)
        window.setTimeout(() => { notice.className = "notice"; }, 5000);
}
function text(id, value) {
    const el = document.getElementById(id);
    if (el)
        el.textContent = value;
}
function must(id) {
    const el = document.getElementById(id);
    if (!el)
        throw new Error(`Missing element #${id}`);
    return el;
}
export {};
