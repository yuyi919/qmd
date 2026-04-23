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


import { getContextForFile } from "../collection/context.js";
import { getDocid } from "../index/reindex.js";
import type { SearchResult } from "../types/index.js";


export function searchFTS(db: Database, query: string, limit: number = 20, collectionName?: string): SearchResult[] {
  const ftsQuery = buildFTS5Query(query);
  if (!ftsQuery) return [];

  // Use a CTE to force FTS5 to run first, then filter by collection.
  // Without the CTE, SQLite's query planner combines FTS5 MATCH with the
  // collection filter in a single WHERE clause, which can cause it to
  // abandon the FTS5 index and fall back to a full scan — turning an 8ms
  // query into a 17-second query on large collections.
  const params: (string | number)[] = [ftsQuery];

  // When filtering by collection, fetch extra candidates from the FTS index
  // since some will be filtered out. Without a collection filter we can
  // fetch exactly the requested limit.
  const ftsLimit = collectionName ? limit * 10 : limit;

  let sql = `
    WITH fts_matches AS (
      SELECT rowid, bm25(documents_fts, 1.5, 4.0, 1.0) as bm25_score
      FROM documents_fts
      WHERE documents_fts MATCH ?
      ORDER BY bm25_score ASC
      LIMIT ${ftsLimit}
    )
    SELECT
      'qmd://' || d.collection || '/' || d.path as filepath,
      d.collection || '/' || d.path as display_path,
      d.title,
      content.doc as body,
      d.hash,
      fm.bm25_score
    FROM fts_matches fm
    JOIN documents d ON d.id = fm.rowid
    JOIN content ON content.hash = d.hash
    WHERE d.active = 1
  `;

  if (collectionName) {
    sql += ` AND d.collection = ?`;
    params.push(String(collectionName));
  }

  // bm25 lower is better; sort ascending.
  sql += ` ORDER BY fm.bm25_score ASC LIMIT ?`;
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as { filepath: string; display_path: string; title: string; body: string; hash: string; bm25_score: number }[];
  return rows.map(row => {
    const collectionName = row.filepath.split('//')[1]?.split('/')[0] || "";
    // Convert bm25 (negative, lower is better) into a stable [0..1) score where higher is better.
    // FTS5 BM25 scores are negative (e.g., -10 is strong, -2 is weak).
    // |x| / (1 + |x|) maps: strong(-10)→0.91, medium(-2)→0.67, weak(-0.5)→0.33, none(0)→0.
    // Monotonic and query-independent — no per-query normalization needed.
    const score = Math.abs(row.bm25_score) / (1 + Math.abs(row.bm25_score));
    return {
      filepath: row.filepath,
      displayPath: row.display_path,
      title: row.title,
      hash: row.hash,
      docid: getDocid(row.hash),
      collectionName,
      modifiedAt: "",  // Not available in FTS query
      bodyLength: row.body.length,
      body: row.body,
      context: getContextForFile(db, row.filepath),
      score,
      source: "fts" as const,
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

export function sanitizeFTS5Term(term: string): string {
  return term.replace(/[^\p{L}\p{N}'_]/gu, '').toLowerCase();
}


export function validateLexQuery(query: string): string | null {
  if (/[\r\n]/.test(query)) {
    return 'Lex queries must be a single line. Remove newline characters or split into separate lex: lines.';
  }
  const quoteCount = (query.match(/"/g) ?? []).length;
  if (quoteCount % 2 === 1) {
    return 'Lex query has an unmatched double quote ("). Add the closing quote or remove it.';
  }
  return null;
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
 * Check if a token is a hyphenated compound word (e.g., multi-agent, DEC-0054, gpt-4).
 * Returns true if the token contains internal hyphens between word/digit characters.
 */
export function isHyphenatedToken(token: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N}'-]*-[\p{L}\p{N}][\p{L}\p{N}'-]*$/u.test(token);
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
 * Sanitize a hyphenated term into an FTS5 phrase by splitting on hyphens
 * and sanitizing each part. Returns the parts joined by spaces for use
 * inside FTS5 quotes: "multi agent" matches "multi-agent" in porter tokenizer.
 */
export function sanitizeHyphenatedTerm(term: string): string {
  return term.split('-').map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
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
 * Parse lex query syntax into FTS5 query.
 *
 * Supports:
 * - Quoted phrases: "exact phrase" → "exact phrase" (exact match)
 * - Negation: -term or -"phrase" → uses FTS5 NOT operator
 * - Hyphenated tokens: multi-agent, DEC-0054, gpt-4 → treated as phrases
 * - Plain terms: term → "term"* (prefix match)
 *
 * FTS5 NOT is a binary operator: `term1 NOT term2` means "match term1 but not term2".
 * So `-term` only works when there are also positive terms.
 *
 * Hyphen disambiguation: `-sports` at a word boundary is negation, but `multi-agent`
 * (where `-` is between word characters) is treated as a hyphenated phrase.
 * When a leading `-` is followed by what looks like a hyphenated compound word
 * (e.g., `-multi-agent`), the entire token is treated as a negated phrase.
 *
 * Examples:
 *   performance -sports     → "performance"* NOT "sports"*
 *   "machine learning"      → "machine learning"
 *   multi-agent memory      → "multi agent" AND "memory"*
 *   DEC-0054               → "dec 0054"
 *   -multi-agent            → NOT "multi agent"
 */
export function buildFTS5Query(query: string): string | null {
  const positive: string[] = [];
  const negative: string[] = [];

  let i = 0;
  const s = query.trim();

  while (i < s.length) {
    // Skip whitespace
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;

    // Check for negation prefix
    const negated = s[i] === '-';
    if (negated) i++;

    // Check for quoted phrase
    if (s[i] === '"') {
      const start = i + 1;
      i++;
      while (i < s.length && s[i] !== '"') i++;
      const phrase = s.slice(start, i).trim();
      i++; // skip closing quote
      if (phrase.length > 0) {
        const sanitized = phrase.split(/\s+/).map(t => sanitizeFTS5Term(t)).filter(t => t).join(' ');
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;  // Exact phrase, no prefix match
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      }
    } else {
      // Plain term (until whitespace or quote)
      const start = i;
      while (i < s.length && !/[\s"]/.test(s[i]!)) i++;
      const term = s.slice(start, i);

      // Handle hyphenated tokens: multi-agent, DEC-0054, gpt-4
      // These get split into phrase queries so FTS5 porter tokenizer matches them.
      if (isHyphenatedToken(term)) {
        const sanitized = sanitizeHyphenatedTerm(term);
        if (sanitized) {
          const ftsPhrase = `"${sanitized}"`;  // Phrase match (no prefix)
          if (negated) {
            negative.push(ftsPhrase);
          } else {
            positive.push(ftsPhrase);
          }
        }
      } else {
        const sanitized = sanitizeFTS5Term(term);
        if (sanitized) {
          const ftsTerm = `"${sanitized}"*`;  // Prefix match
          if (negated) {
            negative.push(ftsTerm);
          } else {
            positive.push(ftsTerm);
          }
        }
      }
    }
  }

  if (positive.length === 0 && negative.length === 0) return null;

  // If only negative terms, we can't search (FTS5 NOT is binary)
  if (positive.length === 0) return null;

  // Join positive terms with AND
  let result = positive.join(' AND ');

  // Add NOT clause for negative terms
  for (const neg of negative) {
    result = `${result} NOT ${neg}`;
  }

  return result;
}
