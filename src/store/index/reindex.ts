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


import type { Database } from "../../db.js";

import picomatch from "picomatch";


import { readFileSync, statSync } from "node:fs";

// Note: node:path resolve is not imported — we export our own cross-platform resolve()
import fastGlob from "fast-glob";
import { hashContent } from "../index.js";
import { titleExtractors } from "../core/constants.js";
import { getRealPath } from "../core/db.js";
import type { ReindexProgress, ReindexResult, Store } from "../types/index.js";
import { cleanupOrphanedContent } from "./health.js";
import { resolve } from "../utils/path.js";

// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================
// =============================================================================
// Store Factory
// =============================================================================
// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================

/**
 * Re-index a single collection by scanning the filesystem and updating the database.
 * Pure function — no console output, no db lifecycle management.
 */
export async function reindexCollection(
  store: Store,
  collectionPath: string,
  globPattern: string,
  collectionName: string,
  options?: {
    ignorePatterns?: string[];
    onProgress?: (info: ReindexProgress) => void;
  }
): Promise<ReindexResult> {
  const db = store.db;
  const now = new Date().toISOString();
  const excludeDirs = ["node_modules", ".git", ".cache", "vendor", "dist", "build"];

  const allIgnore = [
    ...excludeDirs.map(d => `**/${d}/**`),
    ...(options?.ignorePatterns || []),
  ];
  const allFiles: string[] = await fastGlob(globPattern, {
    cwd: collectionPath,
    onlyFiles: true,
    followSymbolicLinks: false,
    dot: false,
    ignore: allIgnore,
  });
  // Filter hidden files/folders
  const files = allFiles.filter(file => {
    const parts = file.split("/");
    return !parts.some(part => part.startsWith("."));
  });

  const total = files.length;
  let indexed = 0, updated = 0, unchanged = 0, processed = 0;
  const seenPaths = new Set<string>();

  for (const relativeFile of files) {
    const filepath = getRealPath(resolve(collectionPath, relativeFile));
    const path = handelize(relativeFile);
    seenPaths.add(path);

    let content: string;
    try {
      content = readFileSync(filepath, "utf-8");
    } catch {
      processed++;
      options?.onProgress?.({ file: relativeFile, current: processed, total });
      continue;
    }

    if (!content.trim()) {
      processed++;
      continue;
    }

    const hash = await hashContent(content);
    const title = extractTitle(content, relativeFile);

    const existing = findOrMigrateLegacyDocument(db, collectionName, path);

    if (existing) {
      if (existing.hash === hash) {
        if (existing.title !== title) {
          updateDocumentTitle(db, existing.id, title, now);
          updated++;
        } else {
          unchanged++;
        }
      } else {
        insertContent(db, hash, content, now);
        const stat = statSync(filepath);
        updateDocument(db, existing.id, title, hash,
          stat ? new Date(stat.mtime).toISOString() : now);
        updated++;
      }
    } else {
      indexed++;
      insertContent(db, hash, content, now);
      const stat = statSync(filepath);
      insertDocument(db, collectionName, path, title, hash,
        stat ? new Date(stat.birthtime).toISOString() : now,
        stat ? new Date(stat.mtime).toISOString() : now);
    }

    processed++;
    options?.onProgress?.({ file: relativeFile, current: processed, total });
  }

  // Deactivate documents that no longer exist
  const allActive = getActiveDocumentPaths(db, collectionName);
  let removed = 0;
  for (const path of allActive) {
    if (!seenPaths.has(path)) {
      deactivateDocument(db, collectionName, path);
      removed++;
    }
  }

  const orphanedCleaned = cleanupOrphanedContent(db);

  return { indexed, updated, unchanged, removed, orphanedCleaned };
}


/**
 * Update an existing document's hash, title, and modified_at timestamp.
 * Used when content changes but the file path stays the same.
 */
