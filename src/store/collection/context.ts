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


import { createHash } from "crypto";


// Note: node:path resolve is not imported — we export our own cross-platform resolve()


import { parseVirtualPath } from "../index.js";
import type {
    CollectionConfig,
    ContextMap
} from "../../collections.js";
import { getStoreCollection, getStoreCollections, upsertStoreCollection } from "./crud.js";


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function getStoreGlobalContext(db: Database): string | undefined {
  const row = db.prepare(`SELECT value FROM store_config WHERE key = 'global_context'`).get() as { value: string } | null | undefined;
  if (row == null) return undefined;
  return row.value || undefined;
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function getStoreContexts(db: Database): Array<{ collection: string; path: string; context: string }> {
  const results: Array<{ collection: string; path: string; context: string }> = [];

  // Global context
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    results.push({ collection: "*", path: "/", context: globalCtx });
  }

  // Collection contexts
  const rows = db.prepare(`SELECT name, context FROM store_collections WHERE context IS NOT NULL`).all() as { name: string; context: string }[];
  for (const row of rows) {
    const ctxMap = JSON.parse(row.context) as ContextMap;
    for (const [path, context] of Object.entries(ctxMap)) {
      results.push({ collection: row.name, path, context });
    }
  }

  return results;
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function updateStoreContext(db: Database, collectionName: string, path: string, text: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;

  const ctxMap: ContextMap = row.context ? JSON.parse(row.context) : {};
  ctxMap[path] = text;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(JSON.stringify(ctxMap), collectionName);
  return true;
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function removeStoreContext(db: Database, collectionName: string, path: string): boolean {
  const row = db.prepare(`SELECT context FROM store_collections WHERE name = ?`).get(collectionName) as { context: string | null } | null | undefined;
  if (row == null) return false;
  if (!row.context) return false;

  const ctxMap: ContextMap = JSON.parse(row.context);
  if (!(path in ctxMap)) return false;

  delete ctxMap[path];
  const newCtx = Object.keys(ctxMap).length > 0 ? JSON.stringify(ctxMap) : null;
  db.prepare(`UPDATE store_collections SET context = ? WHERE name = ?`).run(newCtx, collectionName);
  return true;
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function setStoreGlobalContext(db: Database, value: string | undefined): void {
  if (value === undefined) {
    db.prepare(`DELETE FROM store_config WHERE key = 'global_context'`).run();
  } else {
    db.prepare(`INSERT INTO store_config (key, value) VALUES ('global_context', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(value);
  }
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

/**
 * Sync external config (YAML/inline) into SQLite store_collections.
 * External config always wins. Skips sync if config hash hasn't changed.
 */
export function syncConfigToDb(db: Database, config: CollectionConfig): void {
  // Check config hash — skip sync if unchanged
  const configJson = JSON.stringify(config);
  const hash = createHash('sha256').update(configJson).digest('hex');

  const existingHash = db.prepare(`SELECT value FROM store_config WHERE key = 'config_hash'`).get() as { value: string } | null | undefined;
  if (existingHash != null && existingHash.value === hash) {
    return; // Config unchanged, skip sync
  }

  // Sync collections
  const configNames = new Set(Object.keys(config.collections));

  for (const [name, coll] of Object.entries(config.collections)) {
    upsertStoreCollection(db, name, coll);
  }

  // Delete collections not in config
  const dbCollections = db.prepare(`SELECT name FROM store_collections`).all() as { name: string }[];
  for (const row of dbCollections) {
    if (!configNames.has(row.name)) {
      db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(row.name);
    }
  }

  // Sync global context
  if (config.global_context !== undefined) {
    setStoreGlobalContext(db, config.global_context);
  } else {
    setStoreGlobalContext(db, undefined);
  }

  // Save config hash
  db.prepare(`INSERT INTO store_config (key, value) VALUES ('config_hash', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(hash);
}


// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path using hierarchical inheritance.
 * Contexts are collection-scoped and inherit from parent directories.
 * For example, context at "/talks" applies to "/talks/2024/keynote.md".
 *
 * @param db Database instance (unused - kept for compatibility)
 * @param collectionName Collection name
 * @param path Relative path within the collection
 * @returns Context string or null if no context is defined
 */
export function getContextForPath(db: Database, collectionName: string, path: string): string | null {
  const coll = getStoreCollection(db, collectionName);

  if (!coll) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}


// =============================================================================
// Context
// =============================================================================

/**
 * Get context for a file path (virtual or filesystem).
 * Resolves the collection and relative path from the DB store_collections table.
 */
export function getContextForFile(db: Database, filepath: string): string | null {
  // Handle undefined or null filepath
  if (!filepath) return null;

  // Get all collections from DB
  const collections = getStoreCollections(db);

  // Parse virtual path format: qmd://collection/path
  let collectionName: string | null = null;
  let relativePath: string | null = null;

  const parsedVirtual = filepath.startsWith('qmd://') ? parseVirtualPath(filepath) : null;
  if (parsedVirtual) {
    collectionName = parsedVirtual.collectionName;
    relativePath = parsedVirtual.path;
  } else {
    // Filesystem path: find which collection this absolute path belongs to
    for (const coll of collections) {
      // Skip collections with missing paths
      if (!coll || !coll.path) continue;

      if (filepath.startsWith(coll.path + '/') || filepath === coll.path) {
        collectionName = coll.name;
        // Extract relative path
        relativePath = filepath.startsWith(coll.path + '/')
          ? filepath.slice(coll.path.length + 1)
          : '';
        break;
      }
    }

    if (!collectionName || relativePath === null) return null;
  }

  // Get the collection from DB
  const coll = getStoreCollection(db, collectionName);
  if (!coll) return null;

  // Verify this document exists in the database
  const doc = db.prepare(`
    SELECT d.path
    FROM documents d
    WHERE d.collection = ? AND d.path = ? AND d.active = 1
    LIMIT 1
  `).get(collectionName, relativePath) as { path: string } | null;

  if (!doc) return null;

  // Collect ALL matching contexts (global + all path prefixes)
  const contexts: string[] = [];

  // Add global context if present
  const globalCtx = getStoreGlobalContext(db);
  if (globalCtx) {
    contexts.push(globalCtx);
  }

  // Add all matching path contexts (from most general to most specific)
  if (coll.context) {
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;

    // Collect all matching prefixes
    const matchingContexts: { prefix: string; context: string }[] = [];
    for (const [prefix, context] of Object.entries(coll.context)) {
      const normalizedPrefix = prefix.startsWith("/") ? prefix : `/${prefix}`;
      if (normalizedPath.startsWith(normalizedPrefix)) {
        matchingContexts.push({ prefix: normalizedPrefix, context });
      }
    }

    // Sort by prefix length (shortest/most general first)
    matchingContexts.sort((a, b) => a.prefix.length - b.prefix.length);

    // Add all matching contexts
    for (const match of matchingContexts) {
      contexts.push(match.context);
    }
  }

  // Join all contexts with double newline
  return contexts.length > 0 ? contexts.join('\n\n') : null;
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Insert or update a context for a specific collection and path prefix.
 */
export function insertContext(db: Database, collectionId: number, pathPrefix: string, context: string): void {
  // Get collection name from ID
  const coll = db.prepare(`SELECT name FROM collections WHERE id = ?`).get(collectionId) as { name: string } | null;
  if (!coll) {
    throw new Error(`Collection with id ${collectionId} not found`);
  }

  // Add context to store_collections
  updateStoreContext(db, coll.name, pathPrefix, context);
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Delete a context for a specific collection and path prefix.
 * Returns the number of contexts deleted.
 */
export function deleteContext(db: Database, collectionName: string, pathPrefix: string): number {
  // Remove context from store_collections
  const success = removeStoreContext(db, collectionName, pathPrefix);
  return success ? 1 : 0;
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Delete all global contexts (contexts with empty path_prefix).
 * Returns the number of contexts deleted.
 */
export function deleteGlobalContexts(db: Database): number {
  let deletedCount = 0;

  // Remove global context
  setStoreGlobalContext(db, undefined);
  deletedCount++;

  // Remove root context (empty string) from all collections
  const collections = getStoreCollections(db);
  for (const coll of collections) {
    const success = removeStoreContext(db, coll.name, '');
    if (success) {
      deletedCount++;
    }
  }

  return deletedCount;
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * List all contexts, grouped by collection.
 * Returns contexts ordered by collection name, then by path prefix length (longest first).
 */
export function listPathContexts(db: Database): { collection_name: string; path_prefix: string; context: string }[] {
  const allContexts = getStoreContexts(db);

  // Convert to expected format and sort
  return allContexts.map(ctx => ({
    collection_name: ctx.collection,
    path_prefix: ctx.path,
    context: ctx.context,
  })).sort((a, b) => {
    // Sort by collection name first
    if (a.collection_name !== b.collection_name) {
      return a.collection_name.localeCompare(b.collection_name);
    }
    // Then by path prefix length (longest first)
    if (a.path_prefix.length !== b.path_prefix.length) {
      return b.path_prefix.length - a.path_prefix.length;
    }
    // Then alphabetically
    return a.path_prefix.localeCompare(b.path_prefix);
  });
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================

/**
 * Get top-level directories in a collection that don't have context.
 * Useful for suggesting where context might be needed.
 */
export function getTopLevelPathsWithoutContext(db: Database, collectionName: string): string[] {
  // Get all paths in the collection from database
  const paths = db.prepare(`
    SELECT DISTINCT path FROM documents
    WHERE collection = ? AND active = 1
  `).all(collectionName) as { path: string }[];

  // Get existing contexts for this collection from DB
  const dbColl = getStoreCollection(db, collectionName);
  if (!dbColl) return [];

  const contextPrefixes = new Set<string>();
  if (dbColl.context) {
    for (const prefix of Object.keys(dbColl.context)) {
      contextPrefixes.add(prefix);
    }
  }

  // Extract top-level directories (first path component)
  const topLevelDirs = new Set<string>();
  for (const { path } of paths) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length > 1) {
      const dir = parts[0];
      if (dir) topLevelDirs.add(dir);
    }
  }

  // Filter out directories that already have context (exact or parent)
  const missing: string[] = [];
  for (const dir of topLevelDirs) {
    let hasContext = false;

    // Check if this dir or any parent has context
    for (const prefix of contextPrefixes) {
      if (prefix === '' || prefix === dir || dir.startsWith(prefix + '/')) {
        hasContext = true;
        break;
      }
    }

    if (!hasContext) {
      missing.push(dir);
    }
  }

  return missing.sort();
}
