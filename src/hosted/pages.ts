/**
 * @file src/hosted/pages.ts
 * @description The native page facade and embedding input builder over hosted
 * storage. Published Markdown remains authoritative; no vectors are read here.
 */
import { getPageFrom, listPagesFrom, type PageReads } from "../pages/list.js";
import { scanWikiPagesFrom } from "../compiler/indexgen.js";
import { parseFrontmatter } from "../utils/markdown.js";
import { toCollectedPage } from "../utils/embeddings-collect.js";
import { projectReads } from "./storage.js";
import { projectJournal } from "./mutations.js";
import { journalReadSourcesFrom } from "../trust/journal-classify.js";
import { journalHealthWarningFrom } from "../trust/journal-health-warning.js";
import type { ProjectBackend, SemanticBackend, SemanticPageInput } from "./types.js";

/** Default-profile pages retain upstream parsing and link extraction. */
function hostedPageReads(backend: ProjectBackend): PageReads {
  const reads = projectReads(backend);
  return {
    readPageText: async (dir, slug) => {
      const value = await reads.readConfinedPage(`wiki/${dir}`, slug);
      return "content" in value ? value.content : "";
    },
    scanPages: (dir) => scanWikiPagesFrom({listNames: () => reads.listNames(`wiki/${dir}`), readPage: (slug) => reads.readConfinedPage(`wiki/${dir}`, slug)}),
    loadProfile: async () => undefined,
    collectEntityPages: async () => {throw new Error("typed hosted profiles unsupported");},
    journalWarning: () => journalHealthWarningFrom(journalReadSourcesFrom(projectJournal(backend), "/")),
  };
}
/** A page read must pin the same version that supplied its parsed body. */
export async function semanticPage(backend: ProjectBackend, pageId: string): Promise<SemanticPageInput | null> {
  if (!/^(concepts|queries)\/[^/\\\0]+$/.test(pageId)) throw new Error("invalid hosted page id");
  const name = `wiki/${pageId}.md`;
  if (!await backend.exists(name)) return null;
  const read = await backend.read(name);
  const {meta, body} = parseFrontmatter(new TextDecoder("utf-8", {fatal: true}).decode(read.bytes));
  if (meta.orphaned || typeof meta.title !== "string") return null;
  const page = toCollectedPage(pageId, {slug: pageId.slice(pageId.indexOf("/")+1), title: meta.title, summary: typeof meta.summary === "string" ? meta.summary : "", body});
  return {pageId, path: `/${name}`, nodeId: read.nodeId, sourceVersion: read.version, sourceEtag: read.etag,
    title: page.title, summary: page.summary, pageKind: pageId.split("/")[0],
    embeddingText: page.embeddingText, embeddingTextHash: page.embeddingTextHash,
    chunks: page.chunkTexts.map((text, chunkIndex) => ({text, chunkIndex, contentHash: page.chunkContentHashes[chunkIndex]})),
  };
}
/** Index handoff is repeatable; VFS makes the job identity version-specific. */
export async function submitPublishedPages(backend: ProjectBackend, semantic: SemanticBackend) {
  await submitDirectory(backend, semantic, "wiki");
}

/** Every live Markdown version receives a job or a durable exclusion receipt. */
async function submitDirectory(backend: ProjectBackend, semantic: SemanticBackend, directory: string): Promise<void> {
  for (const item of await backend.list(directory)) {
    const name = `${directory}/${item.name}`;
    if (item.kind === "directory") {await submitDirectory(backend, semantic, name); continue;}
    if (!item.name.endsWith(".md")) continue;
    const pageId = name.slice(5, -3);
    const page = /^(concepts|queries)\/[^/]+$/.test(pageId) ? await semanticPage(backend, pageId) : null;
    if (page) {await semantic.submit(page); continue;}
    const current = await backend.read(name);
    await semantic.exclude({path: `/${name}`, nodeId: current.nodeId, sourceVersion: current.version,
      sourceEtag: current.etag, reason: "native-non-retrievable-page"});
  }
}
/** Reuse the public native page API bodies. */
export function hostedPages(backend: ProjectBackend) {
  const reads = hostedPageReads(backend);
  return { getPage: (ref: Parameters<typeof getPageFrom>[1]) => getPageFrom(reads, ref),
    listPages: (options: Parameters<typeof listPagesFrom>[1] = {}) => listPagesFrom(reads, options) };
}
