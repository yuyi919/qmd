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

import {
    LlamaCpp,
    type ILLMSession
} from "../../llm.js";

import { buildVirtualPath, isVirtualPath, parseVirtualPath } from "../utils/virtual-path.js";
import type { ChunkStrategy } from "../utils/chunking.js";
import { getCacheKey } from "../cache/index.js";


/**
 * A typed query expansion result. Decoupled from llm.ts internal Queryable —
 * same shape, but store.ts owns its own public API type.
 *
 * - lex: keyword variant → routes to FTS only
 * - vec: semantic variant → routes to vector only
 * - hyde: hypothetical document → routes to vector only
 */
export type ExpandedQuery = {
  type: 'lex' | 'vec' | 'hyde';
  query: string;
  /** Optional line number for error reporting (CLI parser) */
  line?: number;
};


// =============================================================================
// Store Collections — DB accessor functions
// =============================================================================

export type StoreCollectionRow = {
  name: string;
  path: string;
  pattern: string;
  ignore_patterns: string | null;
  include_by_default: number;
  update_command: string | null;
  context: string | null;
};


// =============================================================================
// Store Factory
// =============================================================================

export type Store = {
  db: Database;
  dbPath: string;
  /** Optional LlamaCpp instance for this store (overrides the global singleton) */
  llm?: LlamaCpp;
  close: () => void;
  ensureVecTable: (dimensions: number) => void;

  // Index health
  getHashesNeedingEmbedding: () => number;
  getIndexHealth: () => IndexHealthInfo;
  getStatus: () => IndexStatus;

  // Caching
  getCacheKey: typeof getCacheKey;
  getCachedResult: (cacheKey: string) => string | null;
  setCachedResult: (cacheKey: string, result: string) => void;
  clearCache: () => void;

  // Cleanup and maintenance
  deleteLLMCache: () => number;
  deleteInactiveDocuments: () => number;
  cleanupOrphanedContent: () => number;
  cleanupOrphanedVectors: () => number;
  vacuumDatabase: () => void;

  // Context
  getContextForFile: (filepath: string) => string | null;
  getContextForPath: (collectionName: string, path: string) => string | null;
  getCollectionByName: (name: string) => { name: string; pwd: string; glob_pattern: string } | null;
  getCollectionsWithoutContext: () => { name: string; pwd: string; doc_count: number }[];
  getTopLevelPathsWithoutContext: (collectionName: string) => string[];

  // Virtual paths
  parseVirtualPath: typeof parseVirtualPath;
  buildVirtualPath: typeof buildVirtualPath;
  isVirtualPath: typeof isVirtualPath;
  resolveVirtualPath: (virtualPath: string) => string | null;
  toVirtualPath: (absolutePath: string) => string | null;

  // Search
  searchFTS: (query: string, limit?: number, collectionName?: string) => SearchResult[];
  searchVec: (query: string, model: string, limit?: number, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]) => Promise<SearchResult[]>;

  // Query expansion & reranking
  expandQuery: (query: string, model?: string, intent?: string) => Promise<ExpandedQuery[]>;
  rerank: (query: string, documents: { file: string; text: string }[], model?: string, intent?: string) => Promise<{ file: string; score: number }[]>;

  // Document retrieval
  findDocument: (filename: string, options?: { includeBody?: boolean }) => DocumentResult | DocumentNotFound;
  getDocumentBody: (doc: DocumentResult | { filepath: string }, fromLine?: number, maxLines?: number) => string | null;
  findDocuments: (pattern: string, options?: { includeBody?: boolean; maxBytes?: number }) => { docs: MultiGetResult[]; errors: string[] };

  // Fuzzy matching and docid lookup
  findSimilarFiles: (query: string, maxDistance?: number, limit?: number) => string[];
  matchFilesByGlob: (pattern: string) => { filepath: string; displayPath: string; bodyLength: number }[];
  findDocumentByDocid: (docid: string) => { filepath: string; hash: string } | null;

  // Document indexing operations
  insertContent: (hash: string, content: string, createdAt: string) => void;
  insertDocument: (collectionName: string, path: string, title: string, hash: string, createdAt: string, modifiedAt: string) => void;
  findActiveDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  findOrMigrateLegacyDocument: (collectionName: string, path: string) => { id: number; hash: string; title: string } | null;
  updateDocumentTitle: (documentId: number, title: string, modifiedAt: string) => void;
  updateDocument: (documentId: number, title: string, hash: string, modifiedAt: string) => void;
  deactivateDocument: (collectionName: string, path: string) => void;
  getActiveDocumentPaths: (collectionName: string) => string[];

  // Vector/embedding operations
  getHashesForEmbedding: () => { hash: string; body: string; path: string }[];
  clearAllEmbeddings: () => void;
  insertEmbedding: (hash: string, seq: number, pos: number, embedding: Float32Array, model: string, embeddedAt: string) => void;
};


