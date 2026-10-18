import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { getAgentPath } from "./agent-dir.js";
import { isServerDisabled } from "./types.js";
const APPROVALS_VERSION = 1;
const APPROVALS_FILE = "mcp-project-approvals.json";
const DENY_PROJECT_SERVER = "Don't allow";
const ALLOW_PROJECT_SERVER = "Allow";
// Pi preselects the first option, so a stray Enter denies.
const PROJECT_SERVER_CHOICES = [DENY_PROJECT_SERVER, ALLOW_PROJECT_SERVER];
// Same registry key as config.ts; Symbol.for avoids a runtime import of config.ts.
const MCP_CONFIG_SOURCE_METADATA = Symbol.for("pi-mcp-adapter/config-source-metadata");
export function describeProjectServerBlock(reason) {
    switch (reason) {
        case "untrusted":
            return "blocked by project trust — trust the project to review and approve this server";
        case "approval-required":
            return "blocked: project server approval required — approve it in a trusted interactive session or set user-global settings.projectServers to \"allow\"";
        case "denied":
            return "blocked: project server approval denied — reload in a trusted interactive session to approve it";
    }
}
export function disabledServerReason(blocked, name) {
    const block = blocked?.get(name);
    return block ? describeProjectServerBlock(block.reason) : `disabled. Run /mcp-adapter enable ${name} and /reload to enable it.`;
}
function asLoadedConfig(config) {
    const metadata = config[MCP_CONFIG_SOURCE_METADATA];
    return {
        config,
        projectServers: metadata?.projectServers ?? new Map(),
        projectServerPolicy: metadata?.projectServerPolicy ?? "ask",
    };
}
export function hasProjectServerDefinitions(config) {
    return asLoadedConfig(config).projectServers.size > 0;
}
function canonicalize(value) {
    if (Array.isArray(value))
        return value.map(canonicalize);
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]));
}
export function hashProjectServerDefinition(definition) {
    return createHash("sha256").update(JSON.stringify(canonicalize(definition))).digest("hex");
}
export function canonicalProjectRoot(cwd) {
    try {
        // The native realpath returns the on-disk casing, so `C:\Users\Me` and `c:\users\me` share approvals.
        return realpathSync.native(cwd);
    }
    catch {
        return resolve(cwd);
    }
}
/**
 * Git worktrees share approvals per repository, keyed by the same relative path. A `.git`
 * file counts only when it is a regular file (not a symlink to a real worktree's) and git's
 * admin entry for it links back to it; otherwise a directory could claim another checkout's
 * approvals. Worktrees of a regular checkout use that checkout's path, so its existing
 * approvals still apply. Bare repositories (even one stored as a `.git` folder, whose
 * parent is not a checkout) and `--separate-git-dir` ones get a `git-dir:` key, which no
 * canonical path equals, so an admin entry planted in a checkout's tracked files cannot
 * borrow that checkout's approvals.
 * A `--separate-git-dir` main checkout keeps its own path: git records no link back to it.
 */
function projectApprovalScope(cwd) {
    const root = canonicalProjectRoot(cwd);
    for (let dir = root;; dir = dirname(dir)) {
        const dotGit = join(dir, ".git");
        if (existsSync(dotGit)) {
            const repoScope = linkedWorktreeRepoScope(dotGit);
            return repoScope ? join(repoScope, relative(dir, root)) : root;
        }
        if (dirname(dir) === dir)
            return root;
    }
}
function linkedWorktreeRepoScope(dotGit) {
    try {
        if (!lstatSync(dotGit).isFile())
            return undefined;
        const pointer = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
        if (!pointer)
            return undefined;
        const adminDir = realpathSync.native(resolve(dirname(dotGit), pointer));
        const backLink = readFileSync(join(adminDir, "gitdir"), "utf8").trim();
        if (realpathSync.native(resolve(adminDir, backLink)) !== realpathSync.native(dotGit))
            return undefined;
        const commonDir = dirname(dirname(adminDir));
        const bare = /^\s*bare\s*=\s*(true|yes|on|1)\s*$/im.test(readFileSync(join(commonDir, "config"), "utf8"));
        return basename(commonDir) === ".git" && !bare ? dirname(commonDir) : `git-dir:${commonDir}`;
    }
    catch {
        return undefined;
    }
}
function approvalPath() {
    return getAgentPath(APPROVALS_FILE);
}
function loadApprovals() {
    const path = approvalPath();
    if (!existsSync(path))
        return { version: APPROVALS_VERSION, approvals: [] };
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.version !== APPROVALS_VERSION || !Array.isArray(parsed.approvals))
            throw new Error("invalid format");
        const approvals = parsed.approvals.filter((entry) => !!entry && typeof entry.projectRoot === "string" && typeof entry.serverName === "string"
            && typeof entry.definitionHash === "string" && typeof entry.approvedAt === "string");
        return { version: APPROVALS_VERSION, approvals };
    }
    catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.warn(`MCP: ignoring invalid project-server approval store ${path}: ${detail}`);
        return { version: APPROVALS_VERSION, approvals: [] };
    }
}
function saveApproval(record) {
    const path = approvalPath();
    const store = loadApprovals();
    store.approvals = store.approvals.filter(entry => entry.projectRoot !== record.projectRoot || entry.serverName !== record.serverName);
    store.approvals.push(record);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    if (process.platform !== "win32")
        chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    if (process.platform !== "win32")
        chmodSync(path, 0o600);
}
export function approveProjectServer(cwd, serverName, definition) {
    saveApproval({
        projectRoot: projectApprovalScope(cwd),
        serverName,
        definitionHash: hashProjectServerDefinition(definition),
        approvedAt: new Date().toISOString(),
    });
}
function isApproved(approvals, projectRoot, serverName, definition) {
    const definitionHash = hashProjectServerDefinition(definition);
    return approvals.approvals.some(entry => entry.projectRoot === projectRoot && entry.serverName === serverName && entry.definitionHash === definitionHash);
}
function isProjectTrusted(ctx) {
    try {
        return ctx.isProjectTrusted();
    }
    catch {
        return false;
    }
}
/**
 * After the adapter edits config on the user's behalf (a panel save), re-approve each named project
 * server whose pre-edit definition was approved, so the edit does not revoke the approval. Only a
 * `directTools` change carries the approval over; any other difference, such as a concurrent edit to
 * the file, still needs a new approval. A server without a matching approval stays unapproved: an
 * adapter edit never creates one.
 */
