import { Project, SyntaxKind } from "ts-morph";
const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/store.ts");

const typeNames = [
  "ExpandedQuery", "StoreCollectionRow", "Store", "ReindexProgress", "ReindexResult",
  "EmbedProgress", "EmbedResult", "EmbedOptions", "PendingEmbeddingDoc", "EmbeddingDoc",
  "ChunkItem", "DocumentResult", "SearchResult", "RankedResult", "RRFContributionTrace",
  "RRFScoreTrace", "HybridQueryExplain", "DocumentNotFound", "MultiGetResult",
  "CollectionInfo", "IndexStatus", "IndexHealthInfo", "DbDocRow", "RankedListMeta"
];

let text = "";
for (const name of typeNames) {
  const typeAlias = sourceFile.getTypeAlias(name);
  if (typeAlias) text += typeAlias.getFullText() + "\n";
}

console.log(text.substring(0, 500));
