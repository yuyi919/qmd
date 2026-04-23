import { Project, SyntaxKind } from "ts-morph";

const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/store.ts");

const sections = {
  collectionCrud: ["getCollectionByName", "listCollections", "removeCollection", "renameCollection", "getAllCollections", "getCollectionsWithoutContext"],
  collectionContext: ["getContextForPath", "getContextForFile", "insertContext", "deleteContext", "deleteGlobalContexts", "listPathContexts", "getTopLevelPathsWithoutContext"],
  search: ["searchFTS", "searchVec", "hybridQuery", "vectorSearchQuery", "structuredSearch", "expandQuery", "rerank", "reciprocalRankFusion", "buildRrfTrace", "validateSemanticQuery", "validateLexQuery", "sanitizeFTS5Term", "findDocument", "getDocumentBody", "findDocuments", "addLineNumbers", "findDocumentByDocid"],
  indexing: ["reindexCollection", "scanFiles", "buildIndex", "updateDocument", "insertDocument", "findActiveDocument", "findOrMigrateLegacyDocument", "updateDocumentTitle", "deactivateDocument", "getActiveDocumentPaths", "extractTitle", "insertContent", "normalizeDocid", "isDocid", "getDocid", "handelize"],
  embedding: ["generateEmbeddings", "getHashesNeedingEmbedding", "getHashesForEmbedding", "clearAllEmbeddings", "insertEmbedding", "chunkDocument", "chunkDocumentAsync", "chunkDocumentByTokens"],
  health: ["vacuumDatabase", "cleanupOrphanedContent", "cleanupOrphanedVectors", "getIndexHealth", "getStatus", "deleteInactiveDocuments"],
  cache: ["getCacheKey", "getCachedResult", "setCachedResult", "clearCache", "deleteLLMCache"]
};

for (const [key, fns] of Object.entries(sections)) {
  let lines = 0;
  for (const name of fns) {
    const node = sourceFile.getFunction(name);
    if (node) {
      lines += node.getEndLineNumber() - node.getStartLineNumber() + 1;
    }
  }
  console.log(`${key}: ${lines} lines`);
}

