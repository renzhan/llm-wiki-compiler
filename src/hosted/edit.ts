/**
 * @file src/hosted/edit.ts
 * @description Explicit operator edits use native publication guards and journal.
 */
import { deleteWikiPagesWith } from "../wiki/delete-page.js";
import { openBatchFrom, recordPreStateFrom, commitBatchFrom } from "../trust/journal.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { validateWikiPage } from "../utils/markdown.js";
import { hostedPublicationReads } from "./citations.js";
import { projectMutations } from "./mutations.js";
import { projectFinalize } from "./finalize.js";
import { submitPublishedPages } from "./pages.js";
import type { ProjectBackend, SemanticBackend } from "./types.js";

/** Restrict manual authority to native default-profile page references. */
function pageTarget(pageId: string) {
  const match = /^(concepts|queries)\/([^/]+)$/.exec(pageId);
  if (!match || !isSafeFilenameComponent(match[2])) throw new Error("invalid hosted page id");
  return {directory: match[1] as "concepts" | "queries", slug: match[2]};
}

/** Publish a user-authored page without bypassing native validation or citations. */
export async function editHostedPage(backend: ProjectBackend, semantic: SemanticBackend, pageId: string, body: string) {
  const target = pageTarget(pageId);
  if (!validateWikiPage(body)) throw new Error("page failed native validation");
  const broken = await hostedPublicationReads(backend).brokenTargets(body);
  if (broken.length) throw new Error(`broken citation targets: ${broken.join(", ")}`);
  const mutations = projectMutations(backend);
  if ((await mutations.recover()).status === "unsafe") throw new Error("unsafe mutation journal");
  const {planned} = await mutations.plan({root: "/", target: {kind: "raw", ...target}, body,
    origin: "review", reviewRouted: false, allowOverwrite: true});
  if (!planned.length) throw new Error("edit blocked by native planner");
  await mutations.apply("/", planned);
  const finalize = projectFinalize(backend);
  await finalize.index();
  await finalize.moc();
  await submitPublishedPages(backend, semantic);
}

/** Delete through the upstream replay/pre-state/verify/commit protocol. */
export async function deleteHostedPage(backend: ProjectBackend, semantic: SemanticBackend, pageId: string) {
  const target = pageTarget(pageId);
  const name = `wiki/${target.directory}/${target.slug}.md`;
  if (!await backend.exists(name)) return false;
  const mutations = projectMutations(backend);
  await deleteWikiPagesWith({
    replayJournal: async () => {if ((await mutations.recover()).status === "unsafe") throw new Error("unsafe mutation journal");},
    openBatch: () => openBatchFrom(mutations.journal, "/"),
    recordPreState: (batch) => recordPreStateFrom(mutations.journal, batch, `/${name}`),
    unlink: () => backend.remove(name),
    probeNoFollow: async () => {await backend.kind(name);},
    commitBatch: batch => commitBatchFrom(mutations.journal, batch),
  }, [target.slug]);
  const finalize = projectFinalize(backend);
  await finalize.index();
  await finalize.moc();
  await submitPublishedPages(backend, semantic);
  return true;
}
