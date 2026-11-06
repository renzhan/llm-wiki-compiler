/**
 * @file test/hosted/hosted.test.ts
 * @description Hosted contract witnesses run real native ingestion, parsing,
 * journal gates and trust publication over async storage without credentials.
 */
import { describe, expect, it } from "vitest";
import { createHostedWiki } from "../../src/hosted/index.js";
import { OfflineProvider } from "../../src/providers/offline.js";
import { projectPath, writeText } from "../../src/hosted/storage.js";
import { projectMutations } from "../../src/hosted/mutations.js";
import { emitCandidate } from "../../src/hosted/candidates.js";
import { semanticPage } from "../../src/hosted/pages.js";
import { MemoryBackend } from "./backend.js";

function setup() {
  const backend = new MemoryBackend();
  const wiki = createHostedWiki({backend, semantic: {exclude: async () => {}, submit: async () => {}, search: async () => []},
    provider: {provider: new OfflineProvider(), providerName: "offline", modelId: "test"}});
  return {backend, wiki};
}

async function proposal() {
  const {backend, wiki} = setup();
  await wiki.ingestText({title: "Seed", text: "Seed document contents for hosted storage contract tests."});
  const candidate = await backend.withMutation(() => emitCandidate(backend, {
    slug: "remote", title: "Remote", sources: [], summary: "Remote storage", body: "---\ntitle: Remote\n---\n# Remote\nEvidence.",
  }));
  const preview = await wiki.readCandidate(candidate.id);
  return {backend, wiki, candidate, preview};
}

describe("hosted v1.5.0 storage contract", () => {
  it("ingests stable source identity and compiles without a project directory", async () => {
    const {backend, wiki} = setup();
    const input = {title: "Remote storage", text: "A network filesystem stores authoritative Markdown and compilation state.", source: "urn:test:source"};
    await wiki.ingestText(input);
    const paths = [...backend.files.keys()].filter(name => name.startsWith("sources/"));
    await wiki.ingestText({...input, text: `${input.text} Updated evidence.`});
    expect([...backend.files.keys()].filter(name => name.startsWith("sources/"))).toEqual(paths);
    const result = await wiki.compile();
    expect(result.errors).toEqual(["No concepts extracted from remote-storage.md"]);
    expect(await backend.exists(".llmwiki/state.json")).toBe(true);
    expect(await backend.exists(".llmwiki/embeddings.json")).toBe(false);
  });

  it("rejects traversal and journal targets outside wiki", async () => {
    const {backend} = setup();
    for (const name of ["../wiki", "//wiki", "wiki/../memory", "wiki\\escape"]) {
      expect(() => projectPath(name)).toThrow();
    }
    await expect(projectMutations(backend).journal.confineTarget("/memory/private.md", "/")).rejects.toThrow();
  });

  it("binds native embedding text and chunks to the exact file version", async () => {
    const {backend, wiki} = setup();
    await wiki.ingestText({title: "Seed", text: "Seed document contents for hosted storage contract tests."});
    await backend.withMutation(() => writeText(backend, "wiki/concepts/remote.md", "---\ntitle: Remote\nsummary: Network storage\n---\n# Remote\nBody evidence."));
    const page = await semanticPage(backend, "concepts/remote");
    expect(page?.embeddingText).toContain("Network storage");
    expect(page?.embeddingText).not.toContain("Body evidence");
    expect(page?.chunks.length).toBeGreaterThan(0);
    expect(page?.sourceVersion).toBe((await backend.read("wiki/concepts/remote.md")).version);
  });

  it("rejects changed previews and archives rejected native candidates", async () => {
    const {backend, wiki, candidate, preview} = await proposal();
    await expect(wiki.reject(candidate.id, "wrong-hash")).rejects.toThrow("refresh");
    await wiki.reject(candidate.id, preview!.hash);
    await wiki.reject(candidate.id, preview!.hash);
    await expect(wiki.reject(candidate.id, "changed")).rejects.toThrow("refresh");
    expect(await wiki.listCandidates()).toEqual([]);
    expect(await backend.exists(`.llmwiki/candidates/archive/${candidate.id}.json`)).toBe(true);
  });

  it("publishes approved bytes through the native journal and planner", async () => {
    const {backend, wiki} = setup();
    await wiki.ingestText({title: "Seed", text: "Seed document contents for hosted storage contract tests."});
    const body = "---\ntitle: Remote\nsummary: Network storage\nsources: []\n---\n# Remote\nEvidence.";
    const candidate = await backend.withMutation(() => emitCandidate(backend, {slug: "remote", title: "Remote", sources: [], summary: "Remote storage", body}));
    const preview = await wiki.readCandidate(candidate.id);
    await wiki.approve(candidate.id, preview!.hash);
    expect(new TextDecoder().decode((await backend.read("wiki/concepts/remote.md")).bytes)).toBe(body);
    expect(await wiki.listCandidates()).toEqual([]);
    expect(await backend.exists("wiki/index.md")).toBe(true);
  });

  it("resumes an approval tail after semantic failure and gates other writes", async () => {
    const {backend, candidate, preview} = await proposal();
    let unavailable = true;
    const wiki = createHostedWiki({backend, semantic: {
      exclude: async () => {},
      submit: async () => {if (unavailable) throw new Error("index unavailable");},
      search: async () => [],
    }, provider: {provider: new OfflineProvider(), providerName: "offline", modelId: "test"}});
    await expect(wiki.approve(candidate.id, preview!.hash)).rejects.toThrow("index unavailable");
    expect(await backend.exists("wiki/concepts/remote.md")).toBe(true);
    await expect(wiki.compile()).rejects.toThrow("approval recovery required");
    await expect(wiki.reject(candidate.id, preview!.hash)).rejects.toThrow("approval recovery required");
    await expect(wiki.approve(candidate.id, "different")).rejects.toThrow("approval recovery required");
    unavailable = false;
    await wiki.approve(candidate.id, preview!.hash);
    expect(await backend.exists(".llmwiki/approval-recovery.json")).toBe(false);
    expect(await wiki.listCandidates()).toEqual([]);
  });

  it("refuses stale target approval without changing process exit status", async () => {
    const {backend, wiki, candidate, preview} = await proposal();
    await backend.withMutation(() => writeText(backend, "wiki/concepts/remote.md", "newer content"));
    const exitCode = process.exitCode;
    await expect(wiki.approve(candidate.id, preview!.hash)).rejects.toThrow("target changed");
    expect(process.exitCode).toBe(exitCode);
    expect(await wiki.listCandidates()).toHaveLength(1);
  });
});

it("operator edit and delete use native journal publication", async () => {
  const {backend, wiki} = setup();
  await wiki.ingestText({title: "Seed", text: "Seed document contents for hosted storage contract tests."});
  const body = "---\ntitle: Operator\nsummary: Manual page\nsources: []\n---\n# Operator\nManual evidence.";
  await wiki.editPage("concepts/operator", body);
  expect(new TextDecoder().decode((await backend.read("wiki/concepts/operator.md")).bytes)).toBe(body);
  expect(await wiki.deletePage("concepts/operator")).toBe(true);
  expect(await backend.exists("wiki/concepts/operator.md")).toBe(false);
  expect(await wiki.deletePage("concepts/operator")).toBe(false);
});
