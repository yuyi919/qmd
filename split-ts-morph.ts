import { Project } from "ts-morph";
import * as fs from "fs";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });
const sourceFile = project.getSourceFileOrThrow("src/store.ts");

const sections: Record<string, string[]> = {
  "src/store/types/index.ts": [
    "ExpandedQuery", "StoreCollectionRow", "Store", "ReindexProgress", "ReindexResult",
    "EmbedProgress", "EmbedResult", "EmbedOptions", "PendingEmbeddingDoc", "EmbeddingDoc",
    "ChunkItem", "DocumentResult", "SearchResult", "RankedResult", "RRFContributionTrace",
    "RRFScoreTrace", "HybridQueryExplain", "DocumentNotFound", "MultiGetResult",
    "CollectionInfo", "IndexStatus", "IndexHealthInfo", "DbDocRow", "RankedListMeta"
  ],
  "src/store/core/db.ts": [
    "createSqliteVecUnavailableError", "_sqliteVecUnavailableReason", "getErrorMessage",
    "verifySqliteVecLoaded", "_sqliteVecAvailable", "initializeDatabase",
    "isSqliteVecAvailable", "ensureVecTableInternal", "getDefaultDbPath", "getPwd", "getRealPath", "enableProductionMode", "_resetProductionModeForTesting", "_productionMode"
  ],
  "src/store/core/store.ts": [
    "createStore"
  ],
  "src/store/collection/crud.ts": [
    "rowToNamedCollection", "getStoreCollections", "getStoreCollection",
    "upsertStoreCollection", "deleteStoreCollection", "renameStoreCollection",
    "getCollectionByName", "listCollections", "removeCollection", "renameCollection", "getAllCollections", "getCollectionsWithoutContext"
  ],
  "src/store/collection/context.ts": [
    "getStoreGlobalContext", "getStoreContexts", "updateStoreContext", "removeStoreContext", "setStoreGlobalContext", "syncConfigToDb",
    "getContextForPath", "getContextForFile", "insertContext", "deleteContext", "deleteGlobalContexts", "listPathContexts", "getTopLevelPathsWithoutContext"
  ],
  "src/store/search/hybrid.ts": [
    "hybridQuery", "buildRrfTrace", "reciprocalRankFusion", "rerank", "expandQuery", "getLlm", "RERANK_CANDIDATE_LIMIT", "STRONG_SIGNAL_MIN_SCORE", "STRONG_SIGNAL_MIN_GAP"
  ],
  "src/store/search/structured.ts": [
    "structuredSearch"
  ],
  "src/store/search/fts.ts": [
    "searchFTS", "sanitizeFTS5Term", "validateLexQuery", "isHyphenatedToken", "sanitizeHyphenatedTerm", "buildFTS5Query"
  ],
  "src/store/search/vec.ts": [
    "searchVec", "validateSemanticQuery", "vectorSearchQuery", "getEmbedding"
  ],
  "src/store/search/document.ts": [
    "findDocument", "getDocumentBody", "findDocuments", "findDocumentByDocid", "addLineNumbers"
  ],
  "src/store/index/reindex.ts": [
    "reindexCollection", "scanFiles", "buildIndex", "updateDocument", "insertDocument", "findActiveDocument", "findOrMigrateLegacyDocument", "updateDocumentTitle", "deactivateDocument", "getActiveDocumentPaths", "extractTitle", "normalizeDocid", "isDocid", "getDocid", "handelize", "matchFilesByGlob", "findSimilarFiles", "titleExtractors", "levenshtein", "insertContent"
  ],
  "src/store/index/embed.ts": [
    "generateEmbeddings", "chunkDocument", "chunkDocumentAsync", "chunkDocumentByTokens", "getHashesNeedingEmbedding", "getHashesForEmbedding", "insertEmbedding", "clearAllEmbeddings", "validatePositiveIntegerOption", "resolveEmbedOptions", "getPendingEmbeddingDocs", "buildEmbeddingBatches", "getEmbeddingDocsForBatch", "DEFAULT_EMBED_MODEL", "DEFAULT_EMBED_MAX_DOCS_PER_BATCH", "DEFAULT_EMBED_MAX_BATCH_BYTES", "DEFAULT_MULTI_GET_MAX_BYTES", "DEFAULT_QUERY_MODEL", "DEFAULT_GLOB", "DEFAULT_RERANK_MODEL"
  ],
  "src/store/index/health.ts": [
    "getIndexHealth", "getStatus", "cleanupOrphanedContent", "cleanupOrphanedVectors", "vacuumDatabase", "deleteInactiveDocuments"
  ],
  "src/store/cache/index.ts": [
    "getCacheKey", "getCachedResult", "setCachedResult", "clearCache", "deleteLLMCache"
  ]
};

// Create the new files
for (const [filePath, fns] of Object.entries(sections)) {
  const newFile = project.createSourceFile(filePath, "", { overwrite: true });
  for (const name of fns) {
    const node = sourceFile.getTypeAlias(name) ||
                 sourceFile.getFunction(name) ||
                 sourceFile.getVariableStatement(name) ||
                 sourceFile.getVariableDeclaration(name)?.getVariableStatement() ||
                 sourceFile.getInterface(name);
    if (node) {
      // Add node to new file
      newFile.addStatements(node.getFullText());
      // Keep it exported if it was
      // node.remove(); // We will do removal in a second pass or just overwrite
    } else {
      console.log(`Warning: Node not found for ${name} in ${filePath}`);
    }
  }
}

console.log("Done");
