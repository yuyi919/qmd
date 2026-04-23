import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const constantsFile = project.getSourceFileOrThrow("src/store/core/constants.ts");
const dbFile = project.getSourceFileOrThrow("src/store/core/db.ts");

const prodMode = constantsFile.getVariableStatement("_productionMode");
if (prodMode) {
  dbFile.addVariableStatement(prodMode.getStructure());
  prodMode.remove();
}

project.saveSync();
console.log("Moved _productionMode to db.ts");
