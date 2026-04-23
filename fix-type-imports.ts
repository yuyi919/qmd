import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

for (const file of project.getSourceFiles("src/store/**/*.ts")) {
  for (const imp of file.getImportDeclarations()) {
    if (imp.isTypeOnly()) {
      // Check if it imports any function
      for (const named of imp.getNamedImports()) {
        const name = named.getName();
        if (/^[a-z_]/.test(name) && !name.endsWith("Row")) {
          // If it starts with lowercase, it's likely a function or variable.
          imp.setIsTypeOnly(false);
          break;
        }
      }
    }
  }
}
project.saveSync();
console.log("Type imports fixed!");
