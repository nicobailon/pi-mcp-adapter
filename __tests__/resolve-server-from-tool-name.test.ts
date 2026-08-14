import { describe, expect, it } from "vitest";
import {
	resolveServerFromToolName,
	getServerPrefix,
	formatPromptCommandName,
	formatToolName,
	createToolSelectorCandidateIndex,
	getToolNameCandidates,
	isToolExcluded,
	isToolAllowed,
	matchesToolPattern,
} from "../types.ts";

describe("resolveServerFromToolName", () => {
	describe("server prefix mode (default)", () => {
		it("resolves a fully-qualified tool name back to its server", () => {
			expect(
				resolveServerFromToolName(
					"searxng_searxng_web_search",
					["searxng"],
					"server",
				),
			).toBe("searxng");
		});

		it("round-trips formatToolName -> resolveServerFromToolName", () => {
			const tool = formatToolName("web_search", "searxng", "server");
			expect(resolveServerFromToolName(tool, ["searxng"], "server")).toBe(
				"searxng",
			);
		});

		it("round-trips server names with spaces", () => {
			const tool = formatToolName("web_search", "my server", "server");
			expect(tool).toBe("my_20_server_web_search");
			expect(resolveServerFromToolName(tool, ["my server"], "server")).toBe(
				"my server",
			);
		});

		it("keeps colliding sanitized server names distinct across mappings", () => {
			const spacedTool = formatToolName("search", "my server", "server");
			const underscoredTool = formatToolName("search", "my_server", "server");

			expect(spacedTool).toBe("my_20_server_search");
			expect(underscoredTool).toBe("my_server_search");
			expect(new Set([spacedTool, underscoredTool]).size).toBe(2);
			expect(resolveServerFromToolName(spacedTool, ["my server", "my_server"], "server")).toBe("my server");
			expect(resolveServerFromToolName(underscoredTool, ["my server", "my_server"], "server")).toBe("my_server");
			expect(formatPromptCommandName("plan", "my server", "server")).toBe("mcp__my_20_server__plan");
			expect(formatPromptCommandName("plan", "my_server", "server")).toBe("mcp__my_server__plan");
			expect(getToolNameCandidates("search", "my server", "server")).toContain(spacedTool);
			expect(getToolNameCandidates("search", "my_server", "server")).toContain(underscoredTool);
		});

		it("resolves when multiple servers are configured and only one prefix matches", () => {
			expect(
				resolveServerFromToolName(
					"github_create_issue",
					["searxng", "github"],
					"server",
				),
			).toBe("github");
		});

		it("picks the longest matching prefix when server names share a stem", () => {
			const tool = "searxng-extra_deep_search";
			expect(
				resolveServerFromToolName(tool, ["searxng", "searxng-extra"], "server"),
			).toBe("searxng-extra");
		});
	});

	describe("short prefix mode", () => {
		it("strips the -?mcp suffix when resolving", () => {
			// "filesystem-mcp" -> short prefix "filesystem" -> "filesystem_read_file"
			expect(
				resolveServerFromToolName(
					"filesystem_read_file",
					["filesystem-mcp"],
					"short",
				),
			).toBe("filesystem-mcp");
		});

		it("falls back to mcp when the server name is only -mcp", () => {
			expect(resolveServerFromToolName("mcp_query", ["-mcp"], "short")).toBe(
				"-mcp",
			);
		});

		it("fails safe when suffix removal creates an ambiguous prefix", () => {
			expect(resolveServerFromToolName("foo_query", ["foo", "foo-mcp"], "short")).toBeUndefined();
		});
	});

	describe("mcp prefix mode", () => {
		it("resolves the mcp__namespaced format", () => {
			expect(
				resolveServerFromToolName("mcp__my-server_run", ["my-server"], "mcp"),
			).toBe("my-server");
		});
	});

	describe("none prefix mode", () => {
		it("always returns undefined (no prefix is stamped)", () => {
			expect(
				resolveServerFromToolName("searxng_web_search", ["searxng"], "none"),
			).toBeUndefined();
		});

		it("is consistent with getServerPrefix returning empty", () => {
			expect(getServerPrefix("searxng", "none")).toBe("");
		});
	});

	describe("no match", () => {
		it("returns undefined when no configured server prefix matches", () => {
			expect(
				resolveServerFromToolName(
					"unknown_tool",
					["searxng", "github"],
					"server",
				),
			).toBeUndefined();
		});

		it("returns undefined for a bare tool name with no server prefix in server mode", () => {
			expect(
				resolveServerFromToolName("web_search", ["searxng"], "server"),
			).toBeUndefined();
		});

		it("returns undefined for an empty server list", () => {
			expect(
				resolveServerFromToolName("searxng_web_search", [], "server"),
			).toBeUndefined();
		});
	});

	describe("edge cases", () => {
		it("accepts a Set of server names, not only an array", () => {
			expect(
				resolveServerFromToolName(
					"searxng_search",
					new Set(["searxng"]),
					"server",
				),
			).toBe("searxng");
		});

		it("treats tool names containing a matching substring but not the full prefix as non-matches", () => {
			// "notsearxng_search" does NOT start with "searxng_"
			expect(
				resolveServerFromToolName("notsearxng_search", ["searxng"], "server"),
			).toBeUndefined();
		});

		it("requires the trailing underscore after the prefix", () => {
			// "searxngweb_search" has no underscore boundary
			expect(
				resolveServerFromToolName("searxngweb_search", ["searxng"], "server"),
			).toBeUndefined();
		});

		it("honours per-server toolPrefix overrides cannot be resolved here (global mode only)", () => {
			// resolveServerFromToolName operates on the global prefix mode; per-server
			// overrides are not visible to a downstream gate that only sees the tool
			// name and the global mode. This documents that boundary: a server using
			// the "none" override would expose un-prefixed tool names that this
			// helper (called with the global "server" mode) would not resolve.
			const tool = "web_search"; // server "noisy" uses toolPrefix: "none"
			expect(
				resolveServerFromToolName(tool, ["noisy", "searxng"], "server"),
			).toBeUndefined();
		});
	});
});

