import { Client } from "@xhayper/discord-rpc";
import type { SetActivity, StatusDisplayType } from "@xhayper/discord-rpc";
import type { BridgeStatus, PresenceConfig } from "./types.js";
import { getFrames } from "./db.js";
import { interpolatePlaceholders } from "./systemHealth.js";

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
  private largeFrames: string[] = [];
  private smallFrames: string[] = [];
  private largeIndex = 0;
  private smallIndex = 0;
  private animationIntervalMs = 5000;
  private animationTimeout: NodeJS.Timeout | null = null;
  private isAnimationRunning = false;
  private healthRefreshInterval: NodeJS.Timeout | null = null;
  private isTicking = false;

  /** Concurrency and rate-limit guard */
  private isUpdating = false;
  private pendingUpdate: PresenceConfig | null = null;
  private lastUpdateTime = 0;

  status(): BridgeStatus {
    return {
      connected: this.client !== null && (this.client.user !== null || this.client.isConnected),
      applicationId: this.config?.applicationId ?? null,
      updatedAt: this.updatedAt,
      lastError: this.lastError
    };
  }

  private hasAnimation(): boolean {
    return this.largeFrames.length >= 2 || this.smallFrames.length >= 2;
  }

  /** Set the frame URLs for animation cycling. Clamped to safe 4s+ interval for Discord RPC. */
  setAnimationFrames(
    targetOrUrls: "large" | "small" | string[],
    urlsOrInterval?: string[] | number,
    maybeInterval = 5000
  ): void {
    let target: "large" | "small" = "large";
    let urls: string[] = [];
    let interval = 5000;

    if (targetOrUrls === "large" || targetOrUrls === "small") {
      target = targetOrUrls;
      urls = Array.isArray(urlsOrInterval) ? urlsOrInterval : [];
      interval = typeof maybeInterval === "number" ? maybeInterval : 5000;
    } else if (Array.isArray(targetOrUrls)) {
      target = "large";
      urls = targetOrUrls;
      interval = typeof urlsOrInterval === "number" ? urlsOrInterval : 5000;
    }

    const formatted = urls.map(formatImageUrl);
    if (target === "small") {
      this.smallFrames = formatted;
      this.smallIndex = 0;
    } else {
      this.largeFrames = formatted;
      this.largeIndex = 0;
    }
    // Discord RPC strictly limits presence updates. Clamp interval to min 4000ms.
    this.animationIntervalMs = Math.max(interval, 4000);

    if (urls.length >= 2) {
      this.isAnimationRunning = true;
      if (this.client && this.config) {
        this.restartAnimationLoop();
      }
    } else {
      this.isAnimationRunning = false;
      this.stopAnimationLoop();
    }
  }

  /** Stop the Discord animation cycling */
  stopAnimation(): void {
    this.isAnimationRunning = false;
    this.stopAnimationLoop();
  }

  /** Sync frames list from Postgres database for both targets without starting loop. */
  async syncFramesFromDb(intervalMs?: number): Promise<void> {
    try {
      const [largeDb, smallDb] = await Promise.all([
        getFrames("large"),
        getFrames("small")
      ]);
      this.largeFrames = largeDb.length >= 2 ? largeDb.map((f) => formatImageUrl(f.url)) : [];
      this.smallFrames = smallDb.length >= 2 ? smallDb.map((f) => formatImageUrl(f.url)) : [];
      this.largeIndex = 0;
      this.smallIndex = 0;
      if (intervalMs) {
        this.animationIntervalMs = Math.max(intervalMs, 4000);
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

      // Sync frames from DB if not loaded yet
      if (this.largeFrames.length === 0 && this.smallFrames.length === 0) {
        await this.syncFramesFromDb();
      }

      await this.update(config);
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

    // Rate-limit guard: Discord drops connection if setActivity is spammed faster than ~1.5s
    const now = Date.now();
    const timeSinceLast = now - this.lastUpdateTime;

    if (this.isUpdating) {
      this.pendingUpdate = config;
      return this.status();
    }

    if (timeSinceLast < 1200) {
      if (!this.pendingUpdate) {
        this.pendingUpdate = config;
        setTimeout(() => {
          if (this.pendingUpdate && this.client) {
            const next = this.pendingUpdate;
            this.pendingUpdate = null;
            this.update(next).catch(() => {});
          }
        }, 1200 - timeSinceLast);
      }
      return this.status();
    }

    this.isUpdating = true;
    this.lastUpdateTime = now;

    try {
      const activeLarge =
        this.isAnimationRunning && this.largeFrames.length >= 2
          ? this.largeFrames[this.largeIndex % this.largeFrames.length]
          : undefined;
      const activeSmall =
        this.isAnimationRunning && this.smallFrames.length >= 2
          ? this.smallFrames[this.smallIndex % this.smallFrames.length]
          : undefined;

      const activity = buildActivity(
        config,
        this.connectedAt,
        this.startedAt,
        activeLarge,
        activeSmall
      );

      await Promise.race([
        this.client.user.setActivity(activity),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Discord setActivity timeout")), 4000))
      ]);
      this.updatedAt = new Date().toISOString();
      this.lastError = null;

      // Keep animation loop ticking if animation is explicitly active
      if (this.isAnimationRunning && this.hasAnimation() && !this.animationTimeout && !this.isTicking) {
        this.restartAnimationLoop();
      }

      // Auto-refresh dynamic server health placeholders or active system stats every 15s
      const hasPlaceholders = Boolean(
        config.line1Mode === "cpu" ||
        config.line1Mode === "gpu" ||
        config.line1Mode === "ram" ||
        config.line2Mode === "cpu" ||
        config.line2Mode === "gpu" ||
        config.line2Mode === "ram" ||
        config.details?.includes("{") ||
        config.state?.includes("{") ||
        config.largeText?.includes("{") ||
        config.smallText?.includes("{")
      );
      if (hasPlaceholders && !this.healthRefreshInterval) {
        this.healthRefreshInterval = setInterval(() => {
          if (this.client && this.config && !this.isAnimationRunning) {
            this.update(this.config).catch(() => {});
          }
        }, 15000);
      } else if (!hasPlaceholders && this.healthRefreshInterval) {
        clearInterval(this.healthRefreshInterval);
        this.healthRefreshInterval = null;
      }

      return this.status();
    } catch (error) {
      // Non-fatal or transient error - do not crash or loop
      const msg = error instanceof Error ? error.message : "Discord rejected the presence.";
      this.lastError = msg;
      return this.status();
    } finally {
      this.isUpdating = false;
      if (this.pendingUpdate && this.client) {
        const next = this.pendingUpdate;
        this.pendingUpdate = null;
        setTimeout(() => {
          this.update(next).catch(() => {});
        }, 1200);
      }
    }
  }

  async disconnect(): Promise<BridgeStatus> {
    this.isAnimationRunning = false;
    this.stopAnimationLoop();
    if (this.healthRefreshInterval) {
      clearInterval(this.healthRefreshInterval);
      this.healthRefreshInterval = null;
    }
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
    if (!this.isAnimationRunning || !this.hasAnimation() || !this.client || !this.client.user || !this.config) return;

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
    if (!this.client || !this.client.user || !this.config || !this.isAnimationRunning || !this.hasAnimation() || this.isTicking) {
      return;
    }

    this.isTicking = true;
    try {
      let nextLarge: string | undefined = undefined;
      if (this.largeFrames.length >= 2) {
        this.largeIndex = (this.largeIndex + 1) % this.largeFrames.length;
        nextLarge = this.largeFrames[this.largeIndex];
      }

      let nextSmall: string | undefined = undefined;
      if (this.smallFrames.length >= 2) {
        this.smallIndex = (this.smallIndex + 1) % this.smallFrames.length;
        nextSmall = this.smallFrames[this.smallIndex];
      }

      const activity = buildActivity(
        this.config,
        this.connectedAt,
        this.startedAt,
        nextLarge,
        nextSmall
      );

      await Promise.race([
        this.client.user.setActivity(activity),
        new Promise((_, reject) => setTimeout(() => reject(new Error("RPC setActivity timeout")), 4000))
      ]);

      this.updatedAt = new Date().toISOString();
      this.lastError = null;
    } catch {
      // Suppress transient rate-limit / timeout noise in terminal
    } finally {
      this.isTicking = false;
      if (this.client && this.config && this.isAnimationRunning && this.hasAnimation()) {
        const safeInterval = Math.max(this.animationIntervalMs, 5000);
        this.scheduleNextTick(safeInterval);
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
  overrideLargeImage?: string,
  overrideSmallImage?: string
): SetActivity {
  let largeKey = overrideLargeImage || (config.largeKey ? formatImageUrl(config.largeKey) : undefined);
  let smallKey = overrideSmallImage || (config.smallKey ? formatImageUrl(config.smallKey) : undefined);

  // If smallKey is present but largeKey is missing, Discord RPC hangs or rejects. Promote to largeKey.
  if (!largeKey && smallKey) {
    largeKey = smallKey;
    smallKey = undefined;
  }

  let detailsText: string | undefined = undefined;
  switch (config.line1Mode) {
    case "cpu":
      detailsText = "{cpu}";
      break;
    case "gpu":
      detailsText = "{gpu}";
      break;
    case "ram":
      detailsText = "{ram}";
      break;
    case "none":
      detailsText = undefined;
      break;
    case "custom":
    default:
      detailsText = config.details || undefined;
      break;
  }

  let stateText: string | undefined = undefined;
  switch (config.line2Mode) {
    case "ram":
      stateText = "{ram}";
      break;
    case "cpu":
      stateText = "{cpu}";
      break;
    case "gpu":
      stateText = "{gpu}";
      break;
    case "none":
      stateText = undefined;
      break;
    case "custom":
    default:
      stateText = config.state || undefined;
      break;
  }

  const barStyle = config.loadingBarStyle || "capsule";

  const activity: SetActivity = {
    type: config.type,
    name: config.name || activityTypeNames[config.type] || "Custom Presence",
    details: detailsText ? interpolatePlaceholders(detailsText, barStyle) : undefined,
    state: stateText ? interpolatePlaceholders(stateText, barStyle) : undefined,
    detailsUrl: config.detailsUrl || undefined,
    stateUrl: config.stateUrl || undefined,
    largeImageKey: largeKey,
    largeImageText: config.largeText ? interpolatePlaceholders(config.largeText, barStyle) : undefined,
    smallImageKey: smallKey,
    smallImageText: config.smallText ? interpolatePlaceholders(config.smallText, barStyle) : undefined,
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
  const result: Array<{ label: string; url: string }> = [];

  const addButton = (text: string, rawUrl: string) => {
    const label = (text || "").trim();
    const url = (rawUrl || "").trim();
    if (!label && !url) return;

    const finalLabel = (label || "Open Link").slice(0, 32);
    const normalized = normalizeUrl(url || "https://discord.com");

    if (isHttpUrl(normalized)) {
      result.push({
        label: finalLabel,
        url: normalized.slice(0, 512)
      });
    }
  };

  addButton(config.button1Text, config.button1Url);
  addButton(config.button2Text, config.button2Url);

  return result.length ? result.slice(0, 2) : undefined;
}

function buildTimestamps(
  config: PresenceConfig,
  connectedAt: number,
  startedAt: number
): { startTimestamp?: number; endTimestamp?: number } {
  const now = Date.now();
  const offsetMs = Math.max(0, Number(config.timerOffsetMinutes) || 0) * 60 * 1000;

  switch (config.timestampMode) {
    case "none":
      return {};

    case "last-connection":
      return { startTimestamp: connectedAt };

    case "startup":
      return { startTimestamp: startedAt };

    case "presence-update":
      return { startTimestamp: now };

    case "elapsed-offset":
      // Counts UP from X minutes ago (e.g. 25:52 elapsed)
      return { startTimestamp: now - (offsetMs || 25 * 60 * 1000) };

    case "countdown":
      // Counts DOWN towards X minutes remaining (e.g. 25:00 left)
      return { endTimestamp: now + (offsetMs || 30 * 60 * 1000) };

    case "country-timezone": {
      // Calculate start of day in chosen timezone using 12-hour format so it displays e.g. 1:55 instead of 13:55
      const tz = config.selectedTimezone || "UTC";
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "numeric",
          second: "numeric",
          hour12: false
        }).formatToParts(new Date());

        const h = parseInt(parts.find(p => p.type === "hour")?.value || "0", 10);
        const m = parseInt(parts.find(p => p.type === "minute")?.value || "0", 10);
        const s = parseInt(parts.find(p => p.type === "second")?.value || "0", 10);

        const hours12 = h % 12 || 12;
        const elapsedSec = hours12 * 3600 + m * 60 + s;
        return { startTimestamp: now - (elapsedSec * 1000) };
      } catch {
        return { startTimestamp: now };
      }
    }

    case "local-time": {
      const current = new Date();
      // 12-hour clock (e.g. 13:55 -> 1:55 elapsed so Discord displays 1:55:xx instead of 24h 13:55)
      const hours12 = current.getHours() % 12 || 12;
      const elapsedSec = hours12 * 3600 + current.getMinutes() * 60 + current.getSeconds();
      return { startTimestamp: now - (elapsedSec * 1000) };
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

    default:
      return { startTimestamp: connectedAt };
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
