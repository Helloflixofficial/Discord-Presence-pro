/**
 * framesRouter.ts
 * Express router for animation frame CRUD + UploadThing upload.
 * Supports:
 *   GET    /api/frames              → list all frames in order
 *   POST   /api/frames/upload       → upload one or more image files (multipart)
 *   POST   /api/frames/upload-zip   → upload a ZIP of images
 *   DELETE /api/frames/:id          → delete one frame (also removes from UploadThing)
 *   POST   /api/frames/reorder      → reorder frames { orderedIds: number[] }
 *   DELETE /api/frames              → clear all frames
 */
import express from "express";
import multer from "multer";
import AdmZip from "adm-zip";
import { getFrames, insertFrame, deleteFrame, reorderFrames, clearFrames, type FrameTarget } from "./db.js";
import { uploadBuffer, deleteByKey } from "./uploadClient.js";
import { pool } from "./db.js";
import { bridge } from "./server.js";

const router = express.Router();

function parseTarget(val: unknown): FrameTarget {
  return val === "small" ? "small" : "large";
}

// In-memory image buffer cache for instant zero-latency serving and ad-blocker immunity
const imageCache = new Map<number, { buffer: Buffer; contentType: string }>();

/** Pre-warm in-memory cache on startup for lightning-fast mobile and desktop loading */
export async function prewarmFramesCache(): Promise<void> {
  try {
    const result = await pool.query("SELECT id, url, file_name FROM animation_frames ORDER BY position ASC LIMIT 50");
    for (const row of result.rows as { id: number; url: string; file_name: string }[]) {
      if (imageCache.has(row.id)) continue;
      try {
        const upstream = await fetch(row.url);
        if (upstream.ok) {
          const arrayBuffer = await upstream.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          const contentType = upstream.headers.get("content-type") || guessMime(row.file_name);
          imageCache.set(row.id, { buffer, contentType });
        }
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

// Keep files in memory (max 50 MB total per request)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 25 },
  fileFilter: (_req, file, cb) => {
    const allowed = ["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"];
    cb(null, allowed.includes(file.mimetype));
  },
});

const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024, files: 1 },
});

/* ─── GET /api/frames/:id/image (Local Proxy to bypass ad-blockers) ──────── */
router.get("/:id/image", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).send("Invalid frame ID.");
      return;
    }

    // Fast memory cache hit
    if (imageCache.has(id)) {
      const cached = imageCache.get(id)!;
      res.setHeader("Content-Type", cached.contentType);
      res.setHeader("Cache-Control", "public, max-age=86400, immutable");
      res.send(cached.buffer);
      return;
    }

    const result = await pool.query("SELECT url, file_name FROM animation_frames WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      res.status(404).send("Frame not found.");
      return;
    }

    const { url, file_name } = result.rows[0] as { url: string; file_name: string };
    const upstream = await fetch(url);
    if (!upstream.ok) {
      res.status(upstream.status).send("Failed to retrieve image upstream.");
      return;
    }

    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const contentType = upstream.headers.get("content-type") || guessMime(file_name);

    if (imageCache.size > 150) {
      const oldest = imageCache.keys().next().value;
      if (oldest !== undefined) imageCache.delete(oldest);
    }
    imageCache.set(id, { buffer, contentType });

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400, immutable");
    res.send(buffer);
  } catch (err) {
    res.status(500).send(String(err));
  }
});

/* ─── GET /api/frames/proxy (General image proxy for external URLs) ─────── */
router.get("/proxy", async (req, res) => {
  try {
    const rawUrl = req.query.url;
    if (typeof rawUrl !== "string" || !rawUrl.startsWith("http")) {
      res.status(400).send("Invalid URL.");
      return;
    }

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      res.status(400).send("Malformed URL.");
      return;
    }

    // SSRF Protection: Block private network addresses (localhost, 127.0.0.1, 10.x, 192.168.x, 169.254.x, ::1)
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname === "0.0.0.0" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(hostname)
    ) {
      res.status(403).send("Access to local/private addresses is forbidden.");
      return;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000); // 6s timeout to prevent hanging connections

    const upstream = await fetch(rawUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "CustomRP-Studio/1.0",
        "Accept": "image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      res.status(upstream.status).send("Failed to retrieve external image.");
      return;
    }
    const arrayBuffer = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("content-type") || "image/png";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    res.status(500).send(err instanceof Error && err.name === "AbortError" ? "Image fetch timed out" : String(err));
  }
});

