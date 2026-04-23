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
    formatDocForEmbedding,
    getDefaultLlamaCpp,
    withLLMSessionForLlm
} from "../../llm.js";
import { CHUNK_OVERLAP_CHARS, CHUNK_OVERLAP_TOKENS, CHUNK_SIZE_CHARS, CHUNK_SIZE_TOKENS, CHUNK_WINDOW_CHARS, CHUNK_WINDOW_TOKENS, chunkDocumentWithBreakPoints, type ChunkStrategy, findCodeFences, mergeBreakPoints, scanBreakPoints } from "../index.js";
import { DEFAULT_EMBED_MAX_BATCH_BYTES, DEFAULT_EMBED_MAX_DOCS_PER_BATCH, DEFAULT_EMBED_MODEL } from "../core/constants.js";
import { getLlm } from "../search/hybrid.js";
import type { ChunkItem, EmbeddingDoc, EmbedResult, PendingEmbeddingDoc, Store } from "../types/index.js";
import { extractTitle } from "./reindex.js";
import type { EmbedOptions } from "../types/index.js";

/**
 * Generate vector embeddings for documents that need them.
 * Pure function — no console output, no db lifecycle management.
 * Uses the store's LlamaCpp instance if set, otherwise the global singleton.
 */
export async function generateEmbeddings(
  store: Store,
  options?: EmbedOptions
): Promise<EmbedResult> {
  const db = store.db;
  const model = options?.model ?? DEFAULT_EMBED_MODEL;
  const now = new Date().toISOString();
  const { maxDocsPerBatch, maxBatchBytes } = resolveEmbedOptions(options);
  const encoder = new TextEncoder();

  if (options?.force) {
    clearAllEmbeddings(db);
  }

  const docsToEmbed = getPendingEmbeddingDocs(db);

  if (docsToEmbed.length === 0) {
    return { docsProcessed: 0, chunksEmbedded: 0, errors: 0, durationMs: 0 };
  }
  const totalBytes = docsToEmbed.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);
  const totalDocs = docsToEmbed.length;
  const startTime = Date.now();

  // Use store's LlamaCpp or global singleton, wrapped in a session
  const llm = getLlm(store);
  const embedModelUri = llm.embedModelName;

  // Create a session manager for this llm instance
  const result = await withLLMSessionForLlm(llm, async (session) => {
    let chunksEmbedded = 0;
    let errors = 0;
    let bytesProcessed = 0;
    let totalChunks = 0;
    let vectorTableInitialized = false;
    const BATCH_SIZE = 32;
    const batches = buildEmbeddingBatches(docsToEmbed, maxDocsPerBatch, maxBatchBytes);

    for (const batchMeta of batches) {
      // Abort early if session has been invalidated
      if (!session.isValid) {
        console.warn(`⚠ Session expired — skipping remaining document batches`);
        break;
      }

      const batchDocs = getEmbeddingDocsForBatch(db, batchMeta);
      const batchChunks: ChunkItem[] = [];
      const batchBytes = batchMeta.reduce((sum, doc) => sum + Math.max(0, doc.bytes), 0);

      for (const doc of batchDocs) {
        if (!doc.body.trim()) continue;

        const title = extractTitle(doc.body, doc.path);
        const chunks = await chunkDocumentByTokens(
          doc.body,
          undefined, undefined, undefined,
          doc.path,
          options?.chunkStrategy,
          session.signal,
        );

        for (let seq = 0; seq < chunks.length; seq++) {
          batchChunks.push({
            hash: doc.hash,
            title,
            text: chunks[seq]!.text,
            seq,
            pos: chunks[seq]!.pos,
            tokens: chunks[seq]!.tokens,
            bytes: encoder.encode(chunks[seq]!.text).length,
          });
        }
      }

      totalChunks += batchChunks.length;

      if (batchChunks.length === 0) {
        bytesProcessed += batchBytes;
        options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
        continue;
      }

      if (!vectorTableInitialized) {
        const firstChunk = batchChunks[0]!;
        const firstText = formatDocForEmbedding(firstChunk.text, firstChunk.title, embedModelUri);
        const firstResult = await session.embed(firstText, { model });
        if (!firstResult) {
          throw new Error("Failed to get embedding dimensions from first chunk");
        }
        store.ensureVecTable(firstResult.embedding.length);
        vectorTableInitialized = true;
      }

      const totalBatchChunkBytes = batchChunks.reduce((sum, chunk) => sum + chunk.bytes, 0);
      let batchChunkBytesProcessed = 0;

      for (let batchStart = 0; batchStart < batchChunks.length; batchStart += BATCH_SIZE) {
        // Abort early if session has been invalidated (e.g. max duration exceeded)
        if (!session.isValid) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`⚠ Session expired — skipping ${remaining} remaining chunks`);
          break;
        }

        // Abort early if error rate is too high (>80% of processed chunks failed)
        const processed = chunksEmbedded + errors;
        if (processed >= BATCH_SIZE && errors > processed * 0.8) {
          const remaining = batchChunks.length - batchStart;
          errors += remaining;
          console.warn(`⚠ Error rate too high (${errors}/${processed}) — aborting embedding`);
          break;
        }

        const batchEnd = Math.min(batchStart + BATCH_SIZE, batchChunks.length);
        const chunkBatch = batchChunks.slice(batchStart, batchEnd);
        const texts = chunkBatch.map(chunk => formatDocForEmbedding(chunk.text, chunk.title, embedModelUri));

        try {
          const embeddings = await session.embedBatch(texts, { model });
          for (let i = 0; i < chunkBatch.length; i++) {
            const chunk = chunkBatch[i]!;
            const embedding = embeddings[i];
            if (embedding) {
              insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(embedding.embedding), model, now);
              chunksEmbedded++;
            } else {
              errors++;
            }
            batchChunkBytesProcessed += chunk.bytes;
          }
        } catch {
          // Batch failed — try individual embeddings as fallback
          // But skip if session is already invalid (avoids N doomed retries)
          if (!session.isValid) {
            errors += chunkBatch.length;
            batchChunkBytesProcessed += chunkBatch.reduce((sum, c) => sum + c.bytes, 0);
          } else {
            for (const chunk of chunkBatch) {
              try {
                const text = formatDocForEmbedding(chunk.text, chunk.title, embedModelUri);
                const result = await session.embed(text, { model });
                if (result) {
                  insertEmbedding(db, chunk.hash, chunk.seq, chunk.pos, new Float32Array(result.embedding), model, now);
                  chunksEmbedded++;
                } else {
                  errors++;
                }
              } catch {
                errors++;
              }
              batchChunkBytesProcessed += chunk.bytes;
            }
          }
        }

        const proportionalBytes = totalBatchChunkBytes === 0
          ? batchBytes
          : Math.min(batchBytes, Math.round((batchChunkBytesProcessed / totalBatchChunkBytes) * batchBytes));
        options?.onProgress?.({
          chunksEmbedded,
          totalChunks,
          bytesProcessed: bytesProcessed + proportionalBytes,
          totalBytes,
          errors,
        });
      }

      bytesProcessed += batchBytes;
      options?.onProgress?.({ chunksEmbedded, totalChunks, bytesProcessed, totalBytes, errors });
    }

    return { chunksEmbedded, errors };
  }, { maxDuration: 30 * 60 * 1000, name: 'generateEmbeddings' });

  return {
    docsProcessed: totalDocs,
    chunksEmbedded: result.chunksEmbedded,
    errors: result.errors,
    durationMs: Date.now() - startTime,
  };
}


