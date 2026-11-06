/**
 * @file src/hosted/compile.ts
 * @description Bind the upstream production compile pipeline to remote content,
 * state, candidates, trust execution and finalize bodies. The caller holds the
 * host mutation lease for the entire compile; no local lock file is consulted.
 */
import { compileAndReportWith, type CompileRunSteps } from "../compiler/index.js";
import { CompileStateDraft } from "../compiler/compile-state-draft.js";
import { localCompileAccess, pendingSourceStatesFrom } from "../compiler/compile-access.js";
import { readStateFrom } from "../utils/state.js";
import type { CompileOptions } from "../utils/types.js";
import { projectReads, projectRecords } from "./storage.js";
import { projectMutations } from "./mutations.js";
import { projectFinalize } from "./finalize.js";
import { emitCandidate, listHostedCandidates } from "./candidates.js";
import type { ProjectBackend } from "./types.js";

/** Compose the native compile once per host call without global state. */
export function hostedCompile(backend: ProjectBackend, options: CompileOptions = {}) {
  const reads = projectReads(backend);
  const records = projectRecords(backend);
  const mutations = projectMutations(backend);
  const finalize = projectFinalize(backend);
  const access = localCompileAccess(reads, {
    readState: () => readStateFrom(records),
    pendingSourceStates: () => pendingSourceStatesFrom(() => listHostedCandidates(backend)),
    emitCandidate: (draft) => emitCandidate(backend, draft),
    discardCandidatesForSlug: async (slug) => {
      for (const candidate of await listHostedCandidates(backend)) {
        if (candidate.slug === slug) await backend.remove(`.llmwiki/candidates/${candidate.id}.json`);
      }
    },
  });
  const steps: CompileRunSteps = {
    acquire: async () => true, release: async () => {},
    recoverJournal: async () => { const result = await mutations.recover(); return result; },
    access: () => access, loadDraft: () => CompileStateDraft.loadFrom(records),
    commitLive: mutations.writePages, markOrphaned: finalize.markOrphaned,
    orphanFrozen: finalize.orphanFrozen, seedThenFinalize: finalize.seedThenFinalize,
    finalizeUnchanged: finalize.finalizeUnchanged,
    listPageNames: (_root, dir) => reads.listNames(dir),
    logCompile: async () => {},
  };
  return compileAndReportWith(steps, "/", {...options, embeddings: false});
}
