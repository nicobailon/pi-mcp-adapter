import { describe, expect, it } from "vitest";
import {
	resolveServerFromToolName,
	getServerPrefix,
	formatToolName,
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
			// "searxng" (prefix "searxng", len 7) vs "searxng-extra" (prefix "searxng_extra", len 13)
			const tool = "searxng_extra_deep_search";
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
	});

	describe("mcp prefix mode", () => {
		it("resolves the mcp__namespaced format", () => {
			// getServerPrefix replaces dashes with underscores: my-server -> mcp__my_server
			expect(
				resolveServerFromToolName("mcp__my_server_run", ["my-server"], "mcp"),
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

describe("ambiguous prefix collisions (fail safe)", () => {
	it("returns undefined when two servers normalize to the same prefix", () => {
		// my-server and my_server both -> my_server under "server" mode
		expect(
			resolveServerFromToolName("my_server_run", ["my-server", "my_server"], "server"),
		).toBe(undefined);
	});

	it("returns undefined regardless of collision order", () => {
		expect(
			resolveServerFromToolName("my_server_run", ["my_server", "my-server"], "server"),
		).toBe(undefined);
	});

	it("does not false-trigger on a single server whose name contains a dash", () => {
		// Only one configured server, no collision: dashes are fine.
		expect(
			resolveServerFromToolName("my_server_run", ["my-server"], "server"),
		).toBe("my-server");
	});

	it("returns undefined when a collision happens under mcp mode too", () => {
		// both -> mcp__my_server
		expect(
			resolveServerFromToolName(
				"mcp__my_server_run",
				["my-server", "my_server"],
				"mcp",
			),
		).toBe(undefined);
	});

	it("still resolves when the colliding servers are unrelated to the call", () => {
		// colliding my-server/my_server exist, but the call targets searxng.
		expect(
			resolveServerFromToolName(
				"searxng_search",
				["my-server", "my_server", "searxng"],
				"server",
			),
		).toBe("searxng");
	});

	it("is deterministic: a collision between only two of many servers still fails safe", () => {
		expect(
			resolveServerFromToolName(
				"my_server_run",
				["searxng", "my-server", "my_server", "github"],
				"server",
			),
		).toBe(undefined);
	});
});
