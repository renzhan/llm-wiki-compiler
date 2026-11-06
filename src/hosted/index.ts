/**
 * @file src/hosted/index.ts
 * @description Hosted default-profile knowledge compiler over explicit async
 * storage and semantic services. The host owns identity and fenced locking;
 * this facade scopes providers per call and never creates local project files.
 */
import { runWithProviderOverride } from "../utils/provider.js";
import { withQuiet } from "../utils/output.js";
import type { CompileOptions } from "../utils/types.js";
import type { IngestTextInput } from "../commands/ingest.js";
import { deleteHostedPage, editHostedPage } from "./edit.js";
import { hostedQuery } from "./retrieval.js";
import { isSafeFilenameComponent } from "../profile/identity.js";
import { textFrom } from "./storage.js";
import { hostedCompile } from "./compile.js";
import { hostedIngest } from "./ingest.js";
import { hostedPages, submitPublishedPages } from "./pages.js";
import { listHostedCandidates, readHostedCandidate } from "./candidates.js";
import { assertApprovalIdle, hostedApprove, hostedReject } from "./review.js";
import type { HostedWikiOptions } from "./types.js";
export type { HostedWikiOptions, ProjectBackend, ProjectContent, ProjectEntry,
  SemanticBackend, SemanticPageInput, SemanticMatch } from "./types.js";
export type { LLMProvider, LLMMessage, LLMTool, ProviderOverride } from "../utils/provider.js";

type Scope = <T>(run: () => Promise<T>) => Promise<T>;
type Mutate = <T>(run: () => Promise<T>, approval?: {id: string; hash: string}) => Promise<T>;

/** Construct a hosted compiler without consulting process-global provider env. */
export function createHostedWiki(options: HostedWikiOptions) {
  const {backend, semantic, provider} = options;
  const scoped: Scope = run => runWithProviderOverride(provider, () => withQuiet(async () => {
    await assertDefaultProject(backend);
    return run();
  }));
  const mutate: Mutate = (run, approval) => scoped(() => backend.withMutation(async () => {
    await initialize(backend);
    await assertApprovalIdle(backend, approval?.id, approval?.hash);
    return run();
  }));
  return {...readOperations(options, scoped), ...writeOperations(options, mutate)};
}

/** Read APIs share profile and provider scoping without acquiring writer leases. */
function readOperations({backend, semantic}: HostedWikiOptions, scoped: Scope) {
  return {
    getPage: (ref: Parameters<ReturnType<typeof hostedPages>["getPage"]>[0]) => scoped(() => hostedPages(backend).getPage(ref)),
    listPages: (settings: Parameters<ReturnType<typeof hostedPages>["listPages"]>[0] = {}) => scoped(() => hostedPages(backend).listPages(settings)),
    listSources: () => scoped(async () => await backend.exists("sources")
      ? (await backend.list("sources")).filter(entry => entry.kind === "file" && entry.name.endsWith(".md")) : []),
    readSource: (name: string) => scoped(() => textFrom(backend, sourcePath(name))),
    query: (question: string, pageScope?: readonly string[]) => scoped(() => hostedQuery(backend, semantic, question, pageScope)),
    listCandidates: () => scoped(() => listHostedCandidates(backend)),
    readCandidate: (id: string) => scoped(() => readHostedCandidate(backend, id)),
  };
}

/** Confine source operations to one native Markdown leaf. */
function sourcePath(name: string) {
  if (!isSafeFilenameComponent(name) || !name.endsWith(".md")) throw new Error("invalid source filename");
  return `sources/${name}`;
}

/** Every mutation shares fenced ownership and approval-recovery admission. */
function writeOperations({backend, semantic}: HostedWikiOptions, mutate: Mutate) {
  const compile = async (settings: CompileOptions = {}) => {
    const result = await hostedCompile(backend, settings);
    await submitPublishedPages(backend, semantic);
    return result;
  };
  return {
    deleteSource: (name: string) => mutate(async () => {await backend.remove(sourcePath(name)); return compile();}),
    deletePage: (pageId: string) => mutate(() => deleteHostedPage(backend, semantic, pageId)),
    editPage: (pageId: string, body: string) => mutate(() => editHostedPage(backend, semantic, pageId, body)),
    ingestText: (input: IngestTextInput) => mutate(() => hostedIngest(backend, input)),
    compile: (settings: CompileOptions = {}) => mutate(() => compile(settings)),
    ingestAndCompile: (inputs: IngestTextInput[], settings: CompileOptions = {}) => mutate(async () => {
      const ingested = [];
      for (const input of inputs) ingested.push(await hostedIngest(backend, input));
      return {ingested, compiled: await compile(settings)};
    }),
    approve: (id: string, hash: string) => mutate(() => hostedApprove(backend, semantic, id, hash), {id, hash}),
    reject: (id: string, hash: string) => mutate(() => hostedReject(backend, id, hash)),
    refreshSemantic: () => mutate(() => submitPublishedPages(backend, semantic)),
  };
}

/** Only host-owned directories are created, always under mutation ownership. */
async function initialize(backend: HostedWikiOptions["backend"]) {
  await assertDefaultProject(backend);
  for (const directory of ["sources", "wiki/concepts", "wiki/queries", ".llmwiki/candidates/archive"]) {
    await backend.mkdir(directory);
  }
}

/** Fail closed rather than silently read a product or typed project as default Wiki. */
async function assertDefaultProject(backend: HostedWikiOptions["backend"]) {
  for (const path of [".llmwiki/profile.json", ".llmwiki/active-product.json"]) {
    if (await backend.exists(path)) throw new Error("hosted typed profiles and product bindings unsupported");
  }
}