export function keepProjectServerApprovals(ctx, before, after, serverNames) {
    if (!isProjectTrusted(ctx))
        return;
    const projectServers = asLoadedConfig(after).projectServers;
    const projectRoot = projectApprovalScope(ctx.cwd);
    const approvals = loadApprovals();
    for (const name of serverNames) {
        const previous = before.mcpServers[name];
        const next = after.mcpServers[name];
        if (!previous || !next || !projectServers.has(name))
            continue;
        if (!isApproved(approvals, projectRoot, name, previous))
            continue;
        const { directTools: _previousDirectTools, ...previousRest } = previous;
        const { directTools: _nextDirectTools, ...nextRest } = next;
        if (hashProjectServerDefinition(previousRest) !== hashProjectServerDefinition(nextRest))
            continue;
        approveProjectServer(ctx.cwd, name, next);
    }
}
function describeServer(definition) {
    if (definition.command) {
        return [definition.command, ...(definition.args ?? [])].map(value => JSON.stringify(value)).join(" ");
    }
    if (definition.url)
        return definition.url;
    if (definition.socket)
        return definition.socket;
    return "(no command or endpoint)";
}
export async function applyProjectServerTrust(loaded, ctx, options = {}) {
    const config = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
    const blockedServers = new Map();
    if (loaded.projectServers.size === 0)
        return { config, blockedServers };
    const projectTrusted = isProjectTrusted(ctx);
    // RPC sessions also have a UI, but Pi reads RPC input only after session_start, so a dialog here never resolves.
    const interactive = ctx.hasUI && ctx.mode === "tui";
    const allowUnapproved = options.allowUnapproved === true || (!interactive && loaded.projectServerPolicy === "allow");
    const projectRoot = projectApprovalScope(ctx.cwd);
    const approvals = loadApprovals();
    for (const [name, source] of loaded.projectServers) {
        const definition = config.mcpServers[name];
        if (!definition || isServerDisabled(definition))
            continue;
        const approved = isApproved(approvals, projectRoot, name, definition);
        if (projectTrusted && (approved || allowUnapproved))
            continue;
        let reason;
        if (!projectTrusted) {
            reason = "untrusted";
        }
        else if (!interactive) {
            reason = "approval-required";
        }
        else if (await ctx.ui.select(`Allow project MCP server “${name}”?\nProject config: ${source.path}\nEndpoint: ${describeServer(definition)}\n\nThis server can run local commands or make network requests with your user permissions.`, PROJECT_SERVER_CHOICES) === ALLOW_PROJECT_SERVER) {
            approveProjectServer(ctx.cwd, name, definition);
            continue;
        }
        else {
            reason = "denied";
        }
        config.mcpServers[name] = { ...definition, disabled: true };
        blockedServers.set(name, { reason, source });
    }
    return { config, blockedServers };
}
export function applyProjectServerTrustToConfig(config, ctx, options = {}) {
    return applyProjectServerTrust(asLoadedConfig(config), ctx, options);
}
/** Remove project-derived servers before an ExtensionContext exists. */
export function excludeProjectServersAtLoadTime(loadedOrConfig) {
    const loaded = "config" in loadedOrConfig && "projectServers" in loadedOrConfig
        ? loadedOrConfig
        : asLoadedConfig(loadedOrConfig);
    const config = { ...loaded.config, mcpServers: { ...loaded.config.mcpServers } };
    for (const name of loaded.projectServers.keys())
        delete config.mcpServers[name];
    return config;
}
//# sourceMappingURL=project-server-trust.js.map