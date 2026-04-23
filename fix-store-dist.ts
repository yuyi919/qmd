import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const storeFile = project.getSourceFileOrThrow("src/store.ts");
const distImport = storeFile.getImportDeclarations().find(i => i.getModuleSpecifierValue().includes("dist/store.js"));
if (distImport) {
  distImport.remove();
}
storeFile.fixMissingImports();

const embedFile = project.getSourceFileOrThrow("src/store/index/embed.ts");
const astImport = embedFile.getImportDeclarations().find(i => i.getModuleSpecifierValue() === "./ast.js");
if (astImport) {
  astImport.setModuleSpecifier("../../ast.js");
}

project.saveSync();
console.log("Fixed store dist imports");
