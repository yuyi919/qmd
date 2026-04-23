import { Project, SyntaxKind, Node } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

const project = new Project();
project.addSourceFileAtPath("src/store.ts");

const sourceFile = project.getSourceFileOrThrow("src/store.ts");

// Types to extract
const typesToExtract = [
  "ExpandedQuery", "StoreCollectionRow", "Store", "ReindexProgress", "ReindexResult",
  "EmbedProgress", "EmbedResult", "EmbedOptions", "PendingEmbeddingDoc", "EmbeddingDoc",
  "ChunkItem", "DocumentResult", "SearchResult", "RankedResult", "RRFContributionTrace",
  "RRFScoreTrace", "HybridQueryExplain", "DocumentNotFound", "MultiGetResult",
  "CollectionInfo", "IndexStatus", "IndexHealthInfo", "DbDocRow", "RankedListMeta"
];

// Core DB init logic
const coreDbFns = [
  "createSqliteVecUnavailableError", "_sqliteVecUnavailableReason", "getErrorMessage",
  "verifySqliteVecLoaded", "_sqliteVecAvailable", "initializeDatabase",
  "isSqliteVecAvailable", "ensureVecTableInternal", "getDefaultDbPath", "getPwd", "getRealPath", "enableProductionMode", "_resetProductionModeForTesting"
];

// Core Store logic
const coreStoreFns = [
  "createStore"
];

// Collection CRUD
const collectionCrudFns = [
  "StoreCollectionRow", "rowToNamedCollection", "getStoreCollections", "getStoreCollection",
  "upsertStoreCollection", "deleteStoreCollection", "renameStoreCollection"
];

// Collection Context
const collectionContextFns = [
  "getStoreGlobalContext", "getStoreContexts", "updateStoreContext", "removeStoreContext", "setStoreGlobalContext", "syncConfigToDb"
];

// Let's just create files and dump the text for now, or use ts-morph properly.
console.log("AST ready");
