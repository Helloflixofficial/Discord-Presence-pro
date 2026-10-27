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
let frames = [];
let animationActive = false;
let animPreviewTimer = null;
let animPreviewIndex = 0;
// Drag-and-drop reorder
let dragSrcId = null;
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
    await refreshStatus();
    await loadFrames();
}
/* ═══════════════════════════════════════════════════════════════════════════
   PRESENCE FORM BINDINGS
═══════════════════════════════════════════════════════════════════════════ */
function bindActions() {
    must("connect").addEventListener("click", () => void postPresence("connect"));
    must("quick-update").addEventListener("click", () => void postPresence("update"));
    must("disconnect").addEventListener("click", () => void disconnect());
    must("export-preset").addEventListener("click", exportPreset);
    must("import-preset").addEventListener("click", () => must("preset-file").click());
    must("preset-file").addEventListener("change", (e) => void importPreset(e));
    must("reset-form").addEventListener("click", resetEditor);
    must("assets-link").addEventListener("click", (e) => { if (!state.applicationId)
        e.preventDefault(); });
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
    intervalInput.addEventListener("change", () => {
        if (animationActive && frames.length >= 2) {
            startAnimPreview();
            const intervalMs = Number(intervalInput.value) || 200;
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: frames.map((f) => f.url), intervalMs })
            });
        }
    });
}
function getIntervalMs() {
    const input = document.getElementById("anim-interval");
    return Number(input?.value) || 200;
}
/* ═══════════════════════════════════════════════════════════════════════════
   LOAD FRAMES FROM SERVER
═══════════════════════════════════════════════════════════════════════════ */
async function loadFrames() {
    try {
        const res = await fetch("/api/frames");
        const data = await res.json();
        frames = data.frames;
        renderFrameGrid();
        if (frames.length >= 2) {
            animationActive = true;
            updateAnimControls();
            startAnimPreview();
            const intervalMs = Number(document.getElementById("anim-interval").value) || 200;
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: frames.map((f) => f.url), intervalMs })
            });
        }
    }
    catch {
        showNotice("Could not load animation frames from server.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   UPLOAD IMAGE FILES
═══════════════════════════════════════════════════════════════════════════ */
async function uploadImageFiles(files) {
    const maxFrames = 20;
    const available = maxFrames - frames.length;
    if (available <= 0) {
        showNotice(`Maximum ${maxFrames} frames reached. Delete some before adding more.`, "error");
        return;
    }
    const toUpload = files.slice(0, available);
    if (files.length > available) {
        showNotice(`Only ${available} slot(s) free. Uploading first ${available} files.`, "");
    }
    // Show skeleton cards
    const skeletonIds = toUpload.map(() => addSkeletonCard());
    const formData = new FormData();
    toUpload.forEach((f) => formData.append("files", f));
    try {
        const res = await fetch("/api/frames/upload", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "Upload failed.");
        // Remove skeletons and add real frames
        skeletonIds.forEach((id) => document.getElementById(id)?.remove());
        frames.push(...(data.frames ?? []));
        renderFrameGrid();
        // Auto-start animation if >= 2 frames
        if (frames.length >= 2) {
            animationActive = true;
            updateAnimControls();
            startAnimPreview();
            const intervalMs = getIntervalMs();
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: frames.map((f) => f.url), intervalMs })
            });
        }
        showNotice(`${data.frames?.length ?? 0} frame(s) uploaded successfully.`, "success");
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
    showNotice("Extracting ZIP and uploading frames…");
    const formData = new FormData();
    formData.append("file", file);
    try {
        const res = await fetch("/api/frames/upload-zip", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "ZIP upload failed.");
        frames.push(...(data.frames ?? []));
        renderFrameGrid();
        // Auto-start animation if >= 2 frames
        if (frames.length >= 2) {
            animationActive = true;
            updateAnimControls();
            startAnimPreview();
            const intervalMs = getIntervalMs();
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: frames.map((f) => f.url), intervalMs })
            });
        }
        showNotice(`${data.count ?? data.frames?.length ?? 0} frame(s) imported from ZIP.`, "success");
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
        frames = frames.filter((f) => f.id !== id);
        renderFrameGrid();
        if (frames.length < 2 && animationActive) {
            await stopAnimation();
        }
    }
    catch {
        showNotice("Could not delete frame.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   CLEAR ALL
═══════════════════════════════════════════════════════════════════════════ */
async function clearAllFrames() {
    if (!confirm("Delete all animation frames? This cannot be undone."))
        return;
    await stopAnimation();
    try {
        await fetch("/api/frames", { method: "DELETE" });
        frames = [];
        renderFrameGrid();
        showNotice("All frames cleared.", "success");
    }
    catch {
        showNotice("Could not clear frames.", "error");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   ANIMATION CONTROLS
═══════════════════════════════════════════════════════════════════════════ */
async function startAnimation() {
    if (frames.length < 2) {
        showNotice("Add at least 2 frames to start an animation.", "error");
        return;
    }
    const intervalMs = getIntervalMs();
    const urls = frames.map((f) => f.url);
    try {
        const res = await fetch("/api/animation/start", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ urls, intervalMs })
        });
        const data = await res.json();
        if (!res.ok || data.error)
            throw new Error(data.error ?? "Failed to start animation.");
        animationActive = true;
        updateAnimControls();
        startAnimPreview();
        showNotice(`Animation started — ${frames.length} frames cycling at ${intervalMs}ms.`, "success");
    }
    catch (err) {
        showNotice(err instanceof Error ? err.message : "Could not start animation.", "error");
    }
}
async function stopAnimation() {
    stopAnimPreview();
    try {
        await fetch("/api/animation/stop", { method: "POST" });
    }
    catch { /* best-effort */ }
    animationActive = false;
    updateAnimControls();
}
function updateAnimControls() {
    must("anim-play-btn").disabled = animationActive || frames.length < 2;
    must("anim-stop-btn").disabled = !animationActive;
}
/* ═══════════════════════════════════════════════════════════════════════════
   LOCAL ANIMATION PREVIEW (in the Discord mock + strip)
═══════════════════════════════════════════════════════════════════════════ */
function startAnimPreview() {
    stopAnimPreview();
    const intervalMs = getIntervalMs();
    animPreviewIndex = 0;
    const strip = must("anim-preview-strip");
    strip.classList.remove("hidden");
    // Build strip thumbnails
    const stripFrames = must("anim-strip-frames");
    stripFrames.innerHTML = "";
    frames.forEach((f, i) => {
        const div = document.createElement("div");
        div.className = "strip-frame";
        div.id = `strip-${i}`;
        const img = document.createElement("img");
        img.src = f.url;
        img.alt = f.file_name;
        div.appendChild(img);
        stripFrames.appendChild(div);
    });
    must("anim-strip-count").textContent = String(frames.length);
    animPreviewTimer = window.setInterval(() => {
        tickAnimPreview();
    }, intervalMs);
    tickAnimPreview(); // immediate first tick
}
function tickAnimPreview() {
    if (frames.length === 0)
        return;
    animPreviewIndex = (animPreviewIndex + 1) % frames.length;
    const url = frames[animPreviewIndex].url;
    // Update large art in preview
    const art = must("large-art");
    art.classList.add("has-image");
    art.style.backgroundImage = `url("${CSS.escape(url)}")`;
    // Highlight strip frame
    document.querySelectorAll(".strip-frame").forEach((el) => el.classList.remove("active"));
    document.getElementById(`strip-${animPreviewIndex}`)?.classList.add("active");
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
    frames.forEach((frame, index) => {
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
    must("frame-count").textContent = String(frames.length);
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
    const srcIdx = frames.findIndex((f) => f.id === srcId);
    const tgtIdx = frames.findIndex((f) => f.id === targetId);
    if (srcIdx === -1 || tgtIdx === -1)
        return;
    const reordered = [...frames];
    const [moved] = reordered.splice(srcIdx, 1);
    reordered.splice(tgtIdx, 0, moved);
    frames = reordered;
    renderFrameGrid();
    try {
        await fetch("/api/frames/reorder", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ orderedIds: frames.map((f) => f.id) })
        });
    }
    catch {
        showNotice("Could not save frame order.", "error");
    }
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
    if (must("autosave").checked)
        persistState();
    render();
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
    must("custom-timestamps").classList.toggle("hidden", state.timestampMode !== "custom");
    must("custom-end-field").classList.toggle("hidden", !state.customTimestampEndEnabled);
    const partyDisabled = state.type !== 0;
    for (const key of ["partySize", "partyMax"]) {
        const input = fields.get(key);
        if (input)
            input.disabled = partyDisabled;
    }
    if (partyDisabled) {
        must("partySize").value = "0";
        must("partyMax").value = "0";
    }
}
function updatePreview() {
    const type = Number(state.type);
    text("preview-type", defaultNames[type] || "Playing");
    text("preview-name", state.name || "CustomRP");
    text("preview-details", state.details || "Your details appear here");
    text("preview-state", state.state || "Your state appears here");
    text("preview-time", timestampLabel());
    const party = document.querySelector("#preview-party");
    if (party) {
        const showParty = type === 0 && state.partySize > 0 && state.partyMax > 0;
        party.classList.toggle("hidden", !showParty);
        party.querySelector("span").textContent = `${state.partySize} / ${state.partyMax}`;
    }
    // Only update static art if animation is NOT active
    if (!animationActive) {
        updateArt("large-art", state.largeKey);
    }
    updateArt("small-art", state.smallKey);
    const buttons = must("preview-buttons");
    buttons.innerHTML = "";
    for (const [label, url] of [[state.button1Text, state.button1Url], [state.button2Text, state.button2Url]]) {
        if (!label || !url)
            continue;
        const button = document.createElement("div");
        button.className = "preview-button";
        button.textContent = label;
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
async function postPresence(action) {
    if (!state.applicationId.trim()) {
        showNotice("Add your Discord application ID before connecting.", "error");
        must("applicationId").focus();
        return;
    }
    showNotice(action === "connect" ? "Connecting to Discord…" : "Updating presence…");
    try {
        const response = await fetch(`/api/presence/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(state)
        });
        const data = await response.json();
        if (!response.ok)
            throw new Error(data.error || "The local bridge could not complete the request.");
        showNotice(action === "connect" ? "Connected — your presence is live in Discord." : "Presence updated.", "success");
        // If frames exist, ensure the animation cycling is active on Discord & in preview
        if (frames.length >= 2) {
            const intervalMs = Number(document.getElementById("anim-interval").value) || 200;
            void fetch("/api/animation/start", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ urls: frames.map((f) => f.url), intervalMs })
            });
            animationActive = true;
            updateAnimControls();
            startAnimPreview();
        }
        await refreshStatus();
    }
    catch (error) {
        showNotice(error instanceof Error ? error.message : "Could not reach the local bridge.", "error");
        await refreshStatus();
    }
}
async function disconnect() {
    await stopAnimation();
    try {
        await fetch("/api/presence/disconnect", { method: "POST" });
        showNotice("Disconnected from Discord.", "success");
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
        must("bridge-dot").classList.toggle("connected", status.connected);
        text("bridge-copy", status.connected ? `Connected · ${status.applicationId || "Discord"}` : "Waiting for Discord");
    }
    catch {
        text("bridge-copy", "Start the local server first");
    }
}
/* ═══════════════════════════════════════════════════════════════════════════
   PERSISTENCE
═══════════════════════════════════════════════════════════════════════════ */
function persistState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
function loadState(fallback) {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
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
    localStorage.removeItem(STORAGE_KEY);
    writeStateToForm();
    render();
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
