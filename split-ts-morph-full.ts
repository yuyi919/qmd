import { Project, SyntaxKind, SourceFile } from "ts-morph";
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
  "src/store/core/constants.ts": [
    "HOME", "DEFAULT_EMBED_MODEL", "DEFAULT_RERANK_MODEL", "DEFAULT_QUERY_MODEL", "DEFAULT_GLOB",
    "DEFAULT_MULTI_GET_MAX_BYTES", "DEFAULT_EMBED_MAX_DOCS_PER_BATCH", "DEFAULT_EMBED_MAX_BATCH_BYTES",
    "STRONG_SIGNAL_MIN_SCORE", "STRONG_SIGNAL_MIN_GAP", "RERANK_CANDIDATE_LIMIT", "_productionMode",
    "titleExtractors"
  ],
  "src/store/core/db.ts": [
    "createSqliteVecUnavailableError", "_sqliteVecUnavailableReason", "getErrorMessage",
    "verifySqliteVecLoaded", "_sqliteVecAvailable", "initializeDatabase",
    "isSqliteVecAvailable", "ensureVecTableInternal", "getDefaultDbPath", "getPwd", "getRealPath", "enableProductionMode", "_resetProductionModeForTesting"
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
    "hybridQuery", "buildRrfTrace", "reciprocalRankFusion", "rerank", "expandQuery", "getLlm"
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
    "reindexCollection", "scanFiles", "buildIndex", "updateDocument", "insertDocument", "findActiveDocument", "findOrMigrateLegacyDocument", "updateDocumentTitle", "deactivateDocument", "getActiveDocumentPaths", "extractTitle", "normalizeDocid", "isDocid", "getDocid", "handelize", "matchFilesByGlob", "findSimilarFiles", "levenshtein", "insertContent"
  ],
  "src/store/index/embed.ts": [
    "generateEmbeddings", "chunkDocument", "chunkDocumentAsync", "chunkDocumentByTokens", "getHashesNeedingEmbedding", "getHashesForEmbedding", "insertEmbedding", "clearAllEmbeddings", "validatePositiveIntegerOption", "resolveEmbedOptions", "getPendingEmbeddingDocs", "buildEmbeddingBatches", "getEmbeddingDocsForBatch"
  ],
  "src/store/index/health.ts": [
    "getIndexHealth", "getStatus", "cleanupOrphanedContent", "cleanupOrphanedVectors", "vacuumDatabase", "deleteInactiveDocuments"
  ],
  "src/store/cache/index.ts": [
    "getCacheKey", "getCachedResult", "setCachedResult", "clearCache", "deleteLLMCache"
  ]
};

// Also we need createStore, which depends on EVERYTHING.
sections["src/store/core/store.ts"] = ["createStore"];

// Keep original imports from store.ts to copy to new files.
const originalImports = sourceFile.getImportDeclarations().map(i => i.getFullText()).join("\n");

const newFiles: SourceFile[] = [];

for (const [filePath, fns] of Object.entries(sections)) {
  const newFile = project.createSourceFile(filePath, "", { overwrite: true });
  newFiles.push(newFile);
  
  // Add original imports
  newFile.addStatements(originalImports);
  
  for (const name of fns) {
    const node = sourceFile.getTypeAlias(name) ||
                 sourceFile.getFunction(name) ||
                 sourceFile.getVariableStatement(name) ||
                 sourceFile.getVariableDeclaration(name)?.getVariableStatement() ||
                 sourceFile.getInterface(name);
    if (node) {
      // make sure it is exported so we can use it across files
      const text = node.getFullText();
      const isExported = text.includes("export ");
      const finalStr = isExported ? text : text.replace(/^(const|let|function|type|interface)/m, "export $1");
      
      newFile.addStatements(finalStr);
      node.remove();
    } else {
      console.log(`Warning: Node not found for ${name} in ${filePath}`);
    }
  }
}

// Now `src/store.ts` contains only what's left over. Let's see what is left over.
// We should re-export everything from the new files in `src/store.ts`.
let reexports = "";
for (const filePath of Object.keys(sections)) {
  const relPath = "./" + filePath.replace("src/", "").replace(".ts", ".js");
  reexports += `export * from "${relPath}";\n`;
}

sourceFile.addStatements(reexports);

project.saveSync();
console.log("Done splitting.");