/**
 * Chunk a document using regex-only break point detection.
 * This is the sync, backward-compatible API used by tests and legacy callers.
 */
export function chunkDocument(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS
): { text: string; pos: number }[] {
  const breakPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);
  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}


/**
 * Async AST-aware chunking. Detects language from filepath, computes AST
 * break points for supported code files, merges with regex break points,
 * and delegates to the shared chunk algorithm.
 *
 * Falls back to regex-only when strategy is "regex", filepath is absent,
 * or language is unsupported.
 */
export async function chunkDocumentAsync(
  content: string,
  maxChars: number = CHUNK_SIZE_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  windowChars: number = CHUNK_WINDOW_CHARS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
): Promise<{ text: string; pos: number }[]> {
  const regexPoints = scanBreakPoints(content);
  const codeFences = findCodeFences(content);

  let breakPoints = regexPoints;
  if (chunkStrategy === "auto" && filepath) {
    const { getASTBreakPoints } = await import("../../ast.js");
    const astPoints = await getASTBreakPoints(content, filepath);
    if (astPoints.length > 0) {
      breakPoints = mergeBreakPoints(regexPoints, astPoints);
    }
  }

  return chunkDocumentWithBreakPoints(content, breakPoints, codeFences, maxChars, overlapChars, windowChars);
}


