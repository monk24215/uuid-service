import pg from 'pg';

const { Pool } = pg;

// Railway provides DATABASE_URL. SSL is required in production.
// When DATABASE_URL is set (Railway), use it. Otherwise fall back to standard
// PG* env vars (PGHOST/PGDATABASE/PGUSER), which is handy for local sockets.
const useUrl = Boolean(process.env.DATABASE_URL);
export const pool = new Pool(
  useUrl
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: /railway|proxy\.rlwy|amazonaws/i.test(process.env.DATABASE_URL)
          ? { rejectUnauthorized: false }
          : false,
      }
    : {} // inherits PGHOST/PGDATABASE/PGUSER/PGPORT from env
);

// Phase-one defaults. In phase two these are read from the user's role
// (see the `roles` table) rather than being global constants.
export const DEFAULT_MAX_UPLOADS = 5;
export const DEFAULT_MAX_ROWS_PER_UPLOAD = 5000;

// Resolve a user's effective limits from their role, falling back to defaults.
// Phase one: every user has the 'free' role, which carries the defaults.
// Phase two: seed additional roles and reassign users — no schema change needed.
export async function getUserLimits(userId) {
  const { rows } = await pool.query(
    `SELECT r.max_uploads, r.max_rows_per_upload
       FROM users u
       JOIN roles r ON r.name = u.role
      WHERE u.id = $1`,
    [userId]
  );
  if (rows[0]) {
    return {
      maxUploads: rows[0].max_uploads,
      maxRowsPerUpload: rows[0].max_rows_per_upload,
    };
  }
  return {
    maxUploads: DEFAULT_MAX_UPLOADS,
    maxRowsPerUpload: DEFAULT_MAX_ROWS_PER_UPLOAD,
  };
}

// Idempotent schema setup. Runs on boot.
export async function initSchema() {
  // gen_random_uuid() is built into Postgres core since v13, so no extension
  // is required. (RFC 4122 version-4 UUIDs.)
  await pool.query(`
    -- Role definitions carry the per-role limits. Phase two adds rows here
    -- (e.g. 'pro', 'enterprise') and reassigns users; no schema change needed.
    CREATE TABLE IF NOT EXISTS roles (
      name                 TEXT PRIMARY KEY,
      max_uploads          INTEGER NOT NULL,
      max_rows_per_upload  INTEGER NOT NULL,
      max_subscribers      INTEGER,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO roles (name, max_uploads, max_rows_per_upload, max_subscribers)
    VALUES ('free', 5, 5000, 25000)
    ON CONFLICT (name) DO NOTHING;

    CREATE TABLE IF NOT EXISTS users (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email        TEXT UNIQUE NOT NULL,
      role         TEXT NOT NULL DEFAULT 'free' REFERENCES roles(name),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS login_tokens (
      token_hash   TEXT PRIMARY KEY,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at   TIMESTAMPTZ NOT NULL,
      used_at      TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS uploads (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename      TEXT NOT NULL,
      row_count     INTEGER NOT NULL,
      email_column  TEXT NOT NULL,
      columns       JSONB NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    -- One row per data row of the original CSV. Each gets a UUID v4.
    CREATE TABLE IF NOT EXISTS records (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      upload_id   UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
      row_index   INTEGER NOT NULL,
      email       TEXT,
      data        JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_uploads_user ON uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_records_upload ON records(upload_id);
    CREATE INDEX IF NOT EXISTS idx_tokens_user ON login_tokens(user_id);
  `);
}

export async function countUploads(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM uploads WHERE user_id = $1',
    [userId]
  );
  return rows[0].n;
}
