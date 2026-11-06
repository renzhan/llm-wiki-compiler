/**
 * @file test/hosted/backend.ts
 * @description Contract fixture for the asynchronous hosted storage boundary.
 * This model has no disk access. Real CAS and fencing are tested in VFS; the
 * fixture serializes mutations solely to exercise compiler port composition.
 */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProjectBackend, ProjectContent, ProjectEntry } from "../../src/hosted/types.js";
import { projectPath } from "../../src/hosted/storage.js";

const missing = () => Object.assign(new Error("missing"), {code: "ENOENT"});

/** Alias-free storage that rejects mutation calls outside host ownership. */
export class MemoryBackend implements ProjectBackend {
  files = new Map<string, ProjectContent>();
  directories = new Set([""]);
  private held = false;
  private tail: Promise<unknown> = Promise.resolve();
  async exists(name: string) {return this.files.has(projectPath(name)) || this.directories.has(projectPath(name));}
  async kind(name: string): Promise<"file" | "directory"> {
    if (this.files.has(projectPath(name))) return "file";
    if (this.directories.has(projectPath(name))) return "directory";
    throw missing();
  }
  async read(name: string) {
    const value = this.files.get(projectPath(name));
    if (!value) throw missing();
    return {...value, bytes: value.bytes.slice()};
  }
  async list(name: string): Promise<ProjectEntry[]> {
    name = projectPath(name);
    if (!this.directories.has(name)) throw missing();
    const prefix = name ? `${name}/` : "";
    const entries: ProjectEntry[] = [];
    for (const [values, kind] of [[this.files.keys(), "file"], [this.directories.values(), "directory"]] as const) {
      for (const key of values) {
        if (key !== name && key.startsWith(prefix) && !key.slice(prefix.length).includes("/")) {
          entries.push({name: key.slice(prefix.length), kind});
        }
      }
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  }
  async mkdir(name: string) {
    this.assertHeld();
    for (let dir = projectPath(name); dir && dir !== "."; dir = path.posix.dirname(dir)) this.directories.add(dir);
  }
  async write(name: string, bytes: Uint8Array, mode: "create" | "replace") {
    this.assertHeld(); name = projectPath(name);
    const previous = this.files.get(name);
    if (previous && mode === "create") throw Object.assign(new Error("exists"), {code: "EEXIST"});
    await this.mkdir(path.posix.dirname(name));
    this.files.set(name, {bytes: bytes.slice(), nodeId: previous?.nodeId ?? randomUUID(),
      version: (previous?.version ?? 0) + 1, etag: createHash("sha256").update(bytes).digest("hex")});
  }
  async remove(name: string) {this.assertHeld(); if (!this.files.delete(projectPath(name))) throw missing();}
  async move(from: string, to: string) {await this.write(to, (await this.read(from)).bytes, "create"); await this.remove(from);}
  async withMutation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      this.held = true;
      try {return await run();} finally {this.held = false;}
    });
    this.tail = result.catch(() => {});
    return result;
  }
  private assertHeld() {if (!this.held) throw new Error("mutation without host lease");}
}
