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






// Note: node:path resolve is not imported — we export our own cross-platform resolve()




// =============================================================================
// Configuration
// =============================================================================

export const HOME = process.env.HOME || process.env.USERPROFILE || "/tmp";


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_EMBED_MODEL = "embeddinggemma";


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_RERANK_MODEL = "ExpedientFalcon/qwen3-reranker:0.6b-q8_0";


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_QUERY_MODEL = "Qwen/Qwen3-1.7B";


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_GLOB = "**/*.md";


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_MULTI_GET_MAX_BYTES = 10 * 1024;


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_EMBED_MAX_DOCS_PER_BATCH = 64;


// =============================================================================
// Configuration
// =============================================================================
export const DEFAULT_EMBED_MAX_BATCH_BYTES = 64 * 1024 * 1024;


// Hybrid query: strong BM25 signal detection thresholds
// Skip expensive LLM expansion when top result is strong AND clearly separated from runner-up
export const STRONG_SIGNAL_MIN_SCORE = 0.85;


// Hybrid query: strong BM25 signal detection thresholds
// Skip expensive LLM expansion when top result is strong AND clearly separated from runner-up
export const STRONG_SIGNAL_MIN_GAP = 0.15;


// Hybrid query: strong BM25 signal detection thresholds
// Skip expensive LLM expansion when top result is strong AND clearly separated from runner-up
// Max candidates to pass to reranker — balances quality vs latency.
// 40 keeps rank 31-40 visible to the reranker (matters for recall on broad queries).
export const RERANK_CANDIDATE_LIMIT = 40;


// Flag to indicate production mode (set by qmd.ts at startup)
export const titleExtractors: Record<string, (content: string) => string | null> = {
  '.md': (content) => {
    const match = content.match(/^##?\s+(.+)$/m);
    if (match) {
      const title = (match[1] ?? "").trim();
      if (title === "📝 Notes" || title === "Notes") {
        const nextMatch = content.match(/^##\s+(.+)$/m);
        if (nextMatch?.[1]) return nextMatch[1].trim();
      }
      return title;
    }
    return null;
  },
  '.org': (content) => {
    const titleProp = content.match(/^#\+TITLE:\s*(.+)$/im);
    if (titleProp?.[1]) return titleProp[1].trim();
    const heading = content.match(/^\*+\s+(.+)$/m);
    if (heading?.[1]) return heading[1].trim();
    return null;
  },
};
