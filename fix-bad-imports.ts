import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

for (const file of project.getSourceFiles("src/store/**/*.ts")) {
  for (const imp of file.getImportDeclarations()) {
    // if importing EmbedOptions from llm.js, remove it
    if (imp.getModuleSpecifierValue().includes("llm.js")) {
      const named = imp.getNamedImports().find(n => n.getName() === "EmbedOptions");
      if (named) {
        named.remove();
        if (imp.getNamedImports().length === 0) imp.remove();
        file.addImportDeclaration({
          moduleSpecifier: "../types/index.js",
          namedImports: ["EmbedOptions"],
          isTypeOnly: true
        });
      }
    }
  }
}

// Fix _productionMode
const dbFile = project.getSourceFileOrThrow("src/store/core/db.ts");
const prodModeImp = dbFile.getImportDeclarations().find(i => i.getModuleSpecifierValue().includes("constants.js"));
if (prodModeImp) {
  const ni = prodModeImp.getNamedImports().find(n => n.getName() === "_productionMode");
  if (ni) {
    ni.remove();
    if (prodModeImp.getNamedImports().length === 0) prodModeImp.remove();
  }
}

// Fix missing exports in db.js that store.ts needs
const dbExports = ["ensureVecTableInternal", "getDefaultDbPath", "initializeDatabase"];
for (const name of dbExports) {
  const node = dbFile.getFunction(name);
  if (node && !node.isExported()) {
    node.setIsExported(true);
  }
}

project.saveSync();
console.log("Fixed bad imports");
