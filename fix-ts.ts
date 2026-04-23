import { Project, Diagnostic } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const diagnostics = project.getPreEmitDiagnostics();
for (const diag of diagnostics) {
  const msg = diag.getMessageText();
  if (typeof msg === "string" && msg.includes("must be imported using a type-only import")) {
    const file = diag.getSourceFile();
    if (file) {
      // Find the import declaration containing "ChunkStrategy" and change it to type
      const imp = file.getImportDeclarations().find(i => i.getNamedImports().some(n => n.getName() === "ChunkStrategy"));
      if (imp) {
        const ni = imp.getNamedImports().find(n => n.getName() === "ChunkStrategy");
        if (ni) {
          ni.setIsTypeOnly(true);
        }
      }
    }
  }
}

project.saveSync();
console.log("Types fixed");
