const fs = require('fs');
const glob = require('fast-glob');

const files = glob.sync('src/store/**/*.ts');

for (const file of files) {
  let content = fs.readFileSync(file, 'utf8');
  // Fix imports from original store.ts
  content = content.replace(/from "\.\/(db\.js|llm\.js|collections\.js|ast\.js)"/g, 'from "../../$1"');
  content = content.replace(/from "\.\/store\/([^"]+)"/g, 'from "../$1"');
  
  // Fix `import type { functionName }`
  content = content.replace(/import type \{([^}]+)\} from "([^"]+)";/g, (match, p1, p2) => {
    // If p1 contains a function we know is a function, remove type
    // Let's just remove `type` if it contains lowercase letters (hacky but might work for functions)
    // A better way is to just let ESLint fix it or manually fix the ones that error.
    return match;
  });

  fs.writeFileSync(file, content);
}
console.log('Paths fixed!');
