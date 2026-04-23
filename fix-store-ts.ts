import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const storeFile = project.getSourceFileOrThrow("src/store.ts");
storeFile.fixMissingImports();

// ensureVecTableInternal etc. are exported from src/store/core/db.ts
// BUT src/store/core/store.ts imports them from "../../db.js"!
// Wait, they are in src/store/core/db.ts, so store.ts should import them from "./db.js".
const coreStoreFile = project.getSourceFileOrThrow("src/store/core/store.ts");
for (const imp of coreStoreFile.getImportDeclarations()) {
  if (imp.getModuleSpecifierValue() === "../../db.js") {
    // If it imports from "../../db.js", it should only import Database etc.
    // ensureVecTableInternal etc. are in "./db.js"
    const dbNamed = imp.getNamedImports().map(n => n.getName());
    const locals = ["ensureVecTableInternal", "getDefaultDbPath", "initializeDatabase"];
    const toMove = dbNamed.filter(n => locals.includes(n));
    if (toMove.length > 0) {
      for (const n of toMove) {
        const ni = imp.getNamedImports().find(x => x.getName() === n);
        if (ni) ni.remove();
      }
      coreStoreFile.addImportDeclaration({
        moduleSpecifier: "./db.js",
        namedImports: toMove
      });
    }
  }
}

// emojiToHex in reindex.ts is missing. I probably missed it when splitting!
// Let's see if emojiToHex is in src/store.ts
const emojiToHex = storeFile.getFunction("emojiToHex");
if (emojiToHex) {
  emojiToHex.setIsExported(true);
  const reindexFile = project.getSourceFileOrThrow("src/store/index/reindex.ts");
  reindexFile.addStatements(emojiToHex.getFullText());
  emojiToHex.remove();
}

// fix ast.js in embed.ts
const embedFile = project.getSourceFileOrThrow("src/store/index/embed.ts");
for (const imp of embedFile.getImportDeclarations()) {
  if (imp.getModuleSpecifierValue() === "./ast.js") {
    imp.setModuleSpecifier("../../ast.js");
  }
}

project.saveSync();
console.log("Fixed store.ts");
