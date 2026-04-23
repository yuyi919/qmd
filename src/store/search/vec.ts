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
    formatDocForEmbedding,
    formatQueryForEmbedding,
    getDefaultLlamaCpp,
    type ILLMSession
} from "../../llm.js";

import type { VectorSearchOptions, VectorSearchResult } from "../index.js";
import { getContextForFile } from "../collection/context.js";
import { DEFAULT_EMBED_MODEL } from "../core/constants.js";
import { getDocid } from "../index/reindex.js";
import type { SearchResult, Store } from "../types/index.js";


// =============================================================================
// Vector Search
// =============================================================================

export async function searchVec(db: Database, query: string, model: string, limit: number = 20, collectionName?: string, session?: ILLMSession, precomputedEmbedding?: number[]): Promise<SearchResult[]> {
  const tableExists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`).get();
  if (!tableExists) return [];

  const embedding = precomputedEmbedding ?? await getEmbedding(query, model, true, session);
  if (!embedding) return [];

  // IMPORTANT: We use a two-step query approach here because sqlite-vec virtual tables
  // hang indefinitely when combined with JOINs in the same query. Do NOT try to
  // "optimize" this by combining into a single query with JOINs - it will break.
  // See: https://github.com/tobi/qmd/pull/23

  // Step 1: Get vector matches from sqlite-vec (no JOINs allowed)
  const vecResults = db.prepare(`
    SELECT hash_seq, distance
    FROM vectors_vec
    WHERE embedding MATCH ? AND k = ?
  `).all(new Float32Array(embedding), limit * 3) as { hash_seq: string; distance: number }[];

  if (vecResults.length === 0) return [];

  // Step 2: Get chunk info and document data
  const hashSeqs = vecResults.map(r => r.hash_seq);
  const distanceMap = new Map(vecResults.map(r => [r.hash_seq, r.distance]));

  // Build query for document lookup
  const placeholders = hashSeqs.map(() => '?').join(',');
  let docSql = `
    SELECT
      cv.hash || '_' || cv.seq as hash_seq,
      cv.hash,
      cv.pos,
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body
    FROM content_vectors cv
    JOIN documents d ON d.hash = cv.hash AND d.active = 1
    JOIN content ON content.hash = d.hash
    WHERE cv.hash || '_' || cv.seq IN (${placeholders})
  `;
  const params: string[] = [...hashSeqs];

  if (collectionName) {
    docSql += ` AND d.collection = ?`;
    params.push(collectionName);
  }

  const docRows = db.prepare(docSql).all(...params) as {
    hash_seq: string; hash: string; pos: number; filepath: string;
    display_path: string; title: string; body: string;
  }[];

  // Combine with distances and dedupe by filepath
  const seen = new Map<string, { row: typeof docRows[0]; bestDist: number }>();
  for (const row of docRows) {
    const distance = distanceMap.get(row.hash_seq) ?? 1;
    const existing = seen.get(row.filepath);
    if (!existing || distance < existing.bestDist) {
      seen.set(row.filepath, { row, bestDist: distance });
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => a.bestDist - b.bestDist)
    .slice(0, limit)
    .map(({ row, bestDist }) => {
      const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
      return {
        filepath: row.filepath,
        displayPath: row.display_path,
        title: row.title,
        hash: row.hash,
        docid: getDocid(row.hash),
        collectionName,
        modifiedAt: "",  // Not available in vec query
        bodyLength: row.body.length,
        body: row.body,
        context: getContextForFile(db, row.filepath),
        score: 1 - bestDist,  // Cosine similarity = 1 - cosine distance
        source: "vec" as const,
        chunkPos: row.pos,
      };
    });
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================
// =============================================================================
// FTS Search
// =============================================================================

/**
 * Validate that a vec/hyde query doesn't use lex-only syntax.
 * Returns error message if invalid, null if valid.
 */
export function validateSemanticQuery(query: string): string | null {
  // Check for negation syntax
  if (/-\w/.test(query) || /-"/.test(query)) {
    return 'Negation (-term) is not supported in vec/hyde queries. Use lex for exclusions.';
  }
  return null;
}


/**
 * Vector-only semantic search with query expansion.
 *
 * Pipeline:
 * 1. expandQuery() → typed variants, filter to vec/hyde only (lex irrelevant here)
 * 2. searchVec() for original + vec/hyde variants (sequential — node-llama-cpp embed limitation)
 * 3. Dedup by filepath (keep max score)
 * 4. Sort by score descending, filter by minScore, slice to limit
 */
export async function vectorSearchQuery(
  store: Store,
  query: string,
  options?: VectorSearchOptions
): Promise<VectorSearchResult[]> {
  const limit = options?.limit ?? 10;
  const minScore = options?.minScore ?? 0.3;
  const collection = options?.collection;
  const intent = options?.intent;

  const hasVectors = !!store.db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='vectors_vec'`
  ).get();
  if (!hasVectors) return [];

  // Expand query — filter to vec/hyde only (lex queries target FTS, not vector)
  const expandStart = Date.now();
  const allExpanded = await store.expandQuery(query, undefined, intent);
  const vecExpanded = allExpanded.filter(q => q.type !== 'lex');
  options?.hooks?.onExpand?.(query, vecExpanded, Date.now() - expandStart);

  // Run original + vec/hyde expanded through vector, sequentially — concurrent embed() hangs
  const queryTexts = [query, ...vecExpanded.map(q => q.query)];
  const allResults = new Map<string, VectorSearchResult>();
  for (const q of queryTexts) {
    const vecResults = await store.searchVec(q, DEFAULT_EMBED_MODEL, limit, collection);
    for (const r of vecResults) {
      const existing = allResults.get(r.filepath);
      if (!existing || r.score > existing.score) {
        allResults.set(r.filepath, {
          file: r.filepath,
          displayPath: r.displayPath,
          title: r.title,
          body: r.body || "",
          score: r.score,
          context: store.getContextForFile(r.filepath),
          docid: r.docid,
        });
      }
    }
  }

  return Array.from(allResults.values())
    .sort((a, b) => b.score - a.score)
    .filter(r => r.score >= minScore)
    .slice(0, limit);
}


// =============================================================================
// Context
// =============================================================================
// =============================================================================
// Context Management Operations
// =============================================================================
// =============================================================================
// FTS Search
// =============================================================================
// =============================================================================
// Vector Search
// =============================================================================
// =============================================================================
// Embeddings
// =============================================================================

async function getEmbedding(text: string, model: string, isQuery: boolean, session?: ILLMSession, llmOverride?: LlamaCpp): Promise<number[] | null> {
  // Format text using the appropriate prompt template
  const formattedText = isQuery ? formatQueryForEmbedding(text, model) : formatDocForEmbedding(text, undefined, model);
  const result = session
    ? await session.embed(formattedText, { model, isQuery })
    : await (llmOverride ?? getDefaultLlamaCpp()).embed(formattedText, { model, isQuery });
  return result?.embedding || null;
}
