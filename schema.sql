CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('music', 'movie', 'video')),
  content_type TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  file_size INTEGER NOT NULL,
  allow_download INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  r2_upload_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  artist TEXT DEFAULT '',
  description TEXT DEFAULT '',
  category TEXT NOT NULL CHECK (category IN ('music', 'movie', 'video')),
  content_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  allow_download INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_media_published_created ON media(published, created_at);
CREATE INDEX IF NOT EXISTS idx_media_category ON media(category);
