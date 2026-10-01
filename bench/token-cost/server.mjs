// Local MCP test servers for bench/token-cost/run.mjs: `node server.mjs tracker|notes`.
// Results are JSON in text (tracker) or prose (notes), with no outputSchema, like most
// real servers. Every call and write is appended to the JSON-lines file in BENCH_LOG,
// which the runner reads to check write tasks.
import { appendFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { data } from "./data.mjs";

const kind = process.argv[2];
if (kind !== "tracker" && kind !== "notes") throw new Error("usage: node server.mjs tracker|notes");
if (!process.env.BENCH_LOG) throw new Error("BENCH_LOG must name the call log file");
const log = (entry) => appendFileSync(process.env.BENCH_LOG, JSON.stringify(entry) + "\n");
const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });
const err = (message) => ({ content: [{ type: "text", text: message }], isError: true });
const obj = (properties, required = []) => ({ type: "object", properties, required });

const trackerTools = [
  { name: "list_issues", description: "List issues in the repository. Results are paginated; request further pages until fewer than per_page items are returned.",
    inputSchema: obj({ state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open" }, labels: { type: "string", description: "Comma-separated label names; issues must have all of them" }, page: { type: "integer", description: "Default: 1" }, per_page: { type: "integer", description: "Default: 30, max: 100" } }) },
  { name: "get_issue", description: "Get one issue by number.", inputSchema: obj({ number: { type: "integer" } }, ["number"]) },
  { name: "list_pulls", description: "List pull requests. Paginated like list_issues.",
    inputSchema: obj({ state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open. Merged PRs are closed with merged=true." }, page: { type: "integer" }, per_page: { type: "integer", description: "Default: 30, max: 100" } }) },
  { name: "get_pull", description: "Get one pull request by number.", inputSchema: obj({ number: { type: "integer" } }, ["number"]) },
  { name: "list_labels", description: "List repository labels.", inputSchema: obj({}) },
  { name: "add_comment", description: "Add a comment to an issue.", inputSchema: obj({ number: { type: "integer" }, body: { type: "string" } }, ["number", "body"]) },
  { name: "add_label", description: "Add a label to an issue.", inputSchema: obj({ number: { type: "integer" }, label: { type: "string" } }, ["number", "label"]) },
  { name: "close_issue", description: "Close an issue, optionally posting a comment first.", inputSchema: obj({ number: { type: "integer" }, comment: { type: "string" } }, ["number"]) },
];

const notesTools = [
  { name: "search_docs", description: "Search product documentation. Returns matching sections as markdown.", inputSchema: obj({ query: { type: "string" } }, ["query"]) },
  { name: "list_transcripts", description: "List meeting transcripts.", inputSchema: obj({}) },
  { name: "get_transcript", description: "Get a meeting transcript as plain text.", inputSchema: obj({ id: { type: "string" } }, ["id"]) },
  { name: "create_note", description: "Create a note.", inputSchema: obj({ title: { type: "string" }, body: { type: "string" } }, ["title", "body"]) },
];

function page(items, args) {
  const perPage = Math.min(Math.max(args.per_page ?? 30, 1), 100);
  const pageNo = Math.max(args.page ?? 1, 1);
  return items.slice((pageNo - 1) * perPage, pageNo * perPage);
}

function tracker(name, args) {
  switch (name) {
    case "list_issues": {
      const state = args.state ?? "open";
      const labels = (args.labels ?? "").split(",").map((l) => l.trim()).filter(Boolean);
      const items = data.issues.filter((i) => (state === "all" || i.state === state) && labels.every((l) => i.labels.some((x) => x.name === l)));
      return text(page(items, args));
    }
    case "get_issue": {
      const issue = data.issues.find((i) => i.number === args.number);
      return issue ? text(issue) : err(`Issue #${args.number} not found`);
    }
    case "list_pulls": {
      const state = args.state ?? "open";
      return text(page(data.pulls.filter((p) => state === "all" || p.state === state), args));
    }
    case "get_pull": {
      const pull = data.pulls.find((p) => p.number === args.number);
      return pull ? text(pull) : err(`PR #${args.number} not found`);
    }
    case "list_labels": return text(data.labels);
    case "add_comment": log({ op: "comment", number: args.number, body: args.body }); return text({ id: Date.now(), body: args.body });
    case "add_label": log({ op: "label", number: args.number, label: args.label }); return text({ ok: true });
    case "close_issue": {
      const issue = data.issues.find((i) => i.number === args.number);
      if (!issue) return err(`Issue #${args.number} not found`);
      if (args.comment) log({ op: "comment", number: args.number, body: args.comment });
      log({ op: "close", number: args.number });
      issue.state = "closed";
      return text({ ...issue, state: "closed", closed_at: "2026-09-29T12:00:00Z" });
    }
  }
  return err(`Unknown tool ${name}`);
}

function notes(name, args) {
  switch (name) {
    case "search_docs": return text(data.docs(args.query ?? ""));
    case "list_transcripts": return text(data.transcripts.map(({ id, title, date }) => ({ id, title, date })));
    case "get_transcript": {
      const t = data.transcripts.find((x) => x.id === args.id);
      return t ? text(t.text) : err(`Transcript ${args.id} not found`);
    }
    case "create_note": log({ op: "note", title: args.title, body: args.body }); return text({ id: "note_" + Date.now(), title: args.title });
  }
  return err(`Unknown tool ${name}`);
}

const server = new Server({ name: `bench-${kind}`, version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: kind === "tracker" ? trackerTools : notesTools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  log({ op: "call", tool: name, args });
  return kind === "tracker" ? tracker(name, args) : notes(name, args);
});
await server.connect(new StdioServerTransport());
