-- Runs once on first (empty-volume) Postgres boot.
-- pgcrypto is handy if you later add hashing/encryption at the DB layer; harmless otherwise.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
