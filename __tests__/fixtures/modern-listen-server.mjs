import readline from "node:readline";

const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";
const lines = readline.createInterface({ input: process.stdin });
let revision = 0;
let listenCount = 0;
let activeListenId;
let lastFilter = {};
let ignoreNextListen = false;
let narrowNextListen = false;
let failNextPrompts = false;
let failNextResources = false;

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function respond(id, result) {
  send({ id, result });
}

function notify(method, params = {}) {
  send({ method, params });
}

function subscriptionMeta() {
  return activeListenId ? { [SUBSCRIPTION_ID_KEY]: activeListenId } : {};
}

function complete(result) {
  return { resultType: "complete", ttlMs: 0, cacheScope: "private", ...result };
}

function emitCatalogChanges() {
  const _meta = subscriptionMeta();
  notify("notifications/tools/list_changed", { _meta });
  notify("notifications/prompts/list_changed", { _meta });
  notify("notifications/resources/list_changed", { _meta });
}

lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.method === "server/discover") {
    respond(message.id, {
      supportedVersions: ["2026-07-28"],
      capabilities: {
        tools: { listChanged: true },
        prompts: { listChanged: true },
        resources: { listChanged: true },
      },
      _meta: {
        "io.modelcontextprotocol/serverInfo": { name: "modern-listen", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "subscriptions/listen") {
    listenCount += 1;
    activeListenId = message.id;
    lastFilter = message.params?.notifications ?? {};
    if (ignoreNextListen) {
      ignoreNextListen = false;
      return;
    }
    const honoredFilter = narrowNextListen ? { toolsListChanged: true } : lastFilter;
    narrowNextListen = false;
    notify("notifications/subscriptions/acknowledged", {
      notifications: honoredFilter,
      _meta: { [SUBSCRIPTION_ID_KEY]: activeListenId },
    });
    return;
  }
  if (message.method === "notifications/cancelled") {
    if (message.params?.requestId === activeListenId) activeListenId = undefined;
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, complete({
      tools: [
        {
          name: "fixture_control",
          description: "Controls the modern listen fixture",
          inputSchema: { type: "object", properties: { action: { type: "string" } } },
        },
        {
          name: revision ? "updated_tool" : "initial_tool",
          description: revision ? "Updated tool" : "Initial tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    }));
    return;
  }
  if (message.method === "prompts/list") {
    if (failNextPrompts) {
      failNextPrompts = false;
      send({ id: message.id, error: { code: -32000, message: "prompts unavailable" } });
      return;
    }
    respond(message.id, complete({
      prompts: [{ name: revision ? "updated_prompt" : "initial_prompt" }],
    }));
    return;
  }
  if (message.method === "resources/list") {
    if (failNextResources) {
      failNextResources = false;
      send({ id: message.id, error: { code: -32000, message: "resources unavailable" } });
      return;
    }
    respond(message.id, complete({
      resources: [{
        uri: revision ? "ui://fixture/updated" : "ui://fixture/initial",
        name: revision ? "Updated resource" : "Initial resource",
        mimeType: "text/html",
      }],
    }));
    return;
  }
  if (message.method === "resources/read") {
    respond(message.id, { resultType: "complete", ttlMs: 60_000, cacheScope: "private",
      contents: [{ uri: message.params.uri, mimeType: "text/html", text: `<p>revision ${revision}</p>` }],
    });
    return;
  }
  if (message.method === "tools/call") {
    const action = message.params?.arguments?.action;
    const report = JSON.stringify({ listenCount, filter: lastFilter });
    respond(message.id, complete({ content: [{ type: "text", text: report }] }));
    if (action === "mutate") {
      revision += 1;
      setTimeout(emitCatalogChanges, 5);
    } else if (action === "mutate-silent") {
      revision += 1;
    } else if (action === "fail-next-optional-lists") {
      failNextPrompts = true;
      failNextResources = true;
    } else if ((action === "drop" || action === "drop-ignore-next") && activeListenId) {
      if (action === "drop-ignore-next") ignoreNextListen = true;
      const requestId = activeListenId;
      setTimeout(() => notify("notifications/cancelled", { requestId }), 5);
    } else if (action === "graceful" && activeListenId) {
      const requestId = activeListenId;
      activeListenId = undefined;
      setTimeout(() => respond(requestId, {}), 5);
    } else if (action === "resource-updated") {
      setTimeout(() => notify("notifications/resources/updated", {
        uri: "ui://fixture/initial",
        _meta: subscriptionMeta(),
      }), 5);
    } else if (action === "narrow-next-listen") {
      narrowNextListen = true;
    }
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
