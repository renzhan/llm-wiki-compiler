/**
 * @file src/hosted/types.ts
 * @description Explicit asynchronous project storage for a hosted compiler.
 * Storage implementations own authentication, atomic publication and distributed
 * mutation ownership. No member accepts a native FileHandle or process PID.
 */
import type { ProviderOverride } from "../utils/provider.js";

/** A storage entry, without filesystem aliases or special device types. */
export interface ProjectEntry { name: string; kind: "file" | "directory" }
/** One consistent content read and its opaque backend version. */
export interface ProjectContent { bytes: Uint8Array; nodeId: string; version: number; etag: string }
/** Host-owned asynchronous storage. Paths are project-relative POSIX paths. */
export interface ProjectBackend {
  read(path: string): Promise<ProjectContent>;
  exists(path: string): Promise<boolean>;
  kind(path: string): Promise<"file" | "directory">;
  list(path: string): Promise<ProjectEntry[]>;
  mkdir(path: string): Promise<void>;
  write(path: string, bytes: Uint8Array, mode: "create" | "replace"): Promise<void>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  /** Cross-process exclusive ownership, renewed and fenced by the backend. */
  withMutation<T>(run: () => Promise<T>): Promise<T>;
}
/** A producer-defined index input. It contains no vectors. */
export interface SemanticPageInput {
  pageId: string; path: string; nodeId: string; sourceVersion: number; sourceEtag: string;
  title: string; summary: string; pageKind: string; embeddingText: string; embeddingTextHash: string;
  chunks: Array<{chunkIndex: number; text: string; contentHash: string}>;
}
/** External candidate retrieval; compiler still hydrates and checks live pages. */
export interface SemanticMatch {
  pageId: string; title: string; kind: "page" | "chunk"; sourceVersion: number;
  sourceEtag: string; nodeId: string; score: number; text?: string; chunkIndex?: number; contentHash?: string;
}
/** An external index owns model calls, storage, retries and top-K search. */
export interface SemanticBackend {
  exclude(input: {path: string; nodeId: string; sourceVersion: number; sourceEtag: string; reason: string}): Promise<void>;
  submit(page: SemanticPageInput): Promise<void>;
  search(question: string, limit: number, pageScope?: string[]): Promise<SemanticMatch[]>;
}
/** Hosted mode deliberately supports the default knowledge-wiki profile first. */
export interface HostedWikiOptions {
  backend: ProjectBackend;
  semantic: SemanticBackend;
  provider: ProviderOverride;
}
