import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordBridge } from "./discordBridge.js";
import { defaultPresence, type PresenceConfig } from "./types.js";
import { migrate, getStoredPresence, savePresenceToDb } from "./db.js";
import framesRouter from "./framesRouter.js";
import { getSystemHealth } from "./systemHealth.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const webRoot = path.resolve(currentDir, "..");
const publicDir = path.join(webRoot, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 3000);
const configuredClientId = process.env.DISCORD_CLIENT_ID || "";
export const bridge = new DiscordBridge();
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(publicDir));

// ─── Animation Frames API ───────────────────────────────────────────────────
app.use("/api/frames", framesRouter);

// ─── Presence API ───────────────────────────────────────────────────────────
app.get("/api/config", async (_request, response) => {
  try {
    const stored = await getStoredPresence("default");
    const fallback = defaultPresence(configuredClientId);
    response.json({ defaultPresence: stored || fallback });
  } catch {
    response.json({ defaultPresence: defaultPresence(configuredClientId) });
  }
});

app.get("/api/status", (_request, response) => {
  response.json(bridge.status());
});

app.get("/api/system/health", async (request, response) => {
  try {
    const style = String(request.query.style || "capsule");
    const health = await getSystemHealth(style);
    response.json({
      ok: true,
      ...health,
      services: {
        database: "connected",
        discordIpc: bridge.status().connected ? "connected" : "disconnected"
      }
    });
  } catch (err) {
    response.status(500).json({ error: String(err) });
  }
});

app.post("/api/presence/save", async (request, response) => {
  try {
    const config = parsePresence(request.body);
    const saved = await savePresenceToDb(config, "default");
    response.json({ ok: true, presence: saved });
  } catch (err) {
    response.status(400).json({ error: err instanceof Error ? err.message : "Failed to save presence." });
  }
});

app.post("/api/presence/connect", async (request, response) => {
  await runBridgeAction(response, async () => {
    const config = parsePresence(request.body);
    try { await savePresenceToDb(config, "default"); } catch { /* best-effort */ }
    return bridge.connect(config);
  });
});

app.post("/api/presence/update", async (request, response) => {
  await runBridgeAction(response, async () => {
    const config = parsePresence(request.body);
    try { await savePresenceToDb(config, "default"); } catch { /* best-effort */ }
    return bridge.update(config);
  });
});

app.post("/api/presence/disconnect", async (_request, response) => {
  await runBridgeAction(response, () => bridge.disconnect());
});

// ─── Animation control ──────────────────────────────────────────────────────
app.post("/api/animation/start", async (request, response) => {
  try {
    const { target, urls, intervalMs } = request.body as {
      target?: "large" | "small";
      urls: string[];
      intervalMs?: number;
    };
    if (!Array.isArray(urls) || urls.length === 0) {
      response.status(400).json({ error: "urls array is required." });
      return;
    }
    const frameTarget = target === "small" ? "small" : "large";
    bridge.setAnimationFrames(frameTarget, urls, intervalMs ?? 50);
    response.json({ ok: true, frameCount: urls.length, target: frameTarget });
  } catch (err) {
    response.status(500).json({ error: String(err) });
  }
});

app.post("/api/animation/stop", (request, response) => {
  const target = request.body?.target as "large" | "small" | undefined;
  if (target) {
    bridge.setAnimationFrames(target, []);
  } else {
    bridge.setAnimationFrames("large", []);
    bridge.setAnimationFrames("small", []);
  }
  response.json({ ok: true });
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

export default app;

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  try {
    await migrate();
    console.log("Database ready.");
    await bridge.syncFramesFromDb();
    console.log("Animation frames synced from database.");

    // Auto-connect to Discord on startup if presence config exists
    const stored = await getStoredPresence("default");
    if (stored && stored.applicationId?.trim()) {
      bridge.connect(stored).then(() => {
        console.log("Auto-connected to Discord RPC on server startup.");
      }).catch((err) => {
        console.log("Discord is not running yet; waiting for client connection:", err.message);
      });
    }
  } catch (err) {
    console.warn("Database initialization warning:", err);
  }

  app.listen(port, host, () => {
    console.log(`CustomRP web editor listening at http://${host}:${port}`);
  });
}

if (!process.env.VERCEL) {
  void boot();
} else {
  // On Vercel: run database migration asynchronously once
  migrate().catch((err) => console.warn("Vercel DB init warning:", err));
}

// ─── Helpers ────────────────────────────────────────────────────────────────
async function runBridgeAction(response: express.Response, action: () => Promise<unknown>): Promise<void> {
  try {
    response.json(await action());
  } catch (error) {
    const message = error instanceof Error ? error.message : "The Discord bridge failed.";
    response.status(400).json({ error: message, status: bridge.status() });
  }
}

function parsePresence(value: unknown): PresenceConfig {
  if (!value || typeof value !== "object") throw new Error("Presence data is required.");
  const body = value as Partial<PresenceConfig>;
  const applicationId = String(body.applicationId || "").trim();
  const config: PresenceConfig = {
    ...defaultPresence(applicationId),
    ...body,
    applicationId,
    type: Number(body.type) as PresenceConfig["type"],
    display: Number(body.display) as PresenceConfig["display"],
    partySize: Math.max(0, Number(body.partySize) || 0),
    partyMax: Math.max(0, Number(body.partyMax) || 0),
    customTimestampEndEnabled: Boolean(body.customTimestampEndEnabled),
    timerOffsetMinutes: Math.max(0, Number(body.timerOffsetMinutes) || 0),
    selectedTimezone: String(body.selectedTimezone || "UTC"),
    activityServerHealth: (["none", "details", "state"].includes(String(body.activityServerHealth)) ? body.activityServerHealth : "none") as "none" | "details" | "state",
    line1Mode: (["custom", "cpu", "gpu", "ram", "none"].includes(String(body.line1Mode)) ? body.line1Mode : "cpu") as "custom" | "cpu" | "gpu" | "ram" | "none",
    line2Mode: (["custom", "cpu", "gpu", "ram", "none"].includes(String(body.line2Mode)) ? body.line2Mode : "ram") as "custom" | "cpu" | "gpu" | "ram" | "none",
    loadingBarStyle: String(body.loadingBarStyle || "capsule")
  };
  return config;
}
