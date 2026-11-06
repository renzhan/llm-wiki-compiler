/**
 * @file src/hosted/retrieval.ts
 * @description Hosted query reuses native live registry, fallback selection,
 * answer generation and citation reporting; external hits are version checked.
 */
import { generateAnswerFrom } from "../commands/query.js";
import { selectRelevantPagesFrom, type SelectedPages } from "../commands/query-selection.js";
import { buildNamespaceDirs, loadPageRecordPairsByPageIdFrom, type LivePageReads } from "../utils/page-registry.js";
import { DEFAULT_PROFILE } from "../profile/default.js";
import { profileDigest } from "../profile/digest.js";
import { collectAnswerCitationIndexFrom } from "../citations/answer-index.js";
import { classifyAnswerCitations } from "../citations/answer-report.js";
import { reportQueryAnswerCitationsWith } from "../commands/query-citation-report.js";
import type { PageId } from "../utils/page-id.js";
import { semanticPage } from "./pages.js";
import { projectReads, projectPath, textFrom } from "./storage.js";
import { hostedCitationSources } from "./citations.js";
import type { ProjectBackend, SemanticBackend, SemanticMatch } from "./types.js";

/** Alias-free entity scans feed the native registry without rebuilding its rules. */
function livePages(backend: ProjectBackend): LivePageReads {
  return {reads: projectReads(backend), scans: {openEntityDirectory: async name => {
    name = projectPath(name);
    if (!await backend.exists(name)) return {status: "missing"};
    if (await backend.kind(name) !== "directory") return {status: "invalid"};
    return {status: "ok", directory: {
      listNames: async () => (await backend.list(name)).map(entry => entry.name),
      resolveEntry: async leaf => {
        if (!leaf || /[/\\\0]/.test(leaf)) return null;
        const target = `${name}/${leaf}`;
        return await backend.exists(target) && await backend.kind(target) === "file" ? `/${target}` : null;
      },
      readPrefix: async (entry, cap) => Buffer.from((await backend.read(projectPath(entry))).bytes).subarray(0, cap),
      readText: entry => textFrom(backend, entry),
    }};
  }}};
}

/** Validate one immutable hit against current compiler authority. */
async function hitIsCurrent(backend: ProjectBackend, hit: SemanticMatch) {
  const page = await semanticPage(backend, hit.pageId);
  if (!page || page.nodeId !== hit.nodeId || page.sourceVersion !== hit.sourceVersion || page.sourceEtag !== hit.sourceEtag) return false;
  if (hit.kind !== "chunk") return true;
  const chunk = page.chunks.find(value => value.chunkIndex === hit.chunkIndex);
  return !!chunk && chunk.text === hit.text && chunk.contentHash === hit.contentHash;
}

/** External evidence is admitted only against the current native manifest. */
async function currentHits(backend: ProjectBackend, matches: SemanticMatch[], scope?: readonly string[]) {
  const admitted: SemanticMatch[] = [];
  for (const hit of matches) {
    if (!/^(concepts|queries)\/[^/]+$/.test(hit.pageId)) continue;
    if (scope && !scope.includes(hit.pageId)) continue;
    if (await hitIsCurrent(backend, hit)) admitted.push(hit);
  }
  return admitted;
}

/** Native fallback remains available while VFS jobs are pending or unavailable. */
async function select(backend: ProjectBackend, semantic: SemanticBackend, question: string, scope?: readonly string[]): Promise<SelectedPages> {
  let matches: SemanticMatch[] = [];
  try {matches = await currentHits(backend, await semantic.search(question, 20, scope ? [...scope] : undefined), scope);} catch { /* native fallback reports degradation */ }
  if (!matches.length) return selectRelevantPagesFrom(livePages(backend), {
    profile: {profile: DEFAULT_PROFILE, loadedFrom: null, digest: profileDigest(DEFAULT_PROFILE)},
    embeddings: {store: null, stalePageIds: [], warnings: [{code: "embedding-degraded", message: "VFS semantic index unavailable or no current hits; native selection used"}]},
    journalWarning: null,
  }, question, false, scope, {embeddingFailure: "fallback"});
  const unique = [...new Map(matches.map(hit => [hit.pageId, hit])).values()];
  return {refs: unique.map(hit => ({pageId: hit.pageId as PageId, slug: hit.pageId.split("/")[1], title: hit.title, kind: hit.kind})),
    reasoning: "VFS semantic retrieval verified against live compiler manifests", warnings: [],
    chunks: matches.filter(hit => hit.kind === "chunk").map(hit => ({pageId: hit.pageId as PageId,
      slug: hit.pageId.split("/")[1], title: hit.title, chunkIndex: hit.chunkIndex!, text: hit.text!, score: hit.score})),
  };
}

/** Read-only native answers; saving an answer requires a separate explicit page edit. */
export function hostedQuery(backend: ProjectBackend, semantic: SemanticBackend, question: string, pageScope?: readonly string[]) {
  return generateAnswerFrom({
    indexPresent: () => backend.exists("wiki/index.md"),
    select: (prompt, _debug, scope) => select(backend, semantic, prompt, scope),
    hydrate: refs => loadPageRecordPairsByPageIdFrom(projectReads(backend), refs.map(ref => ref.pageId), buildNamespaceDirs()),
    answerCitations: body => reportQueryAnswerCitationsWith(async () => classifyAnswerCitations(body,
      await collectAnswerCitationIndexFrom(hostedCitationSources(backend)))),
    publish: async () => ({}), log: async () => {},
  }, question, {pageScope});
}
