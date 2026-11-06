/**
 * @file src/hosted/finalize.ts
 * @description Compose native orphan, seed, link, index and MOC bodies over
 * hosted project storage. No generated page contract is imposed by the host.
 */
import { generateIndexFrom, collectPageSummariesFrom } from "../compiler/indexgen.js";
import { generateMOCFrom } from "../compiler/obsidian.js";
import { resolveLinksFrom } from "../compiler/resolver.js";
import { repairLinksFrom } from "../compiler/link-repair.js";
import { generateSeedPagesWith } from "../compiler/seed-pages.js";
import { markOrphanedWith, orphanUnownedFrozenPagesWith } from "../compiler/orphan.js";
import { seedThenFinalizeWith, finalizeUnchangedCompileWith, type CompileFinalizeSteps } from "../compiler/compile-finalize.js";
import { callClaude } from "../utils/llm.js";
import type { ProjectBackend } from "./types.js";
import { projectReads, projectRecordDirs, projectRecords, writeText } from "./storage.js";
import { projectMutations } from "./mutations.js";

/** The shared native finalize collaborators, closed over one immutable backend. */
export function projectFinalize(backend: ProjectBackend) {
  const reads = projectReads(backend);
  const mutations = projectMutations(backend);
  const scan = (dir: string) => ({listNames: () => reads.listNames(dir), readPage: (slug: string) => reads.readConfinedPage(dir, slug)});
  const summaries = {conceptSummaries: () => collectPageSummariesFrom(scan("wiki/concepts")),
    querySummaries: () => collectPageSummariesFrom(scan("wiki/queries"))};
  const index = () => generateIndexFrom({
    ...summaries,
    loadProfile: async () => undefined,
    collectEntityPages: async () => {throw new Error("typed hosted profiles unsupported");},
    publishIndex: (text) => writeText(backend, "wiki/index.md", text),
  });
  const moc = () => generateMOCFrom({
    listConceptNames: () => reads.listNames("wiki/concepts"),
    readConceptPage: (slug) => reads.readConfinedPage("wiki/concepts", slug),
    publishMoc: (text) => writeText(backend, "wiki/MOC.md", text),
  });
  const resolve = async (changed: string[], fresh: string[]) => mutations.writePages("/", await resolveLinksFrom(reads, changed, fresh));
  const repair = async () => mutations.writePages("/", await repairLinksFrom({pages: reads, candidates: projectRecordDirs(backend)}));
  return bindFinalize({backend, reads, mutations, index, moc, resolve, repair});
}
/** Keep the composition small enough to audit independently of domain bodies. */
function bindFinalize(parts: {
  backend: ProjectBackend; reads: ReturnType<typeof projectReads>; mutations: ReturnType<typeof projectMutations>;
  index: () => Promise<void>; moc: () => Promise<void>;
  resolve: (changed: string[], fresh: string[]) => Promise<unknown>; repair: () => Promise<unknown>;
}) {
  const {backend, reads, mutations, index, moc, resolve, repair} = parts;
  const orphan = {readPage: (_root: string, dir: string, slug: string) => reads.readConfinedPage(dir, slug), warnDropped: async () => {}, writePages: mutations.writePages};
  const steps: CompileFinalizeSteps = {
    seedPages: (root, schema, generation) => generateSeedPagesWith({complete: callClaude, readPage: async (_r, dir, slug) => {
      const result = await reads.readConfinedPage(dir, slug); return "content" in result ? result.content : "";
    }, writePages: mutations.writePages}, root, schema, generation),
    orphanFrozen: (root, draft, slugs) => orphanUnownedFrozenPagesWith(orphan, root, draft, slugs),
    resolveLinks: (_root, changed, fresh) => resolve(changed, fresh), repairLinks: () => repair(),
    flushState: (_root, draft) => draft.flushTo(projectRecords(backend)),
    generateIndex: index, generateMOC: moc, refreshEmbeddings: async () => {},
  };
  return {steps, index, moc, resolve, repair,
    markOrphaned: (root: string, file: string, draft: Parameters<typeof markOrphanedWith>[3]) => markOrphanedWith(orphan, root, file, draft),
    orphanFrozen: steps.orphanFrozen,
    seedThenFinalize: (...args: Parameters<typeof seedThenFinalizeWith> extends [unknown, ...infer Rest] ? Rest : never) => seedThenFinalizeWith(steps, ...args),
    finalizeUnchanged: (...args: Parameters<typeof finalizeUnchangedCompileWith> extends [unknown, ...infer Rest] ? Rest : never) => finalizeUnchangedCompileWith(steps, ...args),
  };
}
