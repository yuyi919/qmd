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




// Note: node:path resolve is not imported — we export our own cross-platform resolve()


import type { StoreCollectionRow } from "../types/index.js";
import type {
    Collection,
    ContextMap,
    NamedCollection
} from "../../collections.js";


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function rowToNamedCollection(row: StoreCollectionRow): NamedCollection {
  return {
    name: row.name,
    path: row.path,
    pattern: row.pattern,
    ...(row.ignore_patterns ? { ignore: JSON.parse(row.ignore_patterns) as string[] } : {}),
    ...(row.include_by_default === 0 ? { includeByDefault: false } : {}),
    ...(row.update_command ? { update: row.update_command } : {}),
    ...(row.context ? { context: JSON.parse(row.context) as ContextMap } : {}),
  };
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function getStoreCollections(db: Database): NamedCollection[] {
  const rows = db.prepare(`SELECT * FROM store_collections`).all() as StoreCollectionRow[];
  return rows.map(rowToNamedCollection);
}


// =============================================================================
// Database initialization
// =============================================================================
// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export function getStoreCollection(db: Database, name: string): NamedCollection | null {
  const row = db.prepare(`SELECT * FROM store_collections WHERE name = ?`).get(name) as StoreCollectionRow | null | undefined;
  if (row == null) return null;
  return rowToNamedCollection(row);
}


export function upsertStoreCollection(db: Database, name: string, collection: Omit<Collection, 'pattern'> & { pattern?: string }): void {
  db.prepare(`
    INSERT INTO store_collections (name, path, pattern, ignore_patterns, include_by_default, update_command, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      path = excluded.path,
      pattern = excluded.pattern,
      ignore_patterns = excluded.ignore_patterns,
      include_by_default = excluded.include_by_default,
      update_command = excluded.update_command,
      context = excluded.context
  `).run(
    name,
    collection.path,
    collection.pattern || '**/*.md',
    collection.ignore ? JSON.stringify(collection.ignore) : null,
    collection.includeByDefault === false ? 0 : 1,
    collection.update || null,
    collection.context ? JSON.stringify(collection.context) : null,
  );
}


export function deleteStoreCollection(db: Database, name: string): boolean {
  const result = db.prepare(`DELETE FROM store_collections WHERE name = ?`).run(name);
  return result.changes > 0;
}


export function renameStoreCollection(db: Database, oldName: string, newName: string): boolean {
  // Check target doesn't exist
  const existing = db.prepare(`SELECT name FROM store_collections WHERE name = ?`).get(newName) as { name: string } | null | undefined;
  if (existing != null) {
    throw new Error(`Collection '${newName}' already exists`);
  }

  const result = db.prepare(`UPDATE store_collections SET name = ? WHERE name = ?`).run(newName, oldName);
  return result.changes > 0;
}


/**
 * Get collection by name from DB store_collections table.
 */
export function getCollectionByName(db: Database, name: string): { name: string; pwd: string; glob_pattern: string } | null {
  const collection = getStoreCollection(db, name);
  if (!collection) return null;

  return {
    name: collection.name,
    pwd: collection.path,
    glob_pattern: collection.pattern,
  };
}


/**
 * List all collections with document counts from database.
 * Merges store_collections config with database statistics.
 */
export function listCollections(db: Database): { name: string; pwd: string; glob_pattern: string; doc_count: number; active_count: number; last_modified: string | null; includeByDefault: boolean }[] {
  const collections = getStoreCollections(db);

  // Get document counts from database for each collection
  const result = collections.map(coll => {
    const stats = db.prepare(`
      SELECT
        COUNT(d.id) as doc_count,
        SUM(CASE WHEN d.active = 1 THEN 1 ELSE 0 END) as active_count,
        MAX(d.modified_at) as last_modified
      FROM documents d
      WHERE d.collection = ?
    `).get(coll.name) as { doc_count: number; active_count: number; last_modified: string | null } | null;

    return {
      name: coll.name,
      pwd: coll.path,
      glob_pattern: coll.pattern,
      doc_count: stats?.doc_count || 0,
      active_count: stats?.active_count || 0,
      last_modified: stats?.last_modified || null,
      includeByDefault: coll.includeByDefault !== false,
    };
  });

  return result;
}


/**
 * Remove a collection and clean up its documents.
 * Uses collections.ts to remove from YAML config and cleans up database.
 */
export function removeCollection(db: Database, collectionName: string): { deletedDocs: number; cleanedHashes: number } {
  // Delete documents from database
  const docResult = db.prepare(`DELETE FROM documents WHERE collection = ?`).run(collectionName);

  // Clean up orphaned content hashes
  const cleanupResult = db.prepare(`
    DELETE FROM content
    WHERE hash NOT IN (SELECT DISTINCT hash FROM documents WHERE active = 1)
  `).run();

  // Remove from store_collections
  deleteStoreCollection(db, collectionName);

  return {
    deletedDocs: docResult.changes,
    cleanedHashes: cleanupResult.changes
  };
}


/**
 * Rename a collection.
 * Updates both YAML config and database documents table.
 */
export function renameCollection(db: Database, oldName: string, newName: string): void {
  // Update all documents with the new collection name in database
  db.prepare(`UPDATE documents SET collection = ? WHERE collection = ?`)
    .run(newName, oldName);

  // Rename in store_collections
  renameStoreCollection(db, oldName, newName);
}


/**
 * Get all collections (name only - from YAML config).
 */
export function getAllCollections(db: Database): { name: string }[] {
  const collections = getStoreCollections(db);
  return collections.map(c => ({ name: c.name }));
}


/**
 * Check which collections don't have any context defined.
 * Returns collections that have no context entries at all (not even root context).
 */
export function getCollectionsWithoutContext(db: Database): { name: string; pwd: string; doc_count: number }[] {
  // Get all collections from DB
  const allCollections = getStoreCollections(db);

  // Filter to those without context
  const collectionsWithoutContext: { name: string; pwd: string; doc_count: number }[] = [];

  for (const coll of allCollections) {
    // Check if collection has any context
    if (!coll.context || Object.keys(coll.context).length === 0) {
      // Get doc count from database
      const stats = db.prepare(`
        SELECT COUNT(d.id) as doc_count
        FROM documents d
        WHERE d.collection = ? AND d.active = 1
      `).get(coll.name) as { doc_count: number } | null;

      collectionsWithoutContext.push({
        name: coll.name,
        pwd: coll.path,
        doc_count: stats?.doc_count || 0,
      });
    }
  }

  return collectionsWithoutContext.sort((a, b) => a.name.localeCompare(b.name));
}
