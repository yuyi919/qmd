import { Project } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const files = project.getSourceFiles("src/store/**/*.ts");

for (const file of files) {
  file.fixMissingImports();
  file.organizeImports();
}

project.saveSync();
console.log("Imports fixed!");
