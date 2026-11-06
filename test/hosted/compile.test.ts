/**
 * @file test/hosted/compile.test.ts
 * @description Native extraction/generation/incrementality over remote ports.
 */
import { expect, it } from "vitest";
import { OfflineProvider } from "../../src/providers/offline.js";
import { createHostedWiki } from "../../src/hosted/index.js";
import { MemoryBackend } from "./backend.js";

it("compiles a generated page and skips unchanged source evidence", async () => {
  const backend = new MemoryBackend();
  const provider = new OfflineProvider();
  provider.toolCall = async () => JSON.stringify({concepts: [{concept: "Remote storage", summary: "Network files",
    is_new: true, confidence: 0.99, provenance_state: "extracted", tags: ["storage"]}]});
  provider.complete = async () => "# Remote storage\n\nNetwork files preserve source evidence with durable version identities.\n\n## Sources\n- [[seed]]";
  const submitted: string[] = [];
  const wiki = createHostedWiki({backend, provider: {provider, providerName: "offline", modelId: "fixture"},
    semantic: {submit: async page => {submitted.push(page.pageId);}, exclude: async () => {}, search: async () => []}});
  const input = {title: "Seed", source: "urn:test:seed", text: "Network files preserve source evidence with durable version identities."};
  const first = await wiki.ingestAndCompile([input]);
  expect(first.compiled.errors).toEqual([]);
  expect(first.compiled.compiled).toBeGreaterThan(0);
  expect(await backend.exists("wiki/concepts/remote-storage.md")).toBe(true);
  expect(submitted).toContain("concepts/remote-storage");
  const second = await wiki.ingestAndCompile([input]);
  expect(second.ingested[0].writeStatus).toBe("unchanged");
  expect(second.compiled.compiled).toBe(0);
});
