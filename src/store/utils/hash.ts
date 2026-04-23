import { createHash } from "crypto";

export async function hashContent(content: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(content);
  return hash.digest("hex");
}
