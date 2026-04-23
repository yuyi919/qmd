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

import { openDatabase } from "../../db.js";





// Note: node:path resolve is not imported — we export our own cross-platform resolve()

import {
    type ILLMSession
} from "../../llm.js";

import { buildVirtualPath, isVirtualPath, parseVirtualPath, resolveVirtualPath, toVirtualPath } from "../index.js";
import { clearCache, deleteLLMCache, getCacheKey, getCachedResult, setCachedResult } from "../cache/index.js";
import { getContextForFile, getContextForPath, getTopLevelPathsWithoutContext } from "../collection/context.js";
import { getCollectionByName, getCollectionsWithoutContext } from "../collection/crud.js";
import { clearAllEmbeddings, getHashesForEmbedding, getHashesNeedingEmbedding, insertEmbedding } from "../index/embed.js";
import { cleanupOrphanedContent, cleanupOrphanedVectors, deleteInactiveDocuments, getIndexHealth, getStatus, vacuumDatabase } from "../index/health.js";
import { deactivateDocument, findActiveDocument, findOrMigrateLegacyDocument, findSimilarFiles, getActiveDocumentPaths, insertContent, insertDocument, matchFilesByGlob, updateDocument, updateDocumentTitle } from "../index/reindex.js";
import { findDocument, findDocumentByDocid, findDocuments, getDocumentBody } from "../search/document.js";
import { searchFTS } from "../search/fts.js";
import { expandQuery, rerank } from "../search/hybrid.js";
import { searchVec } from "../search/vec.js";
import type { DocumentResult, Store } from "../types/index.js";
import { ensureVecTableInternal, getDefaultDbPath, initializeDatabase } from "./db.js";

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
 * Create a new store instance with the given database path.
 * If no path is provided, uses the default path (~/.cache/qmd/index.sqlite).
 *
 * @param dbPath - Path to the SQLite database file
 * @returns Store instance with all methods bound to the database
 */
export function createStore(dbPath?: string): Store {
  const resolvedPath = dbPath || getDefaultDbPath();
  const db = openDatabase(resolvedPath);
  initializeDatabase(db);

  const store: Store = {
    db,
    dbPath: resolvedPath,
    close: () => db.close(),
    ensureVecTable: (dimensions: number) => ensureVecTableInternal(db, dimensions),

    // Index health
    getHashesNeedingEmbedding: () => getHashesNeedingEmbedding(db),
    getIndexHealth: () => getIndexHealth(db),
    getStatus: () => getStatus(db),

    // Caching
    getCacheKey,
    getCachedResult: (cacheKey: string) => getCachedResult(db, cacheKey),
    setCachedResult: (cacheKey: string, result: string) => setCachedResult(db, cacheKey, result),
    clearCache: () => clearCache(db),

    // Cleanup and maintenance
    deleteLLMCache: () => deleteLLMCache(db),
    deleteInactiveDocuments: () => deleteInactiveDocuments(db),
    cleanupOrphanedContent: () => cleanupOrphanedContent(db),
    cleanupOrphanedVectors: () => cleanupOrphanedVectors(db),
    vacuumDatabase: () => vacuumDatabase(db),

    // Context
    getContextForFile: (filepath: string) => getContextForFile(db, filepath),
    getContextForPath: (collectionName: string, path: string) => getContextForPath(db, collectionName, path),
    getCollectionByName: (name: string) => getCollectionByName(db, name),
    getCollectionsWithoutContext: () => getCollectionsWithoutContext(db),
    getTopLevelPathsWithoutContext: (collectionName: string) => getTopLevelPathsWithoutContext(db, collectionName),

    // Virtual paths
    parseVirtualPath,
    buildVirtualPath,
    isVirtualPath,
    resolveVirtualPath: (virtualPath: string) => resolveVirtualPath(db, virtualPath),
    toVirtualPath: (absolutePath: string) => toVirtualPath(db, absolutePath),

    // Search
    searchFTS: (query: string, limit?: number, collectionName?: string) => searchFTS(db, query, limit, collectionName),
    searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => searchVec(db, query, model, limit, collectionName, session, precomputedEmbedding),

    // Query expansion & reranking
    expandQuery: (query: string, model?: string, intent?: string) => expandQuery(query, model, db, intent, store.llm),
    rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => rerank(query, documents, model, db, intent, store.llm),

    // Document retrieval
    findDocument: (filename: string, options?: { includeBody?: boolean }) => findDocument(db, filename, options),
    getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => getDocumentBody(db, doc, fromLine, maxLines),
    findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => findDocuments(db, pattern, options),

    // Fuzzy matching and docid lookup
    findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => findSimilarFiles(db, query, maxDistance, limit),
    matchFilesByGlob: (pattern: string) => matchFilesByGlob(db, pattern),
    findDocumentByDocid: (docid: string) => findDocumentByDocid(db, docid),

    // Document indexing operations
    insertContent: (hash: string, content: string, createdAt: string) => insertContent(db, hash, content, createdAt),
    insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => insertDocument(db, collectionName, path, title, hash, createdAt, modifiedAt),
    findActiveDocument: (collectionName: string, path: string) => findActiveDocument(db, collectionName, path),
    findOrMigrateLegacyDocument: (collectionName: string, path: string) => findOrMigrateLegacyDocument(db, collectionName, path),
    updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => updateDocumentTitle(db, documentId, title, modifiedAt),
    updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => updateDocument(db, documentId, title, hash, modifiedAt),
    deactivateDocument: (collectionName: string, path: string) => deactivateDocument(db, collectionName, path),
    getActiveDocumentPaths: (collectionName: string) => getActiveDocumentPaths(db, collectionName),

    // Vector/embedding operations
    getHashesForEmbedding: () => getHashesForEmbedding(db),
    clearAllEmbeddings: () => clearAllEmbeddings(db),
    insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => insertEmbedding(db, hash, seq, pos, embedding, model, embeddedAt),
  };

  return store;
}
