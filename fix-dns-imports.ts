import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

for (const file of project.getSourceFiles("src/store/**/*.ts")) {
  const dnsImport = file.getImportDeclaration("node:dns");
  if (dnsImport) {
    dnsImport.remove();
    file.addImportDeclaration({
      moduleSpecifier: "../utils/path.js",
      namedImports: ["resolve"]
    });
  }
}

project.saveSync();
console.log("Fixed dns imports");
