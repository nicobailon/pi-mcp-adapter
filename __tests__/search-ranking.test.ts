import { describe, expect, it } from "vitest";
import { paginate, rankToolMatches, resolveSearchKeywords, scoreToolMatch } from "../search-ranking.ts";
import type { McpExtensionState } from "../state.ts";
import type { ServerEntry, ToolMetadata } from "../types.ts";

const tool = (name: string, description: string) => ({
  name,
  originalName: name,
  description,
});

describe("search ranking", () => {
  it("ranks an exact name above a description match", () => {
    const exact = scoreToolMatch(tool("search_records", "Find records"), "demo", "search")!;
    const description = scoreToolMatch(tool("find_records", "Search records"), "demo", "search")!;

    expect(exact).toBeGreaterThan(description);
  });

  it("drops partial two-token matches", () => {
    expect(scoreToolMatch(tool("search_records", "Find records"), "demo", "search missing")).toBeNull();
  });

  it("ignores single-letter possessive tokens instead of stem-matching them", () => {
    // "project's" tokenizes to ["project", "s"]; a bare "s" must not match "simulator".
    expect(scoreToolMatch(tool("sync_icon", "Add an icon to your project's icons file."), "better-icons", "simulator")).toBeNull();
    // Real stems still match: "sync" (4+ chars) may prefix-match "synchronize".
    expect(scoreToolMatch(tool("sync_icon", "Sync an icon."), "better-icons", "synchronize")).not.toBeNull();
  });

  it("matches through configured keywords where the query would otherwise miss", () => {
    const advanced = tool("search_records_advanced", "Advanced record search with filters");

    expect(scoreToolMatch(advanced, "demo", "fuzzy lookup")).toBeNull();
    expect(scoreToolMatch(advanced, "demo", "fuzzy lookup", ["fuzzy lookup", "legacy"])).not.toBeNull();
    // Single-token queries pass the coverage gate through keyword tokens too.
    expect(scoreToolMatch(advanced, "demo", "fuzzy")).toBeNull();
    expect(scoreToolMatch(advanced, "demo", "fuzzy", ["fuzzy lookup"])).not.toBeNull();
  });

  it("ranks an exact keyword alias above a description phrase match", () => {
    const aliased = scoreToolMatch(
      tool("search_records_advanced", "Advanced record search with filters"),
      "demo",
      "fuzzy lookup",
      ["fuzzy lookup"],
    )!;
    const description = scoreToolMatch(tool("record_search", "Fuzzy lookup across records"), "demo", "fuzzy lookup")!;

    expect(aliased).toBeGreaterThan(description);
  });

  it("scores an exact alias above incidental cross-phrase token matches", () => {
    const advanced = tool("search_records_advanced", "Advanced record search with filters");
    const keywords = ["fuzzy lookup", "legacy"];

    // "lookup legacy" spans two phrases; it may token-match but must not get
    // the phrase-level bonus a real alias hit gets.
    const exact = scoreToolMatch(advanced, "demo", "fuzzy lookup", keywords)!;
    const crossPhrase = scoreToolMatch(advanced, "demo", "lookup legacy", keywords)!;
    expect(exact).toBeGreaterThan(crossPhrase);
  });

  it("does not change scoring when the keyword list is empty", () => {
    const advanced = tool("search_records_advanced", "Advanced record search");

    expect(scoreToolMatch(advanced, "demo", "advanced", [])).toEqual(scoreToolMatch(advanced, "demo", "advanced"));
  });

  it("refreshes prepared fields when catalog or keyword references change", () => {
    const state = {
      toolMetadata: new Map([["demo", [tool("search_records", "Find records")]]]),
      config: { mcpServers: { demo: { command: "demo", searchKeywords: { search_records: ["fuzzy"] } } } },
      manager: { getConnection: () => undefined },
      failureTracker: new Map(),
    } as unknown as McpExtensionState;

    expect(rankToolMatches(state, "fuzzy")).toHaveLength(1);
    state.config.mcpServers.demo!.searchKeywords = { search_records: ["semantic"] };
    expect(rankToolMatches(state, "fuzzy")).toHaveLength(0);
    expect(rankToolMatches(state, "semantic")).toHaveLength(1);

    state.toolMetadata.set("demo", [tool("create_record", "Create a record")] as ToolMetadata[]);
    expect(rankToolMatches(state, "search")).toHaveLength(0);
    expect(rankToolMatches(state, "create")).toHaveLength(1);
  });

  it("paginates including offsets beyond the result set", () => {
    expect(paginate(["a", "b", "c"], 1, 1)).toEqual({
      items: ["b"], total: 3, hasMore: true, nextOffset: 2,
    });
    expect(paginate(["a", "b", "c"], 5, 1)).toEqual({
      items: [], total: 3, hasMore: false, nextOffset: null,
    });
  });
});

describe("resolveSearchKeywords", () => {
  const definition = (searchKeywords: unknown): ServerEntry =>
    ({ command: "npx", searchKeywords }) as ServerEntry;

  it("matches keys by original name, prefixed name, and glob", () => {
    expect(resolveSearchKeywords(definition({ search_records_advanced: ["fuzzy lookup"] }), "search_records_advanced", "demo", "server"))
      .toEqual(["fuzzy lookup"]);
    expect(resolveSearchKeywords(definition({ demo_search_records_advanced: ["fuzzy lookup"] }), "search_records_advanced", "demo", "server"))
      .toEqual(["fuzzy lookup"]);
    expect(resolveSearchKeywords(definition({ "search_*": ["records"] }), "search_records_advanced", "demo", "server"))
      .toEqual(["records"]);
    expect(resolveSearchKeywords(definition({ "*": ["records"] }), "anything", "demo", "server"))
      .toEqual(["records"]);
  });

  it("unions and dedupes values from all matching keys", () => {
    const entry = definition({
      "search_*": ["records", "fuzzy lookup"],
      search_records_advanced: ["fuzzy lookup", "legacy"],
    });

    expect(resolveSearchKeywords(entry, "search_records_advanced", "demo", "server"))
      .toEqual(["records", "fuzzy lookup", "legacy"]);
  });

  it("returns nothing for non-matching keys or malformed config", () => {
    expect(resolveSearchKeywords(definition({ other_tool: ["nope"] }), "search_records_advanced", "demo", "server")).toEqual([]);
    expect(resolveSearchKeywords(definition({ search_records_advanced: "not-an-array" }), "search_records_advanced", "demo", "server")).toEqual([]);
    expect(resolveSearchKeywords(definition({ search_records_advanced: ["ok", 42, "  "] }), "search_records_advanced", "demo", "server")).toEqual(["ok"]);
    expect(resolveSearchKeywords(definition(["not", "a", "record"]), "search_records_advanced", "demo", "server")).toEqual([]);
    expect(resolveSearchKeywords(undefined, "search_records_advanced", "demo", "server")).toEqual([]);
  });
});
