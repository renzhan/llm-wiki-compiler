/**
 * @file src/hosted/citations.ts
 * @description Native citation resolution over immutable remote read snapshots.
 * Positional frontmatter parsing runs over the bytes already read from VFS,
 * avoiding one network request per parser read while preserving parser rules.
 */
import { type AnswerCitationSources, type StrictPageDirectory } from "../citations/answer-index.js";
import { genericCitationReadsOver } from "../citations/generic-publication.js";
import { publicationCheckReadsOver } from "../commands/review-publication.js";
import { projectPath, projectRecordDirs } from "./storage.js";
import type { ProjectBackend } from "./types.js";

/** Directory entry identity is lexical: hosted namespaces have no aliases. */
function pageDirectory(backend: ProjectBackend, directory: string): StrictPageDirectory {
  return {
    listNames: async () => (await backend.list(directory)).filter(entry => entry.kind === "file").map(entry => entry.name),
    resolveEntry: async name => {
      if (!name || name.includes("/") || name.includes("\\")) throw new Error("invalid citation entry");
      const entry = projectPath(`${directory}/${name}`);
      return await backend.exists(entry) && await backend.kind(entry) === "file" ? entry : null;
    },
    readEntryThrough: async (entry, read) => {
      try {
        const bytes = Buffer.from((await backend.read(entry)).bytes);
        const value = await read({read: async (buffer, offset, length, position) => ({
          bytesRead: bytes.copy(buffer, offset, position, Math.min(position + length, bytes.length)),
        })});
        return {kind: "ok", value};
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {kind: "absent"};
        return {kind: "unreadable", cause: cause instanceof Error ? cause : new Error(String(cause))};
      }
    },
  };
}

/** Compose upstream retained/pending citation collection, with strict I/O. */
export function hostedCitationSources(backend: ProjectBackend): AnswerCitationSources {
  return {resolveProject: async () => ({
    candidateDirs: projectRecordDirs(backend),
    openPageDirectory: async directory => !await backend.exists(directory) ? null : pageDirectory(backend, directory),
  })};
}

/** Native publication checks, shared with review and generated answers. */
export function hostedPublicationReads(backend: ProjectBackend) {
  const citations = hostedCitationSources(backend);
  const generic = genericCitationReadsOver({citations, candidateDirs: projectRecordDirs(backend)});
  return publicationCheckReadsOver({generic, citations});
}

