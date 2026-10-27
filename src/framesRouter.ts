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
import { getFrames, insertFrame, deleteFrame, reorderFrames, clearFrames } from "./db.js";
import { uploadBuffer, deleteByKey } from "./uploadClient.js";
import { pool } from "./db.js";
import { bridge } from "./server.js";

const router = express.Router();

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

/* ─── GET /api/frames ──────────────────────────────────────────────────── */
router.get("/", async (_req, res) => {
  try {
    const frames = await getFrames();
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

    const existing = await getFrames();
    let position = existing.length;

    const inserted = [];
    for (const file of files) {
      const { url, key } = await uploadBuffer(file.buffer, file.originalname, file.mimetype);
      const frame = await insertFrame(url, key, file.originalname, position++);
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

    const existing = await getFrames();
    let position = existing.length;
    const inserted = [];

    for (const entry of entries) {
      const buffer = entry.getData();
      const fileName = entry.entryName.split("/").at(-1) || entry.entryName;
      const mime = guessMime(fileName);
      const { url, key } = await uploadBuffer(buffer, fileName, mime);
      const frame = await insertFrame(url, key, fileName, position++);
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
    const frames = await getFrames();
    void bridge.syncFramesFromDb();
    res.json({ frames });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

/* ─── DELETE /api/frames (clear all) ─────────────────────────────────── */
router.delete("/", async (_req, res) => {
  try {
    const frames = await getFrames();
    await clearFrames();
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
