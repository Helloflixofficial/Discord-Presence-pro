import { Client } from "@xhayper/discord-rpc";
import type { SetActivity, StatusDisplayType } from "@xhayper/discord-rpc";
import type { BridgeStatus, PresenceConfig } from "./types.js";
import { getFrames } from "./db.js";

const activityTypeNames: Record<number, string> = {
  0: "Playing",
  2: "Listening",
  3: "Watching",
  5: "Competing"
};

export class DiscordBridge {
  private client: Client | null = null;
  private config: PresenceConfig | null = null;
  private connectedAt = Date.now();
  private startedAt = Date.now();
  private updatedAt: string | null = null;
  private lastError: string | null = null;

  /** Animation cycling state */
  private animationFrames: string[] = [];
  private animationIndex = 0;
  private animationIntervalMs = 200;
  private animationTimeout: NodeJS.Timeout | null = null;
  private isTicking = false;

  status(): BridgeStatus {
    return {
      connected: this.client !== null && (this.client.user !== null || this.client.isConnected),
      applicationId: this.config?.applicationId ?? null,
      updatedAt: this.updatedAt,
      lastError: this.lastError
    };
  }

  /** Set the frame URLs for animation cycling. Pass [] to disable. */
  setAnimationFrames(urls: string[], intervalMs = 200): void {
    this.animationFrames = urls.map(formatImageUrl);
    this.animationIntervalMs = Math.max(intervalMs, 50);
    this.animationIndex = 0;
    if (this.client && this.config) {
      this.restartAnimationLoop();
    }
  }

  /** Sync frames list from Postgres database. */
  async syncFramesFromDb(intervalMs?: number): Promise<void> {
    try {
      const dbFrames = await getFrames();
      if (dbFrames.length >= 2) {
        this.setAnimationFrames(
          dbFrames.map((f) => f.url),
          intervalMs ?? this.animationIntervalMs
        );
      } else {
        this.setAnimationFrames([]);
      }
    } catch (err) {
      console.warn("Could not sync frames from DB:", err instanceof Error ? err.message : err);
    }
  }

  async connect(config: PresenceConfig): Promise<BridgeStatus> {
    await this.disconnect();
    this.assertConfig(config);

    const client = new Client({ clientId: config.applicationId });

    try {
      await client.login();
      this.client = client;
      this.config = config;
      this.connectedAt = Date.now();
      this.lastError = null;

      // Auto-load animation frames from DB if not already set in memory
      if (this.animationFrames.length < 2) {
        await this.syncFramesFromDb();
      }

      await this.update(config);
      this.restartAnimationLoop();
      return this.status();
    } catch (error) {
      try {
        client.destroy();
      } catch {
        /* best-effort */
      }
      this.client = null;
      this.config = null;
      this.lastError = error instanceof Error ? error.message : "Unable to connect to Discord.";
      throw new Error(this.lastError);
    }
  }

  async update(config: PresenceConfig): Promise<BridgeStatus> {
    this.assertConfig(config);
    if (!this.client || !this.client.user) {
      throw new Error("Discord is not connected. Start Discord and press Connect first.");
    }

    this.config = config;

    // If animation frames are available, keep the active frame so we don't flash back to static
    const activeFrame =
      this.animationFrames.length >= 2
        ? this.animationFrames[this.animationIndex % this.animationFrames.length]
        : undefined;

    const activity = buildActivity(config, this.connectedAt, this.startedAt, activeFrame);

    try {
      await Promise.race([
        this.client.user.setActivity(activity),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Discord setActivity timeout")), 4000))
      ]);
      this.updatedAt = new Date().toISOString();
      this.lastError = null;

      // Keep animation loop ticking
      if (this.animationFrames.length >= 2 && !this.animationTimeout && !this.isTicking) {
        this.restartAnimationLoop();
      }

      return this.status();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "Discord rejected the presence.";
      throw new Error(this.lastError);
    }
  }

  async disconnect(): Promise<BridgeStatus> {
    this.stopAnimationLoop();
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.client = null;
    this.config = null;
    this.updatedAt = null;
    return this.status();
  }

  // ─── Animation helpers ───────────────────────────────────────────────────

  private restartAnimationLoop(): void {
    this.stopAnimationLoop();
    if (this.animationFrames.length < 2 || !this.client || !this.client.user || !this.config) return;

    this.scheduleNextTick(0);
  }

  private stopAnimationLoop(): void {
    if (this.animationTimeout) {
      clearTimeout(this.animationTimeout);
      this.animationTimeout = null;
    }
    this.isTicking = false;
  }

  private scheduleNextTick(delayMs: number): void {
    if (this.animationTimeout) {
      clearTimeout(this.animationTimeout);
      this.animationTimeout = null;
    }
    this.animationTimeout = setTimeout(() => {
      void this.tickAnimation();
    }, delayMs);
  }