describe("direct tool selector candidates", () => {
	it("keeps hyphen and underscore prefixes distinct while matching legacy escaped prefixes", () => {
		const hyphenCandidates = getToolNameCandidates("do_thing", "my-server", "server");
		const underscoreCandidates = getToolNameCandidates("do_thing", "my_server", "server");

		expect(matchesToolPattern(hyphenCandidates, ["my-server_do_thing"])).toBe(true);
		expect(matchesToolPattern(hyphenCandidates, ["my_server_do_thing"])).toBe(true);
		expect(matchesToolPattern(underscoreCandidates, ["my-server_do_thing"])).toBe(false);
		expect(matchesToolPattern(hyphenCandidates, ["my_2d_server_do_thing"])).toBe(true);
	});

	it("matches normalized legacy emitted selectors when they are safe", () => {
		expect(isToolExcluded("do_thing", "my-server", "server", ["my_server_do_thing"], new Set())).toBe(true);
		expect(isToolAllowed("do_thing", "my-server", "server", undefined, ["my_server_do_thing"], new Set())).toBe(false);
		expect(isToolExcluded("do_thing", "my-server", "server", ["my_2d_server_do_thing"], new Set())).toBe(true);
		expect(isToolExcluded("do_thing", "my-server", "server", ["my-server_do_thing"], new Set())).toBe(true);
	});

	it("does not apply normalized legacy emitted selectors through indexed exact collisions", () => {
		const emptyIndex = createToolSelectorCandidateIndex(new Set());
		const collisionIndex = createToolSelectorCandidateIndex(new Set(["my_server_do_thing"]));

		expect(isToolExcluded("do-thing", "my-server", "server", ["my_server_do_thing"], emptyIndex)).toBe(true);
		expect(isToolExcluded("do-thing", "my-server", "server", ["my_server_do_thing"], collisionIndex)).toBe(false);
	});

	it("skips indexed collision work when excludes are empty", () => {
		const index = createToolSelectorCandidateIndex(new Set(["my_server_do_other"]));

		expect(isToolExcluded("do-thing", "my-server", "server", undefined, index)).toBe(false);
		expect(isToolExcluded("do-thing", "my-server", "server", [], index)).toBe(false);
		expect(index.matchingCountByPattern.size).toBe(0);
		expect(index.matcherByPattern.size).toBe(0);
	});

	it("caches indexed glob collision counts and matchers", () => {
		const index = createToolSelectorCandidateIndex(new Set(["my_server_do_other", "unrelated"]));

		expect(isToolExcluded("do-thing", "my-server", "server", ["my_server_do_*"], index)).toBe(false);
		expect(isToolExcluded("do-thing", "my-server", "server", ["my_server_do_*"], index)).toBe(false);
		expect(index.matchingCountByPattern).toEqual(new Map([["my_server_do_*", 1]]));
		expect(index.matcherByPattern.size).toBe(1);

		const currentOnlyIndex = createToolSelectorCandidateIndex(
			getToolNameCandidates("do-thing", "my-server", "server", false),
		);
		expect(isToolExcluded("do-thing", "my-server", "server", ["my_server_do_*"], currentOnlyIndex)).toBe(true);
		expect(currentOnlyIndex.matcherByPattern.size).toBe(1);
	});
});

describe("distinct normalized server prefixes", () => {
	it("resolves distinct space and hyphen prefixes", () => {
		expect(
			resolveServerFromToolName("a_20_b_run", ["a b", "a-20-b"], "server"),
		).toBe("a b");
		expect(
			resolveServerFromToolName("a-20-b_run", ["a b", "a-20-b"], "server"),
		).toBe("a-20-b");
	});

	it("resolves distinct hyphen and underscore prefixes under mcp mode", () => {
		expect(
			resolveServerFromToolName("mcp__my-server_run", ["my-server", "my_server"], "mcp"),
		).toBe("my-server");
		expect(
			resolveServerFromToolName("mcp__my_server_run", ["my-server", "my_server"], "mcp"),
		).toBe("my_server");
	});
});
