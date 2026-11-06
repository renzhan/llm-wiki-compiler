# Hosted default-profile adapter

Baseline: official `v1.5.0`, commit
`c9c8734be8a0b854c1547cfa3ee97f0b8c6bfa5f`. This branch does not include the
later main commit adding `LLMWIKI_MAX_SOURCE_CHARS`.

The new `llm-wiki-compiler/hosted` subpath exposes `createHostedWiki` over a
`ProjectBackend`, a `SemanticBackend` and a per-call provider override. It runs
in the backend process. It does not start CLI, MCP, Sandbox or a filesystem mount.

The project backend supplies asynchronous bytes, versioned reads, alias-free
POSIX paths, atomic create/replace, directory operations and a fenced mutation
lease spanning the complete call. Every backend implementation must enforce its
owned project paths, authentication and lease on the server. Instruction prompts
are not a substitute for those checks. Missing reads throw `code: ENOENT`;
exclusive-create collisions throw `code: EEXIST`. Network and permission errors
must propagate and must never be reported as an absent file.

The facade supports converted Markdown ingestion, incremental default-profile
compilation, native page reads, ordinary candidate preview/approve/reject and
semantic manifest handoff. Preview hashes cover the entire persisted candidate
record. Approval rechecks the target and uses the native planner/executor,
journal, citation checks and source-state/index/MOC finalize bodies.

Semantic manifests contain native title/summary embedding inputs and native
chunk texts/hashes, tied to the exact node ID, version and etag read. The remote
semantic service owns vector generation and storage. This mode disables local
`embeddings.json` writes. Handoff failure is visible; the remote store must also
support durable reconciliation against authoritative published file versions.

## Supported remote operations and recovery

The facade also supports native query answers/citation reporting, source listing,
read/delete, and operator edit/delete using the native journal. Query hits are
revalidated against current node/version/etag and native chunk text/hash.
SemanticBackend must implement version-bound exclusions for non-retrievable
Markdown. The host must reconcile current file versions after failed handoff.

Approval persists a recovery receipt before publication and a published node
identity before finalize. Unfinished approval gates all other facade mutations;
retry the same ID and hash. Approved/rejected decisions and candidate originals
are retained in the archive, with idempotent same-hash retry. Never remove a
receipt to bypass recovery. All writers must honor the facade gate; an external
client with a valid lease directly modifying the same node is not protected by
that gate. Failure injection for this path is still required.

## Remaining deployment boundaries

- Typed profiles, product bindings and connector/validated-answer candidates
  are explicitly refused.
- Native context packs, lint/activity logs, answer-save and durable edit/delete
  finalize-tail recovery do not yet have hosted facades.
- Vector generation, quotas, lifecycle/reconciliation scheduling and model
  migrations are host responsibilities; no hot model generation swap is supplied.
- PA/VFS adapters and UI exist in their own repositories. A passing hosted suite
  does not establish production end-to-end readiness, migration safety or load
  capacity. Validate real provider, PG/object-store and browser flows separately.

## Keeping the fork small

Domain rules remain in the original `*From`/`*With` bodies. Hosted modules compose
them rather than copying extraction, chunking, trust or citation algorithms.
The existing source changes expose the shared candidate parser and collected
embedding-input builder; package/build metadata adds the hosted subpath.
Rebase on an explicit upstream release, run hosted contract witnesses and the
full local regression suite, and inspect seam signature changes before updating
the PA dependency. Never silently advance the release baseline.