/**
 * Chunk a document by actual token count using the LLM tokenizer.
 * More accurate than character-based chunking but requires async.
 *
 * When filepath and chunkStrategy are provided, uses AST-aware break points
 * for supported code files.
 */
export async function chunkDocumentByTokens(
  content: string,
  maxTokens: number = CHUNK_SIZE_TOKENS,
  overlapTokens: number = CHUNK_OVERLAP_TOKENS,
  windowTokens: number = CHUNK_WINDOW_TOKENS,
  filepath?: string,
  chunkStrategy: ChunkStrategy = "regex",
  signal?: AbortSignal
): Promise<{ text: string; pos: number; tokens: number }[]> {
  const llm = getDefaultLlamaCpp();

  // Use moderate chars/token estimate (prose ~4, code ~2, mixed ~3)
  // If chunks exceed limit, they'll be re-split with actual ratio
  const avgCharsPerToken = 3;
  const maxChars = maxTokens * avgCharsPerToken;
  const overlapChars = overlapTokens * avgCharsPerToken;
  const windowChars = windowTokens * avgCharsPerToken;

  // Chunk in character space with conservative estimate
  // Use AST-aware chunking for the first pass when filepath/strategy provided
  let charChunks = await chunkDocumentAsync(content, maxChars, overlapChars, windowChars, filepath, chunkStrategy);

  // Tokenize and split any chunks that still exceed limit
  const results: { text: string; pos: number; tokens: number }[] = [];
  const clampOverlapChars = (value: number, maxChars: number): number => {
    if (maxChars <= 1) return 0;
    return Math.max(0, Math.min(maxChars - 1, Math.floor(value)));
  };

  const pushChunkWithinTokenLimit = async (text: string, pos: number): Promise<void> => {
    if (signal?.aborted) return;

    const tokens = await llm.tokenize(text);
    if (tokens.length <= maxTokens || text.length <= 1) {
      results.push({ text, pos, tokens: tokens.length });
      return;
    }

    const actualCharsPerToken = text.length / tokens.length;
    let safeMaxChars = Math.floor(maxTokens * actualCharsPerToken * 0.95);
    if (!Number.isFinite(safeMaxChars) || safeMaxChars < 1) {
      safeMaxChars = Math.floor(text.length / 2);
    }
    safeMaxChars = Math.max(1, Math.min(text.length - 1, safeMaxChars));

    let nextOverlapChars = clampOverlapChars(
      overlapChars * actualCharsPerToken / 2,
      safeMaxChars,
    );
    let nextWindowChars = Math.max(0, Math.floor(windowChars * actualCharsPerToken / 2));
    let subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);

    // Pathological single-line blobs can produce no meaningful breakpoint progress.
    // Fall back to a simple half split so every recursion step strictly shrinks.
    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      safeMaxChars = Math.max(1, Math.floor(text.length / 2));
      nextOverlapChars = 0;
      nextWindowChars = 0;
      subChunks = chunkDocument(text, safeMaxChars, nextOverlapChars, nextWindowChars);
    }

    if (
      subChunks.length <= 1
      || subChunks[0]?.text.length === text.length
    ) {
      const fallbackTokens = tokens.slice(0, Math.max(1, maxTokens));
      const truncatedText = await llm.detokenize(fallbackTokens);
      results.push({
        text: truncatedText,
        pos,
        tokens: fallbackTokens.length,
      });
      return;
    }

    for (const subChunk of subChunks) {
      await pushChunkWithinTokenLimit(text.slice(subChunk.pos, subChunk.pos + subChunk.text.length), pos + subChunk.pos);
    }
  };

  for (const chunk of charChunks) {
    await pushChunkWithinTokenLimit(chunk.text, chunk.pos);
  }

  return results;
}


// =============================================================================
// Index health
// =============================================================================

export function getHashesNeedingEmbedding(db: Database): number {
  const result = db.prepare(`
    SELECT COUNT(DISTINCT d.hash) as count
    FROM documents d
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
  `).get() as { count: number };
  return result.count;
}

// =============================================================================
// Fuzzy matching
// =============================================================================
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

/**
 * Get all unique content hashes that need embeddings (from active documents).
 * Returns hash, document body, and a sample path for display purposes.
 */
export function getHashesForEmbedding(db: Database): { hash: string; body: string; path: string }[] {
  return db.prepare(`
    SELECT d.hash, c.doc as body, MIN(d.path) as path
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
  `).all() as { hash: string; body: string; path: string }[];
}


