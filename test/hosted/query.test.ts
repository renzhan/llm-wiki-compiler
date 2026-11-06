/**
 * @file test/hosted/query.test.ts
 * @description Remote semantic evidence must match native current manifests.
 */
import { expect, it } from "vitest";
import { createHostedWiki } from "../../src/hosted/index.js";
import { OfflineProvider } from "../../src/providers/offline.js";
import { semanticPage } from "../../src/hosted/pages.js";
import { MemoryBackend } from "./backend.js";
import type { SemanticMatch } from "../../src/hosted/types.js";

it("answers through native hydration and excludes an explicitly empty page scope", async () => {
  const backend = new MemoryBackend();
  let matches: SemanticMatch[] = [];
  const wiki = createHostedWiki({backend, provider: {provider: new OfflineProvider(), providerName: "offline", modelId: "test"},
    semantic: {submit: async () => {}, exclude: async () => {}, search: async () => matches}});
  await wiki.editPage("concepts/remote", "---\ntitle: Remote\nsummary: Network storage\nsources: []\n---\n# Remote\nCurrent evidence.");
  const page = (await semanticPage(backend, "concepts/remote"))!;
  matches = [{pageId: page.pageId, kind: "page", nodeId: page.nodeId, sourceVersion: page.sourceVersion,
    sourceEtag: page.sourceEtag, score: 0.9, title: page.title}];
  const answer = await wiki.query("What evidence exists?");
  expect(answer.pageIds).toEqual(["concepts/remote"]);
  expect(answer.answer).toContain("Current evidence");
  const scoped = await wiki.query("What evidence exists?", []);
  expect(scoped.pageIds).toEqual([]);
});
