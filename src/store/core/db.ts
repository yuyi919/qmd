/**
 * QMD Store - Core data access and retrieval functions
 *
 * This module provides all database operations, search functions, and document
 * retrieval for QMD. It returns raw data structures that can be formatted by
 * CLI or MCP consumers.
 *
 * Usage:
 *   const store = createStore("/path/to/db.sqlite");
 *   // or use default path:
 *   const store = createStore();
 */

import { loadSqliteVec } from "../../db.js";

import type { Database } from "../../db.js";



import { mkdirSync, realpathSync } from "node:fs";

// Note: node:path resolve is not imported — we export our own cross-platform resolve()
import { homedir } from "node:os";
import { resolve } from "../utils/path.js";

// =============================================================================
// Database initialization
// =============================================================================


export function createSqliteVecUnavailableError(reason: string): Error {
  return new Error(
    "sqlite-vec extension is unavailable. " +
    `${reason}. ` +
    "Install Homebrew SQLite so the sqlite-vec extension can be loaded, " +
    "and set BREW_PREFIX if Homebrew is installed in a non-standard location."
  );
}


// =============================================================================
// Database initialization
// =============================================================================
export let _sqliteVecUnavailableReason: string | null = null;


// =============================================================================
// Database initialization
// =============================================================================

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


// =============================================================================
// Database initialization
// =============================================================================

export function verifySqliteVecLoaded(db: Database): void {
  try {
    const row = db.prepare(`SELECT vec_version() AS version`).get() as { version?: string } | null;
    if (!row?.version || typeof row.version !== "string") {
      throw new Error("vec_version() returned no version");
    }
  } catch (err) {
    const message = getErrorMessage(err);
    throw createSqliteVecUnavailableError(`sqlite-vec probe failed (${message})`);
  }
}


// =============================================================================
// Database initialization
// =============================================================================
export let _sqliteVecAvailable: boolean | null = null;


// =============================================================================
// Database initialization
// =============================================================================

