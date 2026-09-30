// SQLite storage for accounts, sessions, purchases and per-question usage.
// DATA_DIR points at a persistent volume in production (fly.toml mounts /data).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import Database from "better-sqlite3";

const DATA_DIR = process.env.DATA_DIR || "data";
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new Database(path.join(DATA_DIR, "app.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    questions_left INTEGER NOT NULL DEFAULT 0,
    access_until INTEGER,               -- ms epoch; paid questions expire after this
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    stripe_session_id TEXT NOT NULL UNIQUE, -- makes webhook retries idempotent
    amount INTEGER NOT NULL,                -- agorot
    currency TEXT NOT NULL,
    questions INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    cost_usd REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const newToken = () => crypto.randomBytes(32).toString("base64url");

// Passwords: scrypt with a per-user salt, stored as "salt:hash".
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const given = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(given, Buffer.from(hash, "hex"));
}
