/**
 * @file src/hosted/storage.ts
 * @description Bind the compiler's content/record bodies to a project backend.
 * Logical confinement is checked before every operation; a hosted backend has
 * no symlinks, OS special files, native inode assumptions or local fallback.
 */
import path from "node:path";
import type { LegacyLocalReads } from "../storage/legacy-local-reads.js";
import type { LegacyLocalRecords } from "../storage/legacy-local-records.js";
import type { LegacyLocalRecordDirs } from "../storage/legacy-local-record-dirs.js";
import type { ProjectBackend } from "./types.js";

/** Canonicalize an owned path, rejecting traversal before normalization. */
export function projectPath(value: string): string {
  const relative = value.replace(/^\//, "");
  if (relative.startsWith("/") || relative.includes("\\") || relative.includes("\0") || relative.split("/").includes("..")) {
    throw new Error("hosted project path escapes its root");
  }
  const clean = path.posix.normalize(relative);
  return clean === "." ? "" : clean;
}
/** UTF-8 authority reads reject invalid bytes instead of repairing them. */
export async function textFrom(backend: ProjectBackend, name: string): Promise<string> {
  const content = await backend.read(projectPath(name));
  return new TextDecoder("utf-8", { fatal: true }).decode(content.bytes);
}
/** Atomic text publication delegates durability to the host. */
export function writeText(backend: ProjectBackend, name: string, text: string, mode: "create" | "replace" = "replace") {
  return backend.write(projectPath(name), new TextEncoder().encode(text), mode);
}
/** Missing leaves are values; permission/network failures must remain failures. */
async function confinedText(backend: ProjectBackend, name: string) {
  if (!await backend.exists(projectPath(name))) return { dropped: "absent" };
  return { content: await textFrom(backend, name) };
}
/** The existing shared content readers over remote storage. */
export function projectReads(backend: ProjectBackend): LegacyLocalReads {
  return {
    readText: (name) => textFrom(backend, name),
    exists: (name) => backend.exists(projectPath(name)),
    statNoFollow: (name) => backend.kind(projectPath(name)),
    listNames: async (name) => (await backend.list(projectPath(name))).map(entry => entry.name),
    realDirectory: async (name) => !await backend.exists(projectPath(name)) || await backend.kind(projectPath(name)) !== "directory" ? null : {
      listEntries: (relative) => backend.list(projectPath(path.posix.join(name, relative))),
    },
    readConfinedPage: (dir, slug) => confinedText(backend, path.posix.join(dir, `${slug}.md`)),
    readConfinedFile: (name) => confinedText(backend, name),
    locate: (name) => `/${projectPath(name)}`,
  };
}
/** Compile state keeps the upstream JSON parser/version migration semantics. */
export function projectRecords(backend: ProjectBackend): LegacyLocalRecords {
  return {
    exists: (name) => backend.exists(projectPath(name)),
    readTextNoFollow: (name) => textFrom(backend, name),
    copy: async (from, to) => backend.write(projectPath(to), (await backend.read(projectPath(from))).bytes, "replace"),
    writeAtomic: (name, text) => writeText(backend, name, text),
    locate: (name) => `/${projectPath(name)}`,
  };
}
/** Tolerant record listings used by link repair retain upstream sanitization. */
export function projectRecordDirs(backend: ProjectBackend): LegacyLocalRecordDirs {
  return {
    directory: async (dir) => !await backend.exists(projectPath(dir)) ? null : {
      exists: () => backend.exists(projectPath(dir)),
      listEntries: () => backend.list(projectPath(dir)),
    },
    leaf: async (dir, file) => ({ location: `/${projectPath(`${dir}/${file}`)}`, readText: () => textFrom(backend, `${dir}/${file}`) }),
  };
}