  private async tickAnimation(): Promise<void> {
    if (!this.client || !this.client.user || !this.config || this.animationFrames.length < 2 || this.isTicking) {
      return;
    }

    this.isTicking = true;
    try {
      this.animationIndex = (this.animationIndex + 1) % this.animationFrames.length;
      const frameUrl = this.animationFrames[this.animationIndex];

      const activity = buildActivity(this.config, this.connectedAt, this.startedAt, frameUrl);

      await Promise.race([
        this.client.user.setActivity(activity),
        new Promise((_, reject) => setTimeout(() => reject(new Error("RPC setActivity timeout")), 3000))
      ]);

      this.updatedAt = new Date().toISOString();
      this.lastError = null;
    } catch (err) {
      // Non-fatal transient RPC error (e.g. rate limit debounce)
      console.warn("Animation tick warning:", err instanceof Error ? err.message : err);
    } finally {
      this.isTicking = false;
      if (this.client && this.config && this.animationFrames.length >= 2) {
        this.scheduleNextTick(this.animationIntervalMs);
      }
    }
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  private assertConfig(config: PresenceConfig): void {
    if (!/^\d{17,20}$/.test(config.applicationId.trim())) {
      throw new Error("Application ID must be a valid Discord application ID.");
    }
    if (config.name.length > 128 || config.details.length > 128 || config.state.length > 128) {
      throw new Error("Name, details, and state must be 128 characters or fewer.");
    }
    for (const url of [
      config.detailsUrl,
      config.stateUrl,
      config.largeUrl,
      config.smallUrl,
      config.button1Url,
      config.button2Url
    ]) {
      if (url && !isHttpUrl(url)) {
        throw new Error("URLs must use http:// or https://.");
      }
    }
  }
}

function buildActivity(
  config: PresenceConfig,
  connectedAt: number,
  startedAt: number,
  overrideLargeImage?: string
): SetActivity {
  const largeKey = overrideLargeImage || (config.largeKey ? formatImageUrl(config.largeKey) : undefined);
  const smallKey = config.smallKey ? formatImageUrl(config.smallKey) : undefined;

  const activity: SetActivity = {
    type: config.type,
    name: config.name || activityTypeNames[config.type] || "Custom Presence",
    details: config.details || undefined,
    state: config.state || undefined,
    detailsUrl: config.detailsUrl || undefined,
    stateUrl: config.stateUrl || undefined,
    largeImageKey: largeKey,
    largeImageText: config.largeText || undefined,
    largeImageUrl: config.largeUrl || undefined,
    smallImageKey: smallKey,
    smallImageText: config.smallText || undefined,
    smallImageUrl: config.smallUrl || undefined,
    buttons: buildButtons(config),
    statusDisplayType: (config.display as StatusDisplayType) ?? undefined,
    instance: false
  };

  if (config.type === 0 && config.partySize > 0 && config.partyMax > 0) {
    activity.partySize = Math.min(Math.floor(config.partySize), 9999);
    activity.partyMax = Math.max(activity.partySize, Math.min(Math.floor(config.partyMax), 9999));
    activity.partyId = "CustomRP";
  }

  if (config.type !== 5) {
    const timestamps = buildTimestamps(config, connectedAt, startedAt);
    if (timestamps.startTimestamp !== undefined) activity.startTimestamp = timestamps.startTimestamp;
    if (timestamps.endTimestamp !== undefined) activity.endTimestamp = timestamps.endTimestamp;
  }

  return compact(activity);
}

function buildButtons(config: PresenceConfig): Array<{ label: string; url: string }> | undefined {
  const buttons = [
    { label: config.button1Text.trim(), url: normalizeUrl(config.button1Url) },
    { label: config.button2Text.trim(), url: normalizeUrl(config.button2Url) }
  ].filter((button) => button.label && button.url);
  return buttons.length ? buttons.slice(0, 2) : undefined;
}

function buildTimestamps(
  config: PresenceConfig,
  connectedAt: number,
  startedAt: number
): { startTimestamp?: number; endTimestamp?: number } {
  const now = Date.now();
  switch (config.timestampMode) {
    case "last-connection":
      return { startTimestamp: connectedAt };
    case "startup":
      return { startTimestamp: startedAt };
    case "presence-update":
      return { startTimestamp: now };
    case "local-time": {
      const current = new Date();
      return { startTimestamp: new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime() };
    }
    case "custom": {
      const start = parseDate(config.customTimestampStart);
      if (!start) return {};
      if (config.customTimestampEndEnabled) {
        const end = parseDate(config.customTimestampEnd);
        return end ? { startTimestamp: start, endTimestamp: end } : { startTimestamp: start };
      }
      return start > now ? { startTimestamp: now, endTimestamp: start } : { startTimestamp: start };
    }
  }
}

function parseDate(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUrl(value: string): string {
  if (!value.trim()) return "";
  return /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(normalizeUrl(value)).protocol);
  } catch {
    return false;
  }
}

function formatImageUrl(url: string): string {
  if (!url) return "";
  return url.trim();
}

function compact<T extends Record<string, unknown>>(activity: T): T {
  return Object.fromEntries(Object.entries(activity).filter(([, value]) => value !== undefined)) as T;
}
