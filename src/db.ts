import pg from "pg";
import type { PresenceConfig, ActivityType, DisplayType, TimestampMode } from "./types.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type FrameTarget = "large" | "small";

/** Create required database tables if they do not exist. */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS animation_frames (
      id          SERIAL PRIMARY KEY,
      url         TEXT        NOT NULL,
      key         TEXT        NOT NULL,
      file_name   TEXT        NOT NULL,
      position    INTEGER     NOT NULL DEFAULT 0,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE animation_frames ADD COLUMN IF NOT EXISTS target VARCHAR(16) NOT NULL DEFAULT 'large';
    CREATE INDEX IF NOT EXISTS idx_animation_frames_position
      ON animation_frames (position ASC);
    CREATE INDEX IF NOT EXISTS idx_animation_frames_target_position
      ON animation_frames (target, position ASC);

    CREATE TABLE IF NOT EXISTS presence_configs (
      id                            TEXT PRIMARY KEY DEFAULT 'default',
      application_id                TEXT NOT NULL DEFAULT '',
      type                          INTEGER NOT NULL DEFAULT 0,
      display                       INTEGER NOT NULL DEFAULT 0,
      name                          TEXT NOT NULL DEFAULT '',
      details                       TEXT NOT NULL DEFAULT '',
      details_url                   TEXT NOT NULL DEFAULT '',
      state                         TEXT NOT NULL DEFAULT '',
      state_url                     TEXT NOT NULL DEFAULT '',
      party_size                    INTEGER NOT NULL DEFAULT 0,
      party_max                     INTEGER NOT NULL DEFAULT 0,
      timestamp_mode                TEXT NOT NULL DEFAULT 'last-connection',
      custom_timestamp_start        TEXT NOT NULL DEFAULT '',
      custom_timestamp_end_enabled  BOOLEAN NOT NULL DEFAULT false,
      custom_timestamp_end          TEXT NOT NULL DEFAULT '',
      large_key                     TEXT NOT NULL DEFAULT '',
      large_text                    TEXT NOT NULL DEFAULT '',
      large_url                     TEXT NOT NULL DEFAULT '',
      small_key                     TEXT NOT NULL DEFAULT '',
      small_text                    TEXT NOT NULL DEFAULT '',
      small_url                     TEXT NOT NULL DEFAULT '',
      button1_text                  TEXT NOT NULL DEFAULT '',
      button1_url                   TEXT NOT NULL DEFAULT '',
      button2_text                  TEXT NOT NULL DEFAULT '',
      button2_url                   TEXT NOT NULL DEFAULT '',
      selected_timezone             TEXT NOT NULL DEFAULT 'UTC',
      timer_offset_minutes          INTEGER NOT NULL DEFAULT 0,
      updated_at                    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS selected_timezone TEXT NOT NULL DEFAULT 'UTC';
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS timer_offset_minutes INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS activity_server_health TEXT NOT NULL DEFAULT 'none';
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS line1_mode TEXT NOT NULL DEFAULT 'cpu';
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS line2_mode TEXT NOT NULL DEFAULT 'ram';
    ALTER TABLE presence_configs ADD COLUMN IF NOT EXISTS loading_bar_style TEXT NOT NULL DEFAULT 'capsule';
  `);
}

export interface AnimationFrame {
  id: number;
  url: string;
  key: string;
  file_name: string;
  position: number;
  uploaded_at: string;
  target?: FrameTarget;
}

export async function getFrames(target?: FrameTarget): Promise<AnimationFrame[]> {
  if (target) {
    const result = await pool.query<AnimationFrame>(
      "SELECT * FROM animation_frames WHERE target = $1 ORDER BY position ASC, id ASC",
      [target]
    );
    return result.rows;
  }
  const result = await pool.query<AnimationFrame>(
    "SELECT * FROM animation_frames ORDER BY position ASC, id ASC"
  );
  return result.rows;
}

export async function insertFrame(
  url: string,
  key: string,
  fileName: string,
  position: number,
  target: FrameTarget = "large"
): Promise<AnimationFrame> {
  const result = await pool.query<AnimationFrame>(
    "INSERT INTO animation_frames (url, key, file_name, position, target) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [url, key, fileName, position, target]
  );
  return result.rows[0];
}

export async function deleteFrame(id: number): Promise<void> {
  await pool.query("DELETE FROM animation_frames WHERE id = $1", [id]);
}

export async function reorderFrames(
  orderedIds: number[]
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        "UPDATE animation_frames SET position = $1 WHERE id = $2",
        [i, orderedIds[i]]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function clearFrames(target?: FrameTarget): Promise<void> {
  if (target) {
    await pool.query("DELETE FROM animation_frames WHERE target = $1", [target]);
  } else {
    await pool.query("DELETE FROM animation_frames");
  }
}

export async function getStoredPresence(id = "default"): Promise<PresenceConfig | null> {
  const result = await pool.query<{
    application_id: string;
    type: number;
    display: number;
    name: string;
    details: string;
    details_url: string;
    state: string;
    state_url: string;
    party_size: number;
    party_max: number;
    timestamp_mode: string;
    custom_timestamp_start: string;
    custom_timestamp_end_enabled: boolean;
    custom_timestamp_end: string;
    large_key: string;
    large_text: string;
    large_url: string;
    small_key: string;
    small_text: string;
    small_url: string;
    button1_text: string;
    button1_url: string;
    button2_text: string;
    button2_url: string;
    selected_timezone: string;
    timer_offset_minutes: number;
    activity_server_health?: string;
    line1_mode?: string;
    line2_mode?: string;
    loading_bar_style?: string;
  }>("SELECT * FROM presence_configs WHERE id = $1 LIMIT 1", [id]);

  if (result.rows.length === 0) return null;
  const row = result.rows[0];
  return {
    applicationId: row.application_id || "",
    type: (row.type ?? 0) as ActivityType,
    display: (row.display ?? 0) as DisplayType,
    name: row.name || "",
    details: row.details || "",
    detailsUrl: row.details_url || "",
    state: row.state || "",
    stateUrl: row.state_url || "",
    partySize: Number(row.party_size) || 0,
    partyMax: Number(row.party_max) || 0,
    timestampMode: (row.timestamp_mode as TimestampMode) || "last-connection",
    customTimestampStart: row.custom_timestamp_start || "",
    customTimestampEndEnabled: Boolean(row.custom_timestamp_end_enabled),
    customTimestampEnd: row.custom_timestamp_end || "",
    selectedTimezone: row.selected_timezone || "UTC",
    timerOffsetMinutes: Number(row.timer_offset_minutes) || 0,
    activityServerHealth: (row.activity_server_health as "none" | "details" | "state") || "none",
    line1Mode: (["custom", "cpu", "gpu", "ram", "none"].includes(row.line1_mode || "") ? row.line1_mode : "cpu") as "custom" | "cpu" | "gpu" | "ram" | "none",
    line2Mode: (["custom", "cpu", "gpu", "ram", "none"].includes(row.line2_mode || "") ? row.line2_mode : "ram") as "custom" | "cpu" | "gpu" | "ram" | "none",
    loadingBarStyle: row.loading_bar_style || "capsule",
    largeKey: row.large_key || "",
    largeText: row.large_text || "",
    largeUrl: row.large_url || "",
    smallKey: row.small_key || "",
    smallText: row.small_text || "",
    smallUrl: row.small_url || "",
    button1Text: row.button1_text || "",
    button1Url: row.button1_url || "",
    button2Text: row.button2_text || "",
    button2Url: row.button2_url || ""
  };
}

export async function savePresenceToDb(config: PresenceConfig, id = "default"): Promise<PresenceConfig> {
  await pool.query(
    `INSERT INTO presence_configs (
      id, application_id, type, display, name,
      details, details_url, state, state_url,
      party_size, party_max, timestamp_mode,
      custom_timestamp_start, custom_timestamp_end_enabled, custom_timestamp_end,
      large_key, large_text, large_url,
      small_key, small_text, small_url,
      button1_text, button1_url, button2_text, button2_url,
      selected_timezone, timer_offset_minutes, activity_server_health,
      line1_mode, line2_mode, loading_bar_style,
      updated_at
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12,
      $13, $14, $15,
      $16, $17, $18,
      $19, $20, $21,
      $22, $23, $24, $25,
      $26, $27, $28,
      $29, $30, $31,
      NOW()
    ) ON CONFLICT (id) DO UPDATE SET
      application_id = EXCLUDED.application_id,
      type = EXCLUDED.type,
      display = EXCLUDED.display,
      name = EXCLUDED.name,
      details = EXCLUDED.details,
      details_url = EXCLUDED.details_url,
      state = EXCLUDED.state,
      state_url = EXCLUDED.state_url,
      party_size = EXCLUDED.party_size,
      party_max = EXCLUDED.party_max,
      timestamp_mode = EXCLUDED.timestamp_mode,
      custom_timestamp_start = EXCLUDED.custom_timestamp_start,
      custom_timestamp_end_enabled = EXCLUDED.custom_timestamp_end_enabled,
      custom_timestamp_end = EXCLUDED.custom_timestamp_end,
      large_key = EXCLUDED.large_key,
      large_text = EXCLUDED.large_text,
      large_url = EXCLUDED.large_url,
      small_key = EXCLUDED.small_key,
      small_text = EXCLUDED.small_text,
      small_url = EXCLUDED.small_url,
      button1_text = EXCLUDED.button1_text,
      button1_url = EXCLUDED.button1_url,
      button2_text = EXCLUDED.button2_text,
      button2_url = EXCLUDED.button2_url,
      selected_timezone = EXCLUDED.selected_timezone,
      timer_offset_minutes = EXCLUDED.timer_offset_minutes,
      activity_server_health = EXCLUDED.activity_server_health,
      line1_mode = EXCLUDED.line1_mode,
      line2_mode = EXCLUDED.line2_mode,
      loading_bar_style = EXCLUDED.loading_bar_style,
      updated_at = NOW()`,
    [
      id,
      config.applicationId || "",
      config.type ?? 0,
      config.display ?? 0,
      config.name || "",
      config.details || "",
      config.detailsUrl || "",
      config.state || "",
      config.stateUrl || "",
      config.partySize || 0,
      config.partyMax || 0,
      config.timestampMode || "last-connection",
      config.customTimestampStart || "",
      Boolean(config.customTimestampEndEnabled),
      config.customTimestampEnd || "",
      config.largeKey || "",
      config.largeText || "",
      config.largeUrl || "",
      config.smallKey || "",
      config.smallText || "",
      config.smallUrl || "",
      config.button1Text || "",
      config.button1Url || "",
      config.button2Text || "",
      config.button2Url || "",
      config.selectedTimezone || "UTC",
      config.timerOffsetMinutes || 0,
      config.activityServerHealth || "none",
      config.line1Mode || "cpu",
      config.line2Mode || "ram",
      config.loadingBarStyle || "capsule"
    ]
  );
  return config;
}
