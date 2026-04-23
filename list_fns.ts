import { Project, SyntaxKind } from "ts-morph";
const project = new Project();
const sourceFile = project.addSourceFileAtPath("src/store.ts");

const exportedFns = sourceFile.getFunctions().filter(f => f.isExported()).map(f => f.getName());
console.log(exportedFns.join("\n"));
