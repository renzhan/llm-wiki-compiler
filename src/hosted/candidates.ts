/**
 * @file src/hosted/candidates.ts
 * @description Remote candidate persistence using upstream record construction
 * and sanitization. The host's fenced project lease replaces local inode
 * custody; record hashes pin the exact preview a reviewer approved.
 */
import { createHash } from "node:crypto";
import { writeFreshCandidateFrom, type CandidateDraft } from "../compiler/candidates.js";
import { parseCandidateRecord } from "../compiler/candidate-read.js";
import { assertWritableCandidateId } from "../compiler/candidate-paths.js";
import type { ReviewCandidate } from "../utils/types.js";
import type { ProjectBackend } from "./types.js";
import { projectPath, textFrom, writeText } from "./storage.js";

const PENDING = ".llmwiki/candidates";
/** Hashes represent exact bytes, not a lossy rendering of a preview. */
function contentHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
/** Validate candidate identity before constructing its storage locator. */
function candidatePath(id: string): string {
  assertWritableCandidateId(id);
  return `${PENDING}/${id}.json`;
}
/** Read and sanitize one candidate, failing closed on malformed authority. */
export async function readHostedCandidate(backend: ProjectBackend, id: string) {
  const name = candidatePath(id);
  if (!await backend.exists(name)) return null;
  const text = await textFrom(backend, name);
  const candidate = parseCandidateRecord(id, new TextEncoder().encode(text));
  if (candidate.id !== id) throw new Error("hosted candidate identity mismatch");
  return { candidate, hash: contentHash(text) };
}
/** Enumerate records with a hard cap; corrupt records never silently authorize writes. */
export async function listHostedCandidates(backend: ProjectBackend): Promise<ReviewCandidate[]> {
  if (!await backend.exists(PENDING)) return [];
  const leaves = (await backend.list(PENDING)).filter(item => item.kind === "file" && item.name.endsWith(".json"));
  if (leaves.length > 200) throw new Error("too many pending candidates; review before compiling");
  const candidates: ReviewCandidate[] = [];
  for (const item of leaves) {
    const record = await readHostedCandidate(backend, item.name.slice(0, -5));
    if (record) candidates.push(record.candidate);
  }
  return candidates;
}
/** Publish a fresh native candidate, then supersede older ordinary proposals. */
export async function emitCandidate(backend: ProjectBackend, input: CandidateDraft): Promise<ReviewCandidate> {
  const draft = await pinTarget(backend, input);
  const prior = await listHostedCandidates(backend);
  const result = await writeFreshCandidateFrom({
    assertNamespacesHealthy: async () => {},
    ownedDirectory: async (dir) => await backend.exists(projectPath(dir)) ? `/${projectPath(dir)}` : null,
    leafPresent: (dir, name) => backend.exists(projectPath(`${dir}/${name}`)),
    createPending: async (id, text, hooks) => {
      await backend.mkdir(PENDING);
      await hooks.afterParentCheck?.();
      await writeText(backend, candidatePath(id), text, "create");
      await hooks.afterCommit?.();
    },
  }, draft);
  for (const candidate of prior) {
    if (!candidate.candidateKind && candidate.slug === result.slug && candidate.targetDirectory === result.targetDirectory) {
      await backend.remove(candidatePath(candidate.id));
    }
  }
  return result;
}
/** Every hosted proposal captures the actual current target precondition. */
async function pinTarget(backend: ProjectBackend, input: CandidateDraft): Promise<CandidateDraft> {
  const target = `wiki/${input.targetDirectory ?? "concepts"}/${input.slug}.md`;
  if (await backend.exists(target)) return {...input, expectedTargetHash: contentHash(await textFrom(backend, target)), expectTargetAbsent: undefined};
  return {...input, expectTargetAbsent: true, expectedTargetHash: undefined};
}
/** Archive before removing pending authority; retries retain an inspectable record. */
export async function archiveHostedCandidate(backend: ProjectBackend, id: string, expectedHash: string): Promise<void> {
  const record = await readHostedCandidate(backend, id);
  if (!record || record.hash !== expectedHash) throw new Error("candidate changed; refresh the preview");
  const archive = `.llmwiki/candidates/archive/${id}.json`;
  const text = await textFrom(backend, candidatePath(id));
  if (!await backend.exists(archive)) await writeText(backend, archive, text, "create");
  else if (await textFrom(backend, archive) !== text) throw new Error("candidate archive conflict");
  await backend.remove(candidatePath(id));
}