// =============================================================================
// Store Factory
// =============================================================================
// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================

export type ReindexProgress = {
  file: string;
  current: number;
  total: number;
};


// =============================================================================
// Store Factory
// =============================================================================
// =============================================================================
// Reindex & Embed — pure-logic functions for SDK and CLI
// =============================================================================
export type ReindexResult = {
  indexed: number;
  updated: number;
  unchanged: number;
  removed: number;
  orphanedCleaned: number;
};


export type EmbedProgress = {
  chunksEmbedded: number;
  totalChunks: number;
  bytesProcessed: number;
  totalBytes: number;
  errors: number;
};


export type EmbedResult = {
  docsProcessed: number;
  chunksEmbedded: number;
  errors: number;
  durationMs: number;
};


export type EmbedOptions = {
  force?: boolean;
  model?: string;
  maxDocsPerBatch?: number;
  maxBatchBytes?: number;
  chunkStrategy?: ChunkStrategy;
  onProgress?: (info: EmbedProgress) => void;
};


export type PendingEmbeddingDoc = {
  hash: string;
  path: string;
  bytes: number;
};


export type EmbeddingDoc = PendingEmbeddingDoc & {
  body: string;
};


export type ChunkItem = {
  hash: string;
  title: string;
  text: string;
  seq: number;
  pos: number;
  tokens: number;
  bytes: number;
};


// =============================================================================
// Core Document Type
// =============================================================================

/**
 * Unified document result type with all metadata.
 * Body is optional - use getDocumentBody() to load it separately if needed.
 */
export type DocumentResult = {
  filepath: string;           // Full filesystem path
  displayPath: string;        // Short display path (e.g., "docs/readme.md")
  title: string;              // Document title (from first heading or filename)
  context: string | null;     // Folder context description if configured
  hash: string;               // Content hash for caching/change detection
  docid: string;              // Short docid (first 6 chars of hash) for quick reference
  collectionName: string;     // Parent collection name
  modifiedAt: string;         // Last modification timestamp
  bodyLength: number;         // Body length in bytes (useful before loading)
  body?: string;              // Document body (optional, load with getDocumentBody)
};


/**
 * Search result extends DocumentResult with score and source info
 */
export type SearchResult = DocumentResult & {
  score: number;              // Relevance score (0-1)
  source: "fts" | "vec";      // Search source (full-text or vector)
  chunkPos?: number;          // Character position of matching chunk (for vector search)
};


/**
 * Ranked result for RRF fusion (simplified, used internally)
 */
export type RankedResult = {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
};


export type RRFContributionTrace = {
  listIndex: number;
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
  rank: number;            // 1-indexed rank within list
  weight: number;
  backendScore: number;    // Backend-normalized score before fusion
  rrfContribution: number; // weight / (k + rank)
};


export type RRFScoreTrace = {
  contributions: RRFContributionTrace[];
  baseScore: number;       // Sum of reciprocal-rank contributions
  topRank: number;         // Best (lowest) rank seen across lists
  topRankBonus: number;    // +0.05 for rank 1, +0.02 for rank 2-3
  totalScore: number;      // baseScore + topRankBonus
};


export type HybridQueryExplain = {
  ftsScores: number[];
  vectorScores: number[];
  rrf: {
    rank: number;          // Rank after RRF fusion (1-indexed)
    positionScore: number; // 1 / rank used in position-aware blending
    weight: number;        // Position-aware RRF weight (0.75 / 0.60 / 0.40)
    baseScore: number;
    topRankBonus: number;
    totalScore: number;
    contributions: RRFContributionTrace[];
  };
  rerankScore: number;
  blendedScore: number;
};


