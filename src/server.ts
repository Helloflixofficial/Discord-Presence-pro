import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DiscordBridge } from "./discordBridge.js";
import { defaultPresence, type PresenceConfig } from "./types.js";
import { migrate } from "./db.js";
import framesRouter from "./framesRouter.js";

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
app.get("/api/config", (_request, response) => {
  response.json({ defaultPresence: defaultPresence(configuredClientId) });
});

app.get("/api/status", (_request, response) => {
  response.json(bridge.status());
});

app.post("/api/presence/connect", async (request, response) => {
  await runBridgeAction(response, () => bridge.connect(parsePresence(request.body)));
});

app.post("/api/presence/update", async (request, response) => {
  await runBridgeAction(response, () => bridge.update(parsePresence(request.body)));
});

app.post("/api/presence/disconnect", async (_request, response) => {
  await runBridgeAction(response, () => bridge.disconnect());
});

// ─── Animation control ──────────────────────────────────────────────────────
app.post("/api/animation/start", async (request, response) => {
  try {
    const { urls, intervalMs } = request.body as { urls: string[]; intervalMs?: number };
    if (!Array.isArray(urls) || urls.length === 0) {
      response.status(400).json({ error: "urls array is required." });
      return;
    }
    bridge.setAnimationFrames(urls, intervalMs ?? 200);
    response.json({ ok: true, frameCount: urls.length });
  } catch (err) {
    response.status(500).json({ error: String(err) });
  }
});

app.post("/api/animation/stop", (_request, response) => {
  bridge.setAnimationFrames([]);
  response.json({ ok: true });
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(publicDir, "index.html"));
});

// ─── Boot ────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
  try {
    await migrate();
    console.log("Database ready.");
    await bridge.syncFramesFromDb();
    console.log("Animation frames synced from database.");
  } catch (err) {
    console.warn("Database initialization warning:", err);
  }

  app.listen(port, host, () => {
    console.log(`CustomRP web editor listening at http://${host}:${port}`);
  });
}

void boot();

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
    customTimestampEndEnabled: Boolean(body.customTimestampEndEnabled)
  };
  return config;
}