/* ─── GET /api/frames ──────────────────────────────────────────────────── */
router.get("/", async (req, res) => {
  try {
    const targetParam = req.query.target as string | undefined;
    const target = targetParam ? parseTarget(targetParam) : undefined;
    const frames = await getFrames(target);
    res.json({ frames });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── POST /api/frames/upload (multipart images) ──────────────────────── */
router.post("/upload", upload.array("files", 25), async (req, res) => {
  try {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: "No image files provided." });
      return;
    }

    const target = parseTarget(req.body.target || req.query.target);
    const existing = await getFrames(target);
    let position = existing.length;

    const inserted = [];
    for (const file of files) {
      const { url, key } = await uploadBuffer(file.buffer, file.originalname, file.mimetype);
      const frame = await insertFrame(url, key, file.originalname, position++, target);
      imageCache.set(frame.id, { buffer: file.buffer, contentType: file.mimetype });
      inserted.push(frame);
    }

    void bridge.syncFramesFromDb();
    res.json({ frames: inserted });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── POST /api/frames/upload-zip ─────────────────────────────────────── */
router.post("/upload-zip", zipUpload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No ZIP file provided." });
      return;
    }

    const target = parseTarget(req.body.target || req.query.target);
    const zip = new AdmZip(req.file.buffer);
    const entries = zip.getEntries().filter((e) => {
      if (e.isDirectory) return false;
      const name = e.entryName.toLowerCase();
      return (
        name.endsWith(".png") ||
        name.endsWith(".jpg") ||
        name.endsWith(".jpeg") ||
        name.endsWith(".gif") ||
        name.endsWith(".webp")
      );
    });

    if (entries.length === 0) {
      res.status(400).json({ error: "ZIP contains no supported image files." });
      return;
    }

    // Natural-sort the filenames so frame order is predictable (e.g. frame_01, frame_02)
    entries.sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true }));

    const existing = await getFrames(target);
    let position = existing.length;
    const inserted = [];

    for (const entry of entries) {
      const buffer = entry.getData();
      const fileName = entry.entryName.split("/").at(-1) || entry.entryName;
      const mime = guessMime(fileName);
      const { url, key } = await uploadBuffer(buffer, fileName, mime);
      const frame = await insertFrame(url, key, fileName, position++, target);
      imageCache.set(frame.id, { buffer, contentType: mime });
      inserted.push(frame);
    }

    void bridge.syncFramesFromDb();
    res.json({ frames: inserted, count: inserted.length });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── DELETE /api/frames/:id ──────────────────────────────────────────── */
router.delete("/:id", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "Invalid frame ID." });
      return;
    }
    const result = await pool.query("SELECT key FROM animation_frames WHERE id = $1", [id]);
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Frame not found." });
      return;
    }
    const { key } = result.rows[0] as { key: string };
    await deleteFrame(id);
    imageCache.delete(id);
    try {
      await deleteByKey(key);
    } catch {
      /* ignore */
    }
    void bridge.syncFramesFromDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── POST /api/frames/reorder ────────────────────────────────────────── */
router.post("/reorder", async (req, res) => {
  try {
    const { orderedIds } = req.body as { orderedIds: number[] };
    if (!Array.isArray(orderedIds)) {
      res.status(400).json({ error: "orderedIds must be an array." });
      return;
    }
    await reorderFrames(orderedIds);
    void bridge.syncFramesFromDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── DELETE /api/frames (clear) ─────────────────────────────────────── */
router.delete("/", async (req, res) => {
  try {
    const targetParam = req.query.target as string | undefined;
    const target = targetParam ? parseTarget(targetParam) : undefined;
    const frames = await getFrames(target);
    await clearFrames(target);
    frames.forEach((f) => imageCache.delete(f.id));
    try {
      const { utapi } = await import("./uploadClient.js");
      await utapi.deleteFiles(frames.map((f) => f.key));
    } catch {
      /* ignore */
    }
    void bridge.syncFramesFromDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

function guessMime(fileName: string): string {
  const ext = fileName.split(".").at(-1)?.toLowerCase();
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp"
    }[ext ?? ""] ?? "image/png"
  );
}

export default router;
