/**
 * @file src/hosted/ingest.ts
 * @description Native Markdown ingestion and stable source identity over remote
 * storage. Only converted text enters here; document conversion stays upstream
 * of this compiler boundary. The host owns the already-held mutation lease.
 */
import path from "node:path";
import { ingestTextSourceWith, type IngestTextInput } from "../commands/ingest.js";
import { saveSourceWith, listIdentityNamesFrom, sourceIdentityReadsOver } from "../utils/source-writer.js";
import { projectReads, projectPath, textFrom, writeText } from "./storage.js";
import type { ProjectBackend } from "./types.js";

/** Ingest a stable source with upstream frontmatter, collision and dedup rules. */
export function hostedIngest(backend: ProjectBackend, input: IngestTextInput) {
  const reads = projectReads(backend);
  return ingestTextSourceWith({
    save: (title, document, source) => saveSourceWith({
      openSourcesDir: async () => {await backend.mkdir("sources"); return "/sources";},
      listIdentityNames: () => listIdentityNamesFrom(sourceIdentityReadsOver(reads)),
      regularFile: async (dir, name) => {
        const file = projectPath(path.posix.join(dir, name));
        return await backend.exists(file) && await backend.kind(file) === "file" ? `/${file}` : null;
      },
      readText: (file) => textFrom(backend, file),
      entryPresent: (dir, name) => backend.exists(projectPath(path.posix.join(dir, name))),
      createExclusive: (dir, name, text) => writeText(backend, path.posix.join(dir, name), text, "create"),
      entryKind: (dir, name) => backend.kind(projectPath(path.posix.join(dir, name))),
      overwrite: (dir, name, text) => writeText(backend, path.posix.join(dir, name), text),
    }, title, document, source),
    journal: async () => {},
  }, input);
}
