/**
 * @file src/hosted/review.ts
 * @description Hosted review publication uses the native planner, journal,
 * citation checks and source-state finalize. Every decision pins the exact
 * preview bytes. Refusals throw to the API caller without process.exitCode.
 * Typed and connector workflows are outside this default-profile contract.
 */
import { assertWritableCandidateId } from "../compiler/candidate-paths.js";
import { validateWikiPage } from "../utils/markdown.js";
import { targetUnchangedSinceProposeFrom } from "../commands/review-target-precondition.js";
import { finalizeReviewApprovalsWith } from "../commands/review-finalize.js";
import { readStateFrom, writeStateTo } from "../utils/state.js";
import type { ProjectBackend, SemanticBackend } from "./types.js";
import { archiveHostedCandidate, readHostedCandidate } from "./candidates.js";
import { projectMutations } from "./mutations.js";
import { projectReads, projectRecords, textFrom, writeText } from "./storage.js";
import { projectFinalize } from "./finalize.js";
import { hostedPublicationReads } from "./citations.js";
import { submitPublishedPages } from "./pages.js";

/** Pin exact persisted authority, including metadata invisible in the body. */
async function reviewedCandidate(backend: ProjectBackend, id: string, hash: string) {
  const record = await readHostedCandidate(backend, id);
  if (!record || record.hash !== hash) throw new Error("candidate changed; refresh the preview");
  const candidate = record.candidate;
  if (candidate.targetEntityType || candidate.candidateKind || candidate.connectorProvenance
      || candidate.reviewMode === "connector") throw new Error("candidate kind unsupported by hosted review");
  if (candidate.targetDirectory && !["concepts", "queries"].includes(candidate.targetDirectory)) {
    throw new Error("invalid candidate directory");
  }
  return candidate;
}

const RECEIPT = ".llmwiki/approval-recovery.json";

/** Block unrelated writers until the pinned approval has finished its tail. */
export async function assertApprovalIdle(backend: ProjectBackend, id?: string, hash?: string) {
  if (!await backend.exists(RECEIPT)) return;
  const receipt = JSON.parse(await textFrom(backend, RECEIPT));
  if (receipt.id !== id || receipt.hash !== hash) throw new Error("approval recovery required before other mutations");
}

/** Approve while the host holds the fenced lease; never call a local CLI. */
export async function hostedApprove(backend: ProjectBackend, semantic: SemanticBackend, id: string, hash: string) {
  const mutations = projectMutations(backend);
  if ((await mutations.recover()).status === "unsafe") throw new Error("unsafe mutation journal");
  await assertApprovalIdle(backend, id, hash);
  assertWritableCandidateId(id);
  const decisionPath = `.llmwiki/candidates/archive/${id}.approved.json`;
  if (await backend.exists(decisionPath)) {
    if (JSON.parse(await textFrom(backend, decisionPath)).hash !== hash) throw new Error("candidate changed; refresh the preview");
    await finishApprovalArchive(backend, id, hash);
    return;
  }
  if (!await backend.exists(RECEIPT)) {
    const candidate = await reviewedCandidate(backend, id, hash);
    await validateApproval(backend, candidate);
    await writeText(backend, RECEIPT, JSON.stringify({id, hash, candidate}), "create");
  }
  const candidate = await publishApproval(backend, mutations, id, hash);
  await finalizeApproval(backend, semantic, candidate);
  await writeText(backend, decisionPath, JSON.stringify({id, hash, action: "approve"}), "create");
  await finishApprovalArchive(backend, id, hash);
}

