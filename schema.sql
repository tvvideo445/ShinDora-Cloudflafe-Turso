-- SCHEMA CLOUDFLARE D1 DATABASE UNTUK SHINDORA STREAM
-- Jalankan perintah: npx wrangler d1 execute shindora-db --file=./schema.sql

-- 1. Tabel Links (Metadata Video, Sources & Subtitles)
CREATE TABLE IF NOT EXISTS links (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    original_url TEXT NOT NULL,
    poster_url TEXT DEFAULT '',
    sources_json TEXT NOT NULL,
    subtitles_json TEXT DEFAULT '[]',
    host_type TEXT DEFAULT 'vk',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Indexing untuk pencarian cepat berdasarkan slug
CREATE INDEX IF NOT EXISTS idx_links_slug ON links(slug);
CREATE INDEX IF NOT EXISTS idx_links_updated_at ON links(updated_at);

-- 2. Tabel Settings (Admin, Player, CDN, VAST Ads, ImageKit)
CREATE TABLE IF NOT EXISTS settings (
    type TEXT PRIMARY KEY,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 3. Tabel Sessions (Sesi Login Admin)
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    refresh_token TEXT NOT NULL,
    username TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    refresh_expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_refresh ON sessions(refresh_token);

-- SEED DATA DEFAULT
-- Akun Admin Bawaan: admin / admin123
INSERT OR IGNORE INTO settings (type, data_json, created_at, updated_at) 
VALUES ('admin', '{"username":"admin","password":"admin123"}', datetime('now'), datetime('now'));

-- Pengaturan Player Bawaan
INSERT OR IGNORE INTO settings (type, data_json, created_at, updated_at) 
VALUES ('player', '{"playerType":"jwplayer","autoplay":true,"vastEnabled":false,"vastTags":[],"isAdblockEnabled":false}', datetime('now'), datetime('now'));

-- Pengaturan CDN & General Bawaan
INSERT OR IGNORE INTO settings (type, data_json, created_at, updated_at) 
VALUES ('general', '{"cdnUrl":"","downloadCdnUrl":"","isCustomDownloadCdnEnabled":false,"vkServiceToken":""}', datetime('now'), datetime('now'));

-- Pengaturan ImageKit Bawaan
INSERT OR IGNORE INTO settings (type, data_json, created_at, updated_at) 
VALUES ('imagekit', '{"publicKey":"","privateKey":"","urlEndpoint":""}', datetime('now'), datetime('now'));
