/**
 * Semantic concept retrieval for extraction-phase deduplication context.
 *
 * Instead of injecting the full `wiki/index.md` (which grows unboundedly with
 * the wiki and can exceed model context limits), this module retrieves only the
 * semantically relevant concepts for a given source document:
 *
 *   1. Embed the source content (truncated to ~8KB for cost efficiency)
 *   2. Retrieve Top-K similar existing concepts from the embedding store
 *   3. Format as a compact list for the extraction prompt
 *
 * Falls back to a truncated index.md when no embedding store exists (cold start)
 * or when embedding fails (graceful degradation).
 *
 * Budget: the returned context is capped at {@link MAX_CONTEXT_CHARS} (~20KB)
 * to leave room for the source content and system prompt.
 */

import { getEmbeddingProvider } from "../utils/embedding-provider.js";
import {
  readEmbeddingStore,
  storeMatchesActiveEmbedding,
  type EmbeddingStore,
  type EmbeddingEntry,
} from "../utils/embeddings-store.js";
import { cosineSimilarity } from "../utils/embeddings-search.js";
import * as output from "../utils/output.js";

/** Maximum characters of source content to embed (cost/latency tradeoff). */
const SOURCE_EMBED_BUDGET = 8_000;

/** Maximum number of similar concepts to retrieve. */
const TOP_K_CONCEPTS = 50;

/** Minimum similarity threshold to include a concept (filters noise). */
const MIN_SIMILARITY = 0.3;

/** Maximum characters in the returned context (leave room for source + prompt). */
const MAX_CONTEXT_CHARS = 20_000;

/**
 * Threshold for using full index directly. Below this size, semantic filtering
 * adds latency/cost without meaningful benefit. ~15KB accommodates ~150 concepts
 * with typical title+summary lengths.
 */
const FULL_INDEX_THRESHOLD = 15_000;

/**
 * Build concept context for extraction deduplication.
 *
 * Strategy:
 *   1. If full index is small enough (< 15KB), use it directly — no filtering needed
 *   2. If index is large, use semantic retrieval to pick relevant concepts
 *   3. If semantic retrieval unavailable, truncate the index
 *
 * @param root - Project root directory.
 * @param sourceContent - The source document being processed.
 * @param fallbackIndex - The full wiki/index.md content.
 * @returns A string listing existing concepts for deduplication context.
 */
export async function buildRelevantConceptContext(
  root: string,
  sourceContent: string,
  fallbackIndex: string,
): Promise<string> {
  // Small index: use directly without filtering
  if (fallbackIndex.length <= FULL_INDEX_THRESHOLD) {
    output.verbose(`Index size ${fallbackIndex.length} chars is below threshold; using full index`);
    return fallbackIndex;
  }

  // Large index: try semantic retrieval
  output.verbose(`Index size ${fallbackIndex.length} chars exceeds threshold; attempting semantic filtering`);
  const semanticContext = await trySemanticRetrieval(root, sourceContent);
  if (semanticContext !== null) {
    return semanticContext;
  }

  // Fallback: truncate the full index
  return truncateFallbackIndex(fallbackIndex);
}

/**
 * Attempt semantic retrieval of relevant concepts.
 * Returns null if embedding store unavailable or embedding fails.
 */
async function trySemanticRetrieval(
  root: string,
  sourceContent: string,
): Promise<string | null> {
  // Load embedding store
  const store = await loadActiveStore(root);
  if (!store || store.entries.length === 0) {
    output.verbose("No embedding store available; falling back to index truncation");
    return null;
  }

  // Embed the source content (truncated for efficiency)
  const sourceText = sourceContent.slice(0, SOURCE_EMBED_BUDGET);
  let queryVector: number[];
  try {
    queryVector = await getEmbeddingProvider().embed(sourceText, "document");
  } catch (err) {
    output.verbose(`Embedding failed: ${err instanceof Error ? err.message : err}; falling back to index truncation`);
    return null;
  }

  // Validate vector dimensions match store
  if (queryVector.length !== store.dimensions) {
    output.verbose(`Vector dimension mismatch (got ${queryVector.length}, store has ${store.dimensions}); falling back`);
    return null;
  }

  // Find top-K similar concepts
  const scored = store.entries.map((entry) => ({
    entry,
    score: cosineSimilarity(queryVector, entry.vector),
  }));
  scored.sort((a, b) => b.score - a.score);

  const relevant = scored
    .filter((item) => item.score >= MIN_SIMILARITY)
    .slice(0, TOP_K_CONCEPTS);

  if (relevant.length === 0) {
    output.verbose("No semantically similar concepts found");
    return "";
  }

  // Format as compact context
  output.verbose(`Found ${relevant.length} semantically similar concepts for dedup context`);
  return formatConceptContext(relevant.map((r) => r.entry));
}

/**
 * Format concept entries into a compact context string.
 * Each concept is rendered as: `- **Title** — Summary`
 */
function formatConceptContext(entries: EmbeddingEntry[]): string {
  const lines: string[] = [];
  let totalChars = 0;

  for (const entry of entries) {
    const line = `- **${entry.title}** — ${entry.summary}`;
    if (totalChars + line.length > MAX_CONTEXT_CHARS) {
      break; // Stop if we'd exceed budget
    }
    lines.push(line);
    totalChars += line.length + 1; // +1 for newline
  }

  if (lines.length === 0) return "";

  return [
    `Existing wiki concepts (${lines.length} most relevant):`,
    "",
    ...lines,
  ].join("\n");
}

/**
 * Truncate the full index.md as a fallback when semantic retrieval unavailable.
 * Truncates at a line boundary to avoid cutting mid-concept.
 */
function truncateFallbackIndex(fullIndex: string): string {
  if (fullIndex.length <= FULL_INDEX_THRESHOLD) {
    return fullIndex;
  }

  // Truncate at line boundary
  const truncated = fullIndex.slice(0, FULL_INDEX_THRESHOLD);
  const lastNewline = truncated.lastIndexOf("\n");
  const cleanTruncated = lastNewline > 0 ? truncated.slice(0, lastNewline) : truncated;

  output.verbose(`Index truncated from ${fullIndex.length} to ${cleanTruncated.length} chars`);

  return cleanTruncated + "\n\n_(truncated — full wiki has more concepts)_";
}

/**
 * Load embedding store if available and compatible with current config.
 */
async function loadActiveStore(root: string): Promise<EmbeddingStore | null> {
  try {
    const store = await readEmbeddingStore(root);
    if (!store) return null;

    // Check if store was built with compatible embedding config
    if (!storeMatchesActiveEmbedding(store as unknown as Record<string, unknown>)) {
      output.verbose("Embedding store built with different config; skipping semantic retrieval");
      return null;
    }

    return store;
  } catch {
    return null;
  }
}