export function updateDocument(
  db: Database,
  documentId: number,
  title: string,
  hash: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, hash = ?, modified_at = ? WHERE id = ?`)
    .run(title, hash, modifiedAt, documentId);
}


/**
 * Insert a new document into the documents table.
 */
export function insertDocument(
  db: Database,
  collectionName: string,
  path: string,
  title: string,
  hash: string,
  createdAt: string,
  modifiedAt: string
): void {
  db.prepare(`
    INSERT INTO documents (collection, path, title, hash, created_at, modified_at, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(collection, path) DO UPDATE SET
      title = excluded.title,
      hash = excluded.hash,
      modified_at = excluded.modified_at,
      active = 1
  `).run(collectionName, path, title, hash, createdAt, modifiedAt);
}


/**
 * Find an active document by collection name and path.
 */
export function findActiveDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const row = db.prepare(`
    SELECT id, hash, title FROM documents
    WHERE collection = ? AND path = ? AND active = 1
  `).get(collectionName, path) as { id: number; hash: string; title: string } | undefined;
  return row ?? null;
}


/**
 * Find an active document, falling back to a legacy lowercase path.
 * If found under the legacy path, renames it in-place and rebuilds the
 * FTS entry. Embeddings are keyed by content hash, so the rename is
 * safe — no re-embedding required.
 *
 * @internal Used by reindexCollection and indexFiles during qmd update.
 * Returns null if the document does not exist under either path.
 */
export function findOrMigrateLegacyDocument(
  db: Database,
  collectionName: string,
  path: string
): { id: number; hash: string; title: string } | null {
  const existing = findActiveDocument(db, collectionName, path);
  if (existing) return existing;

  const legacyPath = path.toLowerCase();
  if (legacyPath === path) return null;

  const legacy = findActiveDocument(db, collectionName, legacyPath);
  if (!legacy) return null;

  // Wrap rename + FTS rebuild in a transaction for atomicity.
  const migrate = db.transaction(() => {
    // Use OR IGNORE so a UNIQUE conflict (e.g. both "readme.md" and
    // "README.md" already exist) is a no-op rather than crashing.
    const result = db.prepare(
      `UPDATE OR IGNORE documents SET path = ? WHERE id = ? AND active = 1`
    ).run(path, legacy.id);

    if (result.changes === 0) return false;

    // FTS5 does not reliably update via the documents_au trigger's
    // INSERT OR REPLACE. Manually rebuild the FTS entry.
    db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`).run(legacy.id);
    db.prepare(`
      INSERT INTO documents_fts(rowid, filepath, title, body)
      SELECT id, collection || '/' || path, title,
             (SELECT doc FROM content WHERE hash = documents.hash)
      FROM documents WHERE id = ?
    `).run(legacy.id);

    return true;
  });

  if (!migrate()) return null;

  return findActiveDocument(db, collectionName, path);
}


/**
 * Update the title and modified_at timestamp for a document.
 */
export function updateDocumentTitle(
  db: Database,
  documentId: number,
  title: string,
  modifiedAt: string
): void {
  db.prepare(`UPDATE documents SET title = ?, modified_at = ? WHERE id = ?`)
    .run(title, modifiedAt, documentId);
}


/**
 * Deactivate a document (mark as inactive but don't delete).
 */
export function deactivateDocument(db: Database, collectionName: string, path: string): void {
  db.prepare(`UPDATE documents SET active = 0 WHERE collection = ? AND path = ? AND active = 1`)
    .run(collectionName, path);
}


/**
 * Get all active document paths for a collection.
 */
