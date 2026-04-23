import { URLSearchParams } from "url";
import type { Database } from "../../db.js";
import { resolve } from "./path.js";

// We need to import these functions from the store or wherever they reside
// But since they are part of store.ts and use DB, it might be circular.
// We will modify the store to export them or handle it in store.ts
// Wait, getCollectionByName and getStoreCollections are in store.ts
// It's better to import them dynamically or type-only.
import { getCollectionByName, getStoreCollections } from "../index.js";

export type VirtualPath = {
  collectionName: string;
  path: string;
  indexName?: string;
};

export function normalizeVirtualPath(input: string): string {
  let path = input.trim();

  if (path.startsWith('qmd:')) {
    path = path.slice(4);
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  if (path.startsWith('//')) {
    path = path.replace(/^\/+/, '');
    return `qmd://${path}`;
  }

  return path;
}

export function parseVirtualPath(virtualPath: string): VirtualPath | null {
  const normalized = normalizeVirtualPath(virtualPath);
  const [pathPart = normalized, queryString = ""] = normalized.split("?");

  const match = pathPart.match(/^qmd:\/\/([^\/]+)\/?(.*)$/);
  if (!match?.[1]) return null;
  const indexName = new URLSearchParams(queryString).get("index")?.trim() || undefined;
  return {
    collectionName: match[1],
    path: match[2] ?? '',
    ...(indexName ? { indexName } : {}),
  };
}

export function buildVirtualPath(collectionName: string, path: string, indexName?: string): string {
  const base = `qmd://${collectionName}/${path}`;
  return indexName ? `${base}?index=${encodeURIComponent(indexName)}` : base;
}

export function isVirtualPath(path: string): boolean {
  const trimmed = path.trim();

  if (trimmed.startsWith('qmd:')) return true;
  if (trimmed.startsWith('//')) return true;

  return false;
}

export function resolveVirtualPath(db: Database, virtualPath: string): string | null {
  const parsed = parseVirtualPath(virtualPath);
  if (!parsed) return null;

  const coll = getCollectionByName(db, parsed.collectionName);
  if (!coll) return null;

  return resolve(coll.pwd, parsed.path);
}

export function toVirtualPath(db: Database, absolutePath: string): string | null {
  const collections = getStoreCollections(db);

  for (const coll of collections) {
    if (absolutePath.startsWith(coll.path + '/') || absolutePath === coll.path) {
      const relativePath = absolutePath.startsWith(coll.path + '/')
        ? absolutePath.slice(coll.path.length + 1)
        : '';

      const doc = db.prepare(`
        SELECT d.path
        FROM documents d
        WHERE d.collection = ? AND d.path = ? AND d.active = 1
        LIMIT 1
      `).get(coll.name, relativePath) as { path: string } | null;

      if (doc) {
        return buildVirtualPath(coll.name, relativePath);
      }
    }
  }

  return null;
}
