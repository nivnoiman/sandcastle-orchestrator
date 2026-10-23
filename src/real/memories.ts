import { join } from "node:path";
import type { FileSystemPort } from "./fileSystem.js";
import type { SandcastleLayout } from "./paths.js";

export interface ResolvedMemory {
  slug: string;
  content: string;
}

const MEMORY_SLUG = /^[A-Za-z0-9._-]+$/;

export function memoryPath(layout: SandcastleLayout, slug: string): string {
  return join(layout.memoryDir, `${slug}.md`);
}

export function missingMemoryFiles(
  fs: FileSystemPort,
  layout: SandcastleLayout,
  slugs: readonly string[],
): string[] {
  const missing: string[] = [];
  for (const slug of new Set(slugs)) {
    if (!MEMORY_SLUG.test(slug)) {
      missing.push(`${slug} (not a bare file name)`);
      continue;
    }
    const path = memoryPath(layout, slug);
    if (!fs.exists(path)) missing.push(`${slug} (${path})`);
  }
  return missing;
}

export function loadMemories(
  fs: FileSystemPort,
  layout: SandcastleLayout,
  slugs: readonly string[],
): ResolvedMemory[] {
  const seen = new Set<string>();
  const resolved: ResolvedMemory[] = [];
  const missing: string[] = [];
  for (const slug of slugs) {
    if (seen.has(slug)) continue;
    seen.add(slug);
    if (!MEMORY_SLUG.test(slug)) throw new Error(`memory slug "${slug}" is not a bare file name`);
    const path = memoryPath(layout, slug);
    const content = fs.readText(path);
    if (content === undefined) {
      missing.push(`${slug} (${path})`);
      continue;
    }
    resolved.push({ slug, content: content.trim() });
  }
  if (missing.length > 0) {
    throw new Error(`load-bearing memory files not found: ${missing.join(", ")}`);
  }
  return resolved;
}