export function getActiveDocumentPaths(db: Database, collectionName: string): string[] {
  const rows = db.prepare(`
    SELECT path FROM documents WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];
  return rows.map(r => r.path);
}


export function extractTitle(content: string, filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  const extractor = titleExtractors[ext];
  if (extractor) {
    const title = extractor(content);
    if (title) return title;
  }
  return filename.replace(/\.[^.]+$/, "").split("/").pop() || filename;
}


/**
 * Normalize a docid input by stripping surrounding quotes and leading #.
 * Handles: "#abc123", 'abc123', "abc123", #abc123, abc123
 * Returns the bare hex string.
 */
export function normalizeDocid(docid: string): string {
  let normalized = docid.trim();

  // Strip surrounding quotes (single or double)
  if ((normalized.startsWith('"') && normalized.endsWith('"')) ||
      (normalized.startsWith("'") && normalized.endsWith("'"))) {
    normalized = normalized.slice(1, -1);
  }

  // Strip leading # if present
  if (normalized.startsWith('#')) {
    normalized = normalized.slice(1);
  }

  return normalized;
}


/**
 * Check if a string looks like a docid reference.
 * Accepts: #abc123, abc123, "#abc123", "abc123", '#abc123', 'abc123'
 * Returns true if the normalized form is a valid hex string of 6+ chars.
 */
export function isDocid(input: string): boolean {
  const normalized = normalizeDocid(input);
  // Must be at least 6 hex characters
  return normalized.length >= 6 && /^[a-f0-9]+$/i.test(normalized);
}


// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Extract short docid from a full hash (first 6 characters).
 */
export function getDocid(hash: string): string {
  return hash.slice(0, 6);
}


export function handelize(path: string): string {
  if (!path || path.trim() === '') {
    throw new Error('handelize: path cannot be empty');
  }

  // Allow route-style "$" filenames while still rejecting paths with no usable content.
  // Emoji (\p{So}) counts as valid content — they get converted to hex codepoints below.
  const segments = path.split('/').filter(Boolean);
  const lastSegment = segments[segments.length - 1] || '';
  const filenameWithoutExt = lastSegment.replace(/\.[^.]+$/, '');
  const hasValidContent = /[\p{L}\p{N}\p{So}\p{Sk}$]/u.test(filenameWithoutExt);
  if (!hasValidContent) {
    throw new Error(`handelize: path "${path}" has no valid filename content`);
  }

  const result = path
    .replace(/___/g, '/')       // Triple underscore becomes folder separator
    .split('/')
    .map((segment, idx, arr) => {
      const isLastSegment = idx === arr.length - 1;

      // Convert emoji to hex codepoints before cleaning
      segment = emojiToHex(segment);

      if (isLastSegment) {
        // For the filename (last segment), preserve the extension
        const extMatch = segment.match(/(\.[a-z0-9]+)$/i);
        const ext = extMatch ? extMatch[1] : '';
        const nameWithoutExt = ext ? segment.slice(0, -ext.length) : segment;

        const cleanedName = nameWithoutExt
          .replace(/[^\p{L}\p{N}$]+/gu, '-')  // Keep letters, numbers, "$"; dash-separate rest (including dots)
          .replace(/^-+|-+$/g, ''); // Remove leading/trailing dashes

        return cleanedName + ext;
      } else {
        // For directories, just clean normally
        return segment
          .replace(/[^\p{L}\p{N}$]+/gu, '-')
          .replace(/^-+|-+$/g, '');
      }
    })
    .filter(Boolean)
    .join('/');

  if (!result) {
    throw new Error(`handelize: path "${path}" resulted in empty string after processing`);
  }

  return result;
}


export function matchFilesByGlob(db: Database, pattern: string): { filepath: string; displayPath: string; bodyLength: number }[] {
  const allFiles = db.prepare(`
    SELECT
      'qmd://' || d.collection || '/' || d.path as virtual_path,
      LENGTH(content.doc) as body_length,
      d.path,
      d.collection
    FROM documents d
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `).all() as { virtual_path: string; body_length: number; path: string; collection: string }[];

  const isMatch = picomatch(pattern);
  return allFiles
    .filter(f => isMatch(f.virtual_path) || isMatch(f.path) || isMatch(f.collection + '/' + f.path))
    .map(f => ({
      filepath: f.virtual_path,  // Virtual path for precise lookup
      displayPath: f.path,        // Relative path for display
      bodyLength: f.body_length
    }));
}


export function findSimilarFiles(db: Database, query: string, maxDistance: number = 3, limit: number = 5): string[] {
  const allFiles = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.active = 1
  `).all() as { path: string }[];
  const queryLower = query.toLowerCase();
  const scored = allFiles
    .map(f => ({ path: f.path, dist: levenshtein(f.path.toLowerCase(), queryLower) }))
    .filter(f => f.dist <= maxDistance)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, limit);
  return scored.map(f => f.path);
}


// =============================================================================
// Fuzzy matching
// =============================================================================

export function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i]![0] = i;
  for (let j = 0; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost
      );
    }
  }
  return dp[m]![n]!;
}


// =============================================================================
// Document indexing operations
// =============================================================================

/**
 * Insert content into the content table (content-addressable storage).
 * Uses INSERT OR IGNORE so duplicate hashes are skipped.
 */
export function insertContent(db: Database, hash: string, content: string, createdAt: string): void {
  db.prepare(`INSERT OR IGNORE INTO content (hash, doc, created_at) VALUES (?, ?, ?)`)
    .run(hash, content, createdAt);
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================
// =============================================================================
// Store Factory
// =============================================================================
// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================
// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Handelize a filename to be more token-friendly.
 * - Convert triple underscore `___` to `/` (folder separator)
 * - Replace sequences of non-word chars (except /) with single dash
 * - Remove leading/trailing dashes from path segments
 * - Preserve folder structure (a/b/c/d.md stays structured)
 * - Preserve file extension
 * - Preserve original case (important for case-sensitive filesystems)
 */
/** Replace emoji/symbol codepoints with their hex representation (e.g. 🐘 → 1f418) */
export function emojiToHex(str: string): string {
  return str.replace(/(?:\p{So}\p{Mn}?|\p{Sk})+/gu, (run) => {
    // Split the run into individual emoji and convert each to hex, dash-separated
    return [...run].filter(c => /\p{So}|\p{Sk}/u.test(c))
      .map(c => c.codePointAt(0)!.toString(16)).join('-');
  });
}