/**
 * Error result when document is not found
 */
export type DocumentNotFound = {
  error: "not_found";
  query: string;
  similarFiles: string[];
};


/**
 * Result from multi-get operations
 */
export type MultiGetResult = {
  doc: DocumentResult;
  skipped: false;
} | {
  doc: Pick<DocumentResult, "filepath" | "displayPath">;
  skipped: true;
  skipReason: string;
};


export type CollectionInfo = {
  name: string;
  path: string | null;
  pattern: string | null;
  documents: number;
  lastUpdated: string;
};


export type IndexStatus = {
  totalDocuments: number;
  needsEmbedding: number;
  hasVectorIndex: boolean;
  collections: CollectionInfo[];
};


export type IndexHealthInfo = {
  needsEmbedding: number;
  totalDocs: number;
  daysStale: number | null;
};


// =============================================================================
// Document retrieval
// =============================================================================

export type DbDocRow = {
  virtual_path: string;
  display_path: string;
  title: string;
  hash: string;
  collection: string;
  path: string;
  modified_at: string;
  body_length: number;
  body?: string;
};


export type RankedListMeta = {
  source: "fts" | "vec";
  queryType: "original" | "lex" | "vec" | "hyde";
  query: string;
};
export interface SearchHooks {
  /** BM25 probe found strong signal — expansion will be skipped */
  onStrongSignal?: (topScore: number) => void;
  /** Query expansion starting */
  onExpandStart?: () => void;
  /** Query expansion complete. Empty array = strong signal skip. elapsedMs = time taken. */
  onExpand?: (original: string, expanded: ExpandedQuery[], elapsedMs: number) => void;
  /** Embedding starting (vec/hyde queries) */
  onEmbedStart?: (count: number) => void;
  /** Embedding complete */
  onEmbedDone?: (elapsedMs: number) => void;
  /** Reranking is about to start */
  onRerankStart?: (chunkCount: number) => void;
  /** Reranking finished */
  onRerankDone?: (elapsedMs: number) => void;
}

export interface HybridQueryOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  explain?: boolean;        // include backend/RRF/rerank score traces
  intent?: string;          // domain intent hint for disambiguation
  skipRerank?: boolean;     // skip LLM reranking, use only RRF scores
  chunkStrategy?: ChunkStrategy;
  hooks?: SearchHooks;
}

export interface HybridQueryResult {
  file: string;             // internal filepath (qmd://collection/path)
  displayPath: string;
  title: string;
  body: string;             // full document body (for snippet extraction)
  bestChunk: string;        // best chunk text
  bestChunkPos: number;     // char offset of best chunk in body
  score: number;            // blended score (full precision)
  context: string | null;   // user-set context
  docid: string;            // content hash prefix (6 chars)
  explain?: HybridQueryExplain;
}

export interface VectorSearchOptions {
  collection?: string;
  limit?: number;           // default 10
  minScore?: number;        // default 0.3
  intent?: string;          // domain intent hint for disambiguation
  hooks?: Pick<SearchHooks, 'onExpand'>;
}

export interface VectorSearchResult {
  file: string;
  displayPath: string;
  title: string;
  body: string;
  score: number;
  context: string | null;
  docid: string;
}

// =============================================================================
// Structured search — pre-expanded queries from LLM
// =============================================================================

/**
 * A single sub-search in a structured search request.
 * Matches the format used in QMD training data.
 */
export interface StructuredSearchOptions {
  collections?: string[];   // Filter to specific collections (OR match)
  limit?: number;           // default 10
  minScore?: number;        // default 0
  candidateLimit?: number;  // default RERANK_CANDIDATE_LIMIT
  explain?: boolean;        // include backend/RRF/rerank score traces
  /** Domain intent hint for disambiguation — steers reranking and chunk selection */
  intent?: string;
  /** Skip LLM reranking, use only RRF scores */
  skipRerank?: boolean;
  chunkStrategy?: ChunkStrategy;
  hooks?: SearchHooks;
}
