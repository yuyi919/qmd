import { Project, SyntaxKind } from "ts-morph";
const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/store.ts");

const fns = sourceFile.getFunctions().filter(f => !f.isExported()).map(f => f.getName());
let totalLines = 0;
for (const name of fns) {
  const node = sourceFile.getFunction(name);
  if (node) {
    const lines = node.getEndLineNumber() - node.getStartLineNumber() + 1;
    console.log(`${name}: ${lines}`);
  }
}