/**
 * Insert a single embedding into both content_vectors and vectors_vec tables.
 * The hash_seq key is formatted as "hash_seq" for the vectors_vec table.
 *
 * content_vectors is inserted first so that getHashesForEmbedding (which checks
 * only content_vectors) won't re-select the hash on a crash between the two inserts.
 *
 * vectors_vec uses DELETE + INSERT instead of INSERT OR REPLACE because sqlite-vec's
 * vec0 virtual tables silently ignore the OR REPLACE conflict clause.
 */
export function insertEmbedding(
  db: Database,
  hash: string,
  seq: number,
  pos: number,
  embedding: Float32Array,
  model: string,
  embeddedAt: string
): void {
  const hashSeq = `${hash}_${seq}`;

  // Insert content_vectors first — crash-safe ordering (see getHashesForEmbedding)
  const insertContentVectorStmt = db.prepare(`INSERT OR REPLACE INTO content_vectors (hash, seq, pos, model, embedded_at) VALUES (?, ?, ?, ?, ?)`);
  insertContentVectorStmt.run(hash, seq, pos, model, embeddedAt);

  // vec0 virtual tables don't support OR REPLACE — use DELETE + INSERT
  const deleteVecStmt = db.prepare(`DELETE FROM vectors_vec WHERE hash_seq = ?`);
  const insertVecStmt = db.prepare(`INSERT INTO vectors_vec (hash_seq, embedding) VALUES (?, ?)`);
  deleteVecStmt.run(hashSeq);
  insertVecStmt.run(hashSeq, embedding);
}

// =============================================================================
// Fuzzy matching
// =============================================================================
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

/**
 * Clear all embeddings from the database (force re-index).
 * Deletes all rows from content_vectors and drops the vectors_vec table.
 */
export function clearAllEmbeddings(db: Database): void {
  db.exec(`DELETE FROM content_vectors`);
  db.exec(`DROP TABLE IF EXISTS vectors_vec`);
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

export function validatePositiveIntegerOption(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
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

export function resolveEmbedOptions(options?: EmbedOptions): Required<Pick<EmbedOptions, "maxDocsPerBatch" | "maxBatchBytes">> {
  return {
    maxDocsPerBatch: validatePositiveIntegerOption("maxDocsPerBatch", options?.maxDocsPerBatch, DEFAULT_EMBED_MAX_DOCS_PER_BATCH),
    maxBatchBytes: validatePositiveIntegerOption("maxBatchBytes", options?.maxBatchBytes, DEFAULT_EMBED_MAX_BATCH_BYTES),
  };
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

export function getPendingEmbeddingDocs(db: Database): PendingEmbeddingDoc[] {
  return db.prepare(`
    SELECT d.hash, MIN(d.path) as path, length(CAST(c.doc AS BLOB)) as bytes
    FROM documents d
    JOIN content c ON d.hash = c.hash
    LEFT JOIN content_vectors v ON d.hash = v.hash AND v.seq = 0
    WHERE d.active = 1 AND v.hash IS NULL
    GROUP BY d.hash
    ORDER BY MIN(d.path)
  `).all() as PendingEmbeddingDoc[];
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

export function buildEmbeddingBatches(
  docs: PendingEmbeddingDoc[],
  maxDocsPerBatch: number,
  maxBatchBytes: number,
): PendingEmbeddingDoc[][] {
  const batches: PendingEmbeddingDoc[][] = [];
  let currentBatch: PendingEmbeddingDoc[] = [];
  let currentBytes = 0;

  for (const doc of docs) {
    const docBytes = Math.max(0, doc.bytes);
    const wouldExceedDocs = currentBatch.length >= maxDocsPerBatch;
    const wouldExceedBytes = currentBatch.length > 0 && (currentBytes + docBytes) > maxBatchBytes;

    if (wouldExceedDocs || wouldExceedBytes) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(doc);
    currentBytes += docBytes;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
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

export function getEmbeddingDocsForBatch(db: Database, batch: PendingEmbeddingDoc[]): EmbeddingDoc[] {
  if (batch.length === 0) return [];

  const placeholders = batch.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT hash, doc as body
    FROM content
    WHERE hash IN (${placeholders})
  `).all(...batch.map(doc => doc.hash)) as { hash: string; body: string }[];
  const bodyByHash = new Map(rows.map(row => [row.hash, row.body]));

  return batch.map((doc) => ({
    ...doc,
    body: bodyByHash.get(doc.hash) ?? "",
  }));
}