/** Replay publication independently from the derived-state tail. */
async function publishApproval(backend: ProjectBackend, mutations: ReturnType<typeof projectMutations>, id: string, hash: string) {
  const {candidate, phase, publishedNodeId} = JSON.parse(await textFrom(backend, RECEIPT)) as {
    candidate: Awaited<ReturnType<typeof reviewedCandidate>>; phase?: string; publishedNodeId?: string;
  };
  const target = `wiki/${candidate.targetDirectory ?? "concepts"}/${candidate.slug}.md`;
  if (phase === "published" && (await backend.read(target)).nodeId !== publishedNodeId) throw new Error("target changed during approval recovery");
  if (phase !== "published") await applyApproval(backend, mutations, candidate, target);
  if (phase !== "published") await writeText(backend, RECEIPT, JSON.stringify({id, hash, candidate,
    phase: "published", publishedNodeId: (await backend.read(target)).nodeId}));
  return candidate;
}

/** Native planner authorizes publication against the pinned target. */
async function applyApproval(backend: ProjectBackend, mutations: ReturnType<typeof projectMutations>,
  candidate: Awaited<ReturnType<typeof reviewedCandidate>>, target: string) {
  if (await backend.exists(target) && await textFrom(backend, target) === candidate.body) return;
  if (!await targetUnchangedSinceProposeFrom(projectReads(backend), candidate)) throw new Error("target changed during approval recovery");
  const {planned} = await mutations.plan({root: "/", target: {
    kind: "raw", directory: candidate.targetDirectory === "queries" ? "queries" : "concepts", slug: candidate.slug,
  }, body: candidate.body, origin: "review", reviewRouted: false, allowOverwrite: true});
  if (!planned.length) throw new Error("candidate blocked by native planner");
  await mutations.apply("/", planned);
}

/** Durable decision precedes pending cleanup, making unknown-success retries safe. */
async function finishApprovalArchive(backend: ProjectBackend, id: string, hash: string) {
  if (await readHostedCandidate(backend, id)) await archiveHostedCandidate(backend, id, hash);
  if (await backend.exists(RECEIPT)) await backend.remove(RECEIPT);
}

/** Validate authority before recording an operation that may be replayed. */
async function validateApproval(backend: ProjectBackend, candidate: Awaited<ReturnType<typeof reviewedCandidate>>) {
  if (!await targetUnchangedSinceProposeFrom(projectReads(backend), candidate)) throw new Error("target changed since proposal");
  if (!validateWikiPage(candidate.body)) throw new Error("candidate failed native page validation");
  const broken = await hostedPublicationReads(backend).brokenTargets(candidate.body);
  if (broken.length) throw new Error(`broken citation targets: ${broken.join(", ")}`);
}

/** Native approval tail keeps source ownership and all derived pages aligned. */
async function finalizeApproval(backend: ProjectBackend, semantic: SemanticBackend,
  candidate: Awaited<ReturnType<typeof reviewedCandidate>>) {
  const finalize = projectFinalize(backend);
  const records = projectRecords(backend);
  await finalizeReviewApprovalsWith({
    readState: () => readStateFrom(records), writeState: (_root, state) => writeStateTo(records, state),
    resolveLinks: async (_root, changed, fresh) => {await finalize.resolve(changed, fresh); return [];},
    repairLinks: async () => {await finalize.repair(); return [];},
    generateIndex: finalize.index, generateMOC: finalize.moc,
    refreshDraining: () => submitPublishedPages(backend, semantic),
    refreshAffected: async () => {await submitPublishedPages(backend, semantic); return true;},
  }, "/", [candidate]);
}

/** Reject retains an audit copy and removes pending mutation authority. */
export async function hostedReject(backend: ProjectBackend, id: string, hash: string) {
  assertWritableCandidateId(id);
  const path = `.llmwiki/candidates/archive/${id}.rejected.json`;
  if (await backend.exists(path)) {
    if (JSON.parse(await textFrom(backend, path)).hash !== hash) throw new Error("candidate changed; refresh the preview");
    if (await readHostedCandidate(backend, id)) await archiveHostedCandidate(backend, id, hash);
    return;
  }
  await reviewedCandidate(backend, id, hash);
  await writeText(backend, path, JSON.stringify({id, hash, action: "reject"}), "create");
  await archiveHostedCandidate(backend, id, hash);
}