export function initializeDatabase(db: Database): void {
  try {
    loadSqliteVec(db);
    verifySqliteVecLoaded(db);
    _sqliteVecAvailable = true;
    _sqliteVecUnavailableReason = null;
  } catch (err) {
    // sqlite-vec is optional — vector search won't work but FTS is fine
    _sqliteVecAvailable = false;
    _sqliteVecUnavailableReason = getErrorMessage(err);
    console.warn(_sqliteVecUnavailableReason);
  }
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Drop legacy tables that are now managed in YAML
  db.exec(`DROP TABLE IF EXISTS path_contexts`);
  db.exec(`DROP TABLE IF EXISTS collections`);

  // Content-addressable storage - the source of truth for document content
  db.exec(`
    CREATE TABLE IF NOT EXISTS content (
      hash TEXT PRIMARY KEY,
      doc TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Documents table - file system layer mapping virtual paths to content hashes
  // Collections are now managed in ~/.config/qmd/index.yml
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT NOT NULL,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (hash) REFERENCES content(hash) ON DELETE CASCADE,
      UNIQUE(collection, path)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection, active)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_hash ON documents(hash)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_documents_path ON documents(path, active)`);

  // Cache table for LLM API calls
  db.exec(`
    CREATE TABLE IF NOT EXISTS llm_cache (
      hash TEXT PRIMARY KEY,
      result TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  // Content vectors
  const cvInfo = db.prepare(`PRAGMA table_info(content_vectors)`).all() as { name: string }[];
  const hasSeqColumn = cvInfo.some(col => col.name === 'seq');
  if (cvInfo.length > 0 && !hasSeqColumn) {
    db.exec(`DROP TABLE IF EXISTS content_vectors`);
    db.exec(`DROP TABLE IF EXISTS vectors_vec`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_vectors (
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL DEFAULT 0,
      pos INTEGER NOT NULL DEFAULT 0,
      model TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      PRIMARY KEY (hash, seq)
    )
  `);

  // Store collections — makes the DB self-contained (no external config needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_collections (
      name TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      pattern TEXT NOT NULL DEFAULT '**/*.md',
      ignore_patterns TEXT,
      include_by_default INTEGER DEFAULT 1,
      update_command TEXT,
      context TEXT
    )
  `);

  // Store config — key-value metadata (e.g. config_hash for sync optimization)
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_config (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // FTS - index filepath (collection/path), title, and content
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      filepath, title, body,
      tokenize='porter unicode61'
    )
  `);

  // Triggers to keep FTS in sync
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ai AFTER INSERT ON documents
    WHEN new.active = 1
    BEGIN
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      DELETE FROM documents_fts WHERE rowid = old.id;
    END
  `);

  db.exec(`
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents
    BEGIN
      -- Delete from FTS if no longer active
      DELETE FROM documents_fts WHERE rowid = old.id AND new.active = 0;

      -- Update FTS if still/newly active
      INSERT OR REPLACE INTO documents_fts(rowid, filepath, title, body)
      SELECT
        new.id,
        new.collection || '/' || new.path,
        new.title,
        (SELECT doc FROM content WHERE hash = new.hash)
      WHERE new.active = 1;
    END
  `);
}



export function isSqliteVecAvailable(): boolean {
  return _sqliteVecAvailable === true;
}


export function ensureVecTableInternal(db: Database, dimensions: number): void {
  if (!_sqliteVecAvailable) {
    throw createSqliteVecUnavailableError(
      _sqliteVecUnavailableReason ?? "vector operations require a SQLite build with extension loading support"
    );
  }
  const tableInfo = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get() as { sql: string } | null;
  if (tableInfo) {
    const match = tableInfo.sql.match(/float\[(\d+)\]/);
    const hasHashSeq = tableInfo.sql.includes('hash_seq');
    const hasCosine = tableInfo.sql.includes('distance_metric=cosine');
    const existingDims = match?.[1] ? parseInt(match[1], 10) : null;
    if (existingDims === dimensions && hasHashSeq && hasCosine) return;
    if (existingDims !== null && existingDims !== dimensions) {
      throw new Error(
        `Embedding dimension mismatch: existing vectors are ${existingDims}d but the current model produces ${dimensions}d. ` +
        `Run 'qmd embed -f' to re-embed with the new model.`
      );
    }
    db.exec("DROP TABLE IF EXISTS vectors_vec");
  }
  db.exec(`CREATE VIRTUAL TABLE vectors_vec USING vec0(hash_seq TEXT PRIMARY KEY, embedding float[${dimensions}] distance_metric=cosine)`);
}


export function getDefaultDbPath(indexName: string = "index"): string {
  // Always allow override via INDEX_PATH (for testing)
  if (process.env.INDEX_PATH) {
    return process.env.INDEX_PATH;
  }

  // In non-production mode (tests), require explicit path
  if (!_productionMode) {
    throw new Error(
      "Database path not set. Tests must set INDEX_PATH env var or use createStore() with explicit path. " +
      "This prevents tests from accidentally writing to the global index."
    );
  }

  const cacheDir = process.env.XDG_CACHE_HOME || resolve(homedir(), ".cache");
  const qmdCacheDir = resolve(cacheDir, "qmd");
  try { mkdirSync(qmdCacheDir, { recursive: true }); } catch { }
  return resolve(qmdCacheDir, `${indexName}.sqlite`);
}


export function getPwd(): string {
  return process.env.PWD || process.cwd();
}


export function getRealPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}


// Flag to indicate production mode (set by qmd.ts at startup)

export function enableProductionMode(): void {
  _productionMode = true;
}


// Flag to indicate production mode (set by qmd.ts at startup)

/** Reset production mode flag — only for testing. */
export function _resetProductionModeForTesting(): void {
  _productionMode = false;
}

export let _productionMode = false;
