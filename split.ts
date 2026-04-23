import { Project, SyntaxKind, TypeAliasDeclaration, FunctionDeclaration, VariableStatement } from "ts-morph";
import * as fs from "fs";

const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/store.ts");

const typesToExtract = [
  "ExpandedQuery", "StoreCollectionRow", "Store", "ReindexProgress", "ReindexResult",
  "EmbedProgress", "EmbedResult", "EmbedOptions", "PendingEmbeddingDoc", "EmbeddingDoc",
  "ChunkItem", "DocumentResult", "SearchResult", "RankedResult", "RRFContributionTrace",
  "RRFScoreTrace", "HybridQueryExplain", "DocumentNotFound", "MultiGetResult",
  "CollectionInfo", "IndexStatus", "IndexHealthInfo", "DbDocRow", "RankedListMeta"
];

const coreDbFns = [
  "createSqliteVecUnavailableError", "_sqliteVecUnavailableReason", "getErrorMessage",
  "verifySqliteVecLoaded", "_sqliteVecAvailable", "initializeDatabase",
  "isSqliteVecAvailable", "ensureVecTableInternal", "getDefaultDbPath", "getPwd", "getRealPath", "enableProductionMode", "_resetProductionModeForTesting"
];

const coreStoreFns = [
  "createStore"
];

const collectionCrudFns = [
  "rowToNamedCollection", "getStoreCollections", "getStoreCollection",
  "upsertStoreCollection", "deleteStoreCollection", "renameStoreCollection"
];

const collectionContextFns = [
  "getStoreGlobalContext", "getStoreContexts", "updateStoreContext", "removeStoreContext", "setStoreGlobalContext", "syncConfigToDb"
];

function moveNodes(names: string[], destPath: string, extraImports: string) {
  let content = extraImports + "\n\n";
  for (const name of names) {
    const node = sourceFile.getTypeAlias(name) || 
                 sourceFile.getFunction(name) || 
                 sourceFile.getVariableStatement(name) ||
                 sourceFile.getVariableDeclaration(name)?.getVariableStatement() ||
                 sourceFile.getInterface(name);
    if (node) {
      content += node.getFullText() + "\n";
      // We'll delete it later to avoid breaking offsets while iterating, or just remove it now
      // Actually we can just remove it now, ts-morph handles offsets
      node.remove();
    } else {
      console.log(`Node not found: ${name}`);
    }
  }
  fs.writeFileSync(destPath, content);
}

// Ensure dirs
fs.mkdirSync("src/store/types", { recursive: true });
fs.mkdirSync("src/store/core", { recursive: true });
fs.mkdirSync("src/store/collection", { recursive: true });

// Move Types
moveNodes(typesToExtract, "src/store/types/index.ts", `
import type { Database } from "../../db.js";
import type { LlamaCpp } from "../../llm.js";
import type { NamedCollection, Collection, CollectionConfig, ContextMap } from "../../collections.js";
import type { SnippetResult } from "../utils/snippet.js";
import type { VirtualPath } from "../utils/virtual-path.js";
`);

// Move Core DB
moveNodes(coreDbFns, "src/store/core/db.ts", `
import { Database, loadSqliteVec } from "../../db.js";
import { homedir } from "node:os";
import { realpathSync, readFileSync } from "node:fs";
import { resolve, normalizePathSeparators } from "../utils/path.js";
`);

// Move Collection CRUD
moveNodes(collectionCrudFns, "src/store/collection/crud.ts", `
import type { Database } from "../../db.js";
import type { NamedCollection, Collection, ContextMap } from "../../collections.js";
import type { StoreCollectionRow } from "../types/index.js";
`);

// Move Collection Context
moveNodes(collectionContextFns, "src/store/collection/context.ts", `
import type { Database } from "../../db.js";
import type { ContextMap, CollectionConfig } from "../../collections.js";
`);

// Core Store (createStore is huge, let's try moving it)
// wait, createStore depends on EVERYTHING in store.ts.
// It's probably easier to just move createStore to src/store/core/store.ts, and then export it.
// But wait, createStore uses many helper functions that are still in store.ts.
// If we move createStore to store/core/store.ts, we'll need to import all those helpers from store.ts.
// Let's do that.

// First save the file
sourceFile.saveSync();
console.log("Done extracting");
