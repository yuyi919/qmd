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




// =============================================================================
// Index health
// =============================================================================
// =============================================================================
// Caching
// =============================================================================

export function getCacheKey(url: string, body: object): string {
  const hash = createHash("sha256");
  hash.update(url);
  hash.update(JSON.stringify(body));
  return hash.digest("hex");
}


// =============================================================================
// Index health
// =============================================================================
// =============================================================================
// Caching
// =============================================================================

export function getCachedResult(db: Database, cacheKey: string): string | null {
  const row = db.prepare(`SELECT result FROM llm_cache WHERE hash = ?`).get(cacheKey) as { result: string } | null;
  return row?.result || null;
}


// =============================================================================
// Index health
// =============================================================================
// =============================================================================
// Caching
// =============================================================================

export function setCachedResult(db: Database, cacheKey: string, result: string): void {
  const now = new Date().toISOString();
  db.prepare(`INSERT OR REPLACE INTO llm_cache (hash, result, created_at) VALUES (?, ?, ?)`).run(cacheKey, result, now);
  if (Math.random() < 0.01) {
    db.exec(`DELETE FROM llm_cache WHERE hash NOT IN (SELECT hash FROM llm_cache ORDER BY created_at DESC LIMIT 1000)`);
  }
}


// =============================================================================
// Index health
// =============================================================================
// =============================================================================
// Caching
// =============================================================================

export function clearCache(db: Database): void {
  db.exec(`DELETE FROM llm_cache`);
}


// =============================================================================
// Index health
// =============================================================================
// =============================================================================
// Caching
// =============================================================================
// =============================================================================
// Cleanup and maintenance operations
// =============================================================================

/**
 * Delete cached LLM API responses.
 * Returns the number of cached responses deleted.
 */
export function deleteLLMCache(db: Database): number {
  const result = db.prepare(`DELETE FROM llm_cache`).run();
  return result.changes;
}
