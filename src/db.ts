import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

/** Create the animation_frames table if it doesn't exist. */
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
    CREATE INDEX IF NOT EXISTS idx_animation_frames_position
      ON animation_frames (position ASC);
  `);
}

export interface AnimationFrame {
  id: number;
  url: string;
  key: string;
  file_name: string;
  position: number;
  uploaded_at: string;
}

export async function getFrames(): Promise<AnimationFrame[]> {
  const result = await pool.query<AnimationFrame>(
    "SELECT * FROM animation_frames ORDER BY position ASC, id ASC"
  );
  return result.rows;
}

export async function insertFrame(
  url: string,
  key: string,
  fileName: string,
  position: number
): Promise<AnimationFrame> {
  const result = await pool.query<AnimationFrame>(
    "INSERT INTO animation_frames (url, key, file_name, position) VALUES ($1, $2, $3, $4) RETURNING *",
    [url, key, fileName, position]
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

export async function clearFrames(): Promise<void> {
  await pool.query("DELETE FROM animation_frames");
}
