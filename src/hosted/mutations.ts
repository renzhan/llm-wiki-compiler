/**
 * @file src/hosted/mutations.ts
 * @description Keep upstream trust planning, resource checks and journal replay
 * for hosted page writes. Remote atomic file operations replace disk mechanics;
 * this module never suppresses a recovery or weakens a content decision.
 */
import path from "node:path";
import { planPageMutationFrom } from "../trust/planner.js";
import { applyApprovedMutationsLockedFrom } from "../trust/executor.js";
import { recoverJournalBeforeCompileFrom } from "../trust/journal-recovery.js";
import type { ApprovedMutationPorts } from "../trust/executor.js";
import type { JournalBatchIo, JournalReplayIo } from "../trust/journal-io.js";
import type { PageTargetProbes } from "../trust/checks.js";
import { applyCompilePageWritesWith } from "../compiler/compile-write.js";
import type { CompilePageWrite } from "../compiler/compile-write.js";
import type { ProjectBackend } from "./types.js";
import { projectPath, writeText } from "./storage.js";

/** Probe logical confinement in the backend's alias-free namespace. */
function projectProbes(backend: ProjectBackend): PageTargetProbes {
  return {
    confineTarget: async (target) => {
      const name = projectPath(target);
      if (!name.startsWith("wiki/") && name !== ".llmwiki/journal") throw new Error("journal target outside hosted wiki");
      return `/${name}`;
    },
    leafPresent: (dir, name) => backend.exists(projectPath(path.posix.join(dir, name))),
  };
}
/** Bounded reads preserve absent/unavailable distinctions used by recovery. */
async function cappedBytes(backend: ProjectBackend, leaf: string, cap: number) {
  if (!await backend.exists(projectPath(leaf))) return { kind: "absent" as const };
  const value = await backend.read(projectPath(leaf));
  if (value.bytes.length > cap) return { kind: "unavailable" as const };
  return { kind: "ok" as const, body: Buffer.from(value.bytes) };
}
/** Construct one shared journal port so record and replay use the same store. */
export function projectJournal(backend: ProjectBackend): JournalBatchIo & JournalReplayIo {
  return {
    ...projectProbes(backend),
    realPath: async (name) => `/${projectPath(name)}`,
    safeRealPath: async (name) => await backend.exists(projectPath(name)) ? `/${projectPath(name)}` : null,
    readConfinedLeafBytes: (_root, leaf, _dir, cap) => cappedBytes(backend, leaf, cap),
    readConfinedLeafText: async (_root, leaf, _dir, cap) => {
      const read = await cappedBytes(backend, leaf, cap);
      return read.kind === "ok" ? {kind: "ok", body: new TextDecoder("utf-8", {fatal: true}).decode(read.body)} : read;
    },
    replaceLeafAtomicWithin: (_root, leaf, text) => writeText(backend, leaf, text),
    replaceLeafContentWithin: (_root, leaf, content) => backend.write(projectPath(leaf), typeof content === "string" ? new TextEncoder().encode(content) : content, "replace"),
    readLeafTextNoFollow: async (leaf) => {
      const result = await cappedBytes(backend, leaf, 10_000_000);
      return result.kind === "ok" ? new TextDecoder("utf-8", {fatal: true}).decode(result.body) : null;
    },
    removeLeaf: (leaf) => backend.remove(projectPath(leaf)),
    listDirectoryNames: async (dir) => (await backend.list(projectPath(dir))).map(item => item.name),
    makeDirectoryTree: (dir) => backend.mkdir(projectPath(dir)),
    renameLeafUnguarded: (from, to) => backend.move(projectPath(from), projectPath(to)),
  };
}
/** Non-page execution is deliberately unavailable until explicitly supported. */
function unsupported(): never { throw new Error("hosted backend does not support this mutation kind"); }
/** Planner and executor share the host's already-held mutation lease. */
export function projectMutations(backend: ProjectBackend) {
  const journal = projectJournal(backend);
  const ports: ApprovedMutationPorts = {
    journal, page: {...projectProbes(backend), readConfinedLeafText: (root,leaf,dir,cap) => journal.readConfinedLeafText(root,leaf,dir,cap,{}), removeLeaf: journal.removeLeaf},
    writeOne: (leaf, text) => writeText(backend, leaf, text), notes: () => {},
    handlers: { relation: unsupported, lifecycle: unsupported, artifact: unsupported },
  };
  const plan = (input: Parameters<typeof planPageMutationFrom>[1]) => planPageMutationFrom(projectProbes(backend), input);
  const apply = (root: string, mutations: Parameters<typeof applyApprovedMutationsLockedFrom>[2]) => applyApprovedMutationsLockedFrom(ports, root, mutations);
  const writePages = (_root: string, writes: CompilePageWrite[]) => applyCompilePageWritesWith({plan, apply}, "/", writes);
  return {journal, plan, apply, writePages, recover: () => recoverJournalBeforeCompileFrom(journal, "/")};
}
