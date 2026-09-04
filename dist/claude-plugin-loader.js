import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import stripJsonComments from "strip-json-comments";
import { formatServerNamespace } from "./types.js";
export function loadClaudePluginBundles(plugins, cwd, validateConfig, components) {
    const mcpServers = {};
    const skillPaths = [];
    const seenRoots = new Set();
    const seenNames = new Map();
    const serverSources = new Map();
    const normalizedServerNames = new Map();
    for (const plugin of plugins ?? []) {
        const configuredPath = resolvePluginPath(plugin.path, cwd);
        const pluginRoot = resolvePluginRoot(configuredPath);
        if (!pluginRoot)
            continue;
        if (seenRoots.has(pluginRoot)) {
            console.warn(`Claude plugin path is configured more than once: ${pluginRoot}`);
            continue;
        }
        seenRoots.add(pluginRoot);
        const manifest = readPluginManifest(pluginRoot);
        if (manifest === false)
            continue;
        const pluginName = manifest?.name ?? basename(pluginRoot);
        const previousPluginRoot = seenNames.get(pluginName);
        if (previousPluginRoot && previousPluginRoot !== pluginRoot) {
            console.warn(`Claude plugin name conflict for "${pluginName}": ${previousPluginRoot} and ${pluginRoot}`);
        }
        else {
            seenNames.set(pluginName, pluginRoot);
        }
        if (components.mcp && plugin.mcp === true) {
            const configPath = resolveContainedComponent(pluginRoot, ".mcp.json", "file", pluginName);
            if (configPath) {
                const config = readPluginMcpConfig(configPath, pluginName, pluginRoot, validateConfig);
                for (const [serverName, server] of Object.entries(config.mcpServers)) {
                    const normalizedName = formatServerNamespace(serverName);
                    const previousName = normalizedServerNames.get(normalizedName);
                    const previousSource = previousName ? serverSources.get(previousName) : undefined;
                    if (previousName && previousSource) {
                        console.warn(`Claude plugin MCP server name conflict for "${serverName}": normalized name collides with "${previousName}" from ${previousSource}; the first plugin wins over ${configPath}`);
                        continue;
                    }
                    normalizedServerNames.set(normalizedName, serverName);
                    serverSources.set(serverName, configPath);
                    mcpServers[serverName] = server;
                }
            }
        }
        if (components.skills && plugin.skills === true) {
            const skillsPath = resolveContainedComponent(pluginRoot, "skills", "directory", pluginName);
            if (skillsPath) {
                try {
                    for (const skillPath of discoverContainedSkillFiles(skillsPath, pluginName)) {
                        if (!skillPaths.includes(skillPath))
                            skillPaths.push(skillPath);
                    }
                }
                catch (error) {
                    console.warn(`Claude plugin "${pluginName}" skills could not be read at ${skillsPath}: ${formatError(error)}`);
                }
            }
        }
    }
    return { mcpServers, skillPaths };
}
function resolvePluginPath(path, cwd) {
    if (path === "~")
        return resolve(process.env.HOME ?? "", ".");
    if (path.startsWith("~/"))
        return resolve(process.env.HOME ?? "", path.slice(2));
    return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}
function resolvePluginRoot(path) {
    if (!existsSync(path)) {
        console.warn(`Claude plugin path does not exist: ${path}`);
        return null;
    }
    const stats = safeStat(path, "Claude plugin path");
    if (!stats)
        return null;
    if (!stats.isDirectory()) {
        console.warn(`Claude plugin path is not a directory: ${path}`);
        return null;
    }
    return safeRealpath(path, "Claude plugin path");
}
function readPluginManifest(pluginRoot) {
    const configuredManifestPath = resolve(pluginRoot, ".claude-plugin", "plugin.json");
    if (!existsSync(configuredManifestPath))
        return null;
    const stats = safeStat(configuredManifestPath, "Claude plugin manifest");
    if (!stats)
        return null;
    if (!stats.isFile()) {
        console.warn(`Claude plugin manifest is not a regular file: ${configuredManifestPath}`);
        return false;
    }
    const manifestPath = safeRealpath(configuredManifestPath, "Claude plugin manifest");
    if (!manifestPath)
        return null;
    if (!isContainedPath(pluginRoot, manifestPath)) {
        console.warn(`Claude plugin manifest resolves outside the configured plugin directory: ${manifestPath}`);
        return false;
    }
    const manifestText = safeReadFile(manifestPath, "Claude plugin manifest", pluginRoot);
    if (manifestText === null)
        return null;
    let raw;
    try {
        raw = parseJson(manifestText);
    }
    catch (error) {
        console.warn(`Claude plugin manifest contains invalid JSON at ${manifestPath}: ${formatError(error)}`);
        return false;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        console.warn(`Claude plugin manifest must be a JSON object: ${manifestPath}`);
        return false;
    }
    const manifest = raw;
    if (typeof manifest.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name)) {
        console.warn(`Claude plugin manifest has an invalid name at ${manifestPath}: expected kebab-case`);
        return false;
    }
    if (!hasValidManifestFieldTypes(manifest)) {
        console.warn(`Claude plugin manifest has invalid field types at ${manifestPath}`);
        return false;
    }
    return { name: manifest.name };
}
function hasValidManifestFieldTypes(manifest) {
    for (const field of ["$schema", "displayName", "version", "description", "homepage", "repository", "license"]) {
        if (manifest[field] !== undefined && typeof manifest[field] !== "string")
            return false;
    }
    for (const field of ["commands", "agents", "skills", "hooks", "mcpServers", "lspServers", "outputStyles"]) {
        const value = manifest[field];
        if (value !== undefined && typeof value !== "string" && (!Array.isArray(value) || value.some(item => typeof item !== "string")))
            return false;
    }
    if (manifest.defaultEnabled !== undefined && typeof manifest.defaultEnabled !== "boolean")
        return false;
    if (manifest.keywords !== undefined && (!Array.isArray(manifest.keywords) || manifest.keywords.some(value => typeof value !== "string")))
        return false;
    if (manifest.author !== undefined) {
        if (!manifest.author || typeof manifest.author !== "object" || Array.isArray(manifest.author))
            return false;
        const author = manifest.author;
        if (typeof author.name !== "string")
            return false;
        if (author.email !== undefined && typeof author.email !== "string")
            return false;
        if (author.url !== undefined && typeof author.url !== "string")
            return false;
    }
    if (manifest.metadata !== undefined && (!manifest.metadata || typeof manifest.metadata !== "object" || Array.isArray(manifest.metadata)))
        return false;
    return true;
}
function resolveContainedComponent(pluginRoot, component, expected, pluginName) {
    const path = resolve(pluginRoot, component);
    if (!existsSync(path)) {
        console.warn(`Claude plugin "${pluginName}" is missing ${component}: ${path}`);
        return null;
    }
    const stats = safeStat(path, `Claude plugin "${pluginName}" ${component}`);
    if (!stats)
        return null;
    if (expected === "file" ? !stats.isFile() : !stats.isDirectory()) {
        console.warn(`Claude plugin "${pluginName}" ${component} is not a ${expected}: ${path}`);
        return null;
    }
    const realPath = safeRealpath(path, `Claude plugin "${pluginName}" ${component}`);
    if (!realPath)
        return null;
    if (!isContainedPath(pluginRoot, realPath)) {
        console.warn(`Claude plugin "${pluginName}" ${component} resolves outside the configured plugin directory: ${realPath}`);
        return null;
    }
    return realPath;
}
function discoverContainedSkillFiles(skillsRoot, pluginName) {
    const skillFiles = [];
    const visitedDirectories = new Set();
    const visit = (directory) => {
        const realDirectory = safeRealpath(directory, `Claude plugin "${pluginName}" skill directory`);
        if (!realDirectory)
            return;
        if (!isContainedPath(skillsRoot, realDirectory)) {
            console.warn(`Claude plugin "${pluginName}" skill path resolves outside its skills directory: ${directory} -> ${realDirectory}`);
            return;
        }
        if (visitedDirectories.has(realDirectory))
            return;
        visitedDirectories.add(realDirectory);
        const entries = safeReadDir(realDirectory, `Claude plugin "${pluginName}" skill directory`);
        if (!entries)
            return;
        for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
            const path = resolve(realDirectory, entry.name);
            if (entry.isSymbolicLink()) {
                const target = safeRealpath(path, `Claude plugin "${pluginName}" skill path`);
                if (!target)
                    continue;
                if (!isContainedPath(skillsRoot, target)) {
                    console.warn(`Claude plugin "${pluginName}" skill path resolves outside its skills directory: ${path} -> ${target}`);
                    continue;
                }
                const targetStats = safeStat(target, `Claude plugin "${pluginName}" skill path`);
                if (!targetStats)
                    continue;
                if (targetStats.isDirectory())
                    visit(target);
                else if (targetStats.isFile() && entry.name === "SKILL.md")
                    skillFiles.push(target);
            }
            else if (entry.isDirectory()) {
                visit(path);
            }
            else if (entry.isFile() && entry.name === "SKILL.md") {
                const realPath = safeRealpath(path, `Claude plugin "${pluginName}" skill path`);
                if (!realPath)
                    continue;
                if (!isContainedPath(skillsRoot, realPath)) {
                    console.warn(`Claude plugin "${pluginName}" skill path resolves outside its skills directory: ${path} -> ${realPath}`);
                    continue;
                }
                skillFiles.push(realPath);
            }
        }
    };
    visit(skillsRoot);
    return skillFiles;
}
function readPluginMcpConfig(configPath, pluginName, pluginRoot, validateConfig) {
    let raw;
    try {
        const configText = safeReadFile(configPath, `Claude plugin "${pluginName}" MCP config`, pluginRoot);
        if (configText === null)
            return { mcpServers: {} };
        raw = parseJson(configText);
    }
    catch (error) {
        console.warn(`Claude plugin "${pluginName}" has invalid MCP config at ${configPath}: ${formatError(error)}`);
        return { mcpServers: {} };
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        console.warn(`Claude plugin "${pluginName}" MCP config must be a JSON object: ${configPath}`);
        return { mcpServers: {} };
    }
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
        console.warn(`Claude plugin "${pluginName}" MCP config must contain an mcpServers object: ${configPath}`);
        return { mcpServers: {} };
    }
    const config = validateConfig(raw);
    const validated = {};
    for (const serverName of Object.keys(servers)) {
        if (serverName.trim().length === 0) {
            console.warn(`Claude plugin "${pluginName}" has an empty MCP server name at ${configPath}`);
            continue;
        }
        const parsed = config.mcpServers[serverName];
        if (!parsed || !hasValidServerTransport(parsed)) {
            console.warn(`Claude plugin "${pluginName}" has invalid MCP server "${serverName}" at ${configPath}: expected exactly one non-empty command, url, or socket transport`);
            continue;
        }
        validated[serverName] = replacePluginRoot(parsed, pluginRoot);
    }
    return { mcpServers: validated };
}
function hasValidServerTransport(entry) {
    return [entry.command, entry.url, entry.socket].filter(value => typeof value === "string" && value.trim().length > 0).length === 1;
}
function replacePluginRoot(entry, pluginRoot) {
    const replace = (value) => value.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot);
    const replaced = replaceStrings(entry, replace);
    if (typeof replaced.command === "string") {
        replaced.env = { ...replaced.env, CLAUDE_PLUGIN_ROOT: pluginRoot };
    }
    return replaced;
}
function replaceStrings(value, replace) {
    if (typeof value === "string")
        return replace(value);
    if (Array.isArray(value))
        return value.map(item => replaceStrings(item, replace));
    if (!value || typeof value !== "object")
        return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceStrings(entry, replace)]));
}
function isContainedPath(root, path) {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !isAbsolute(rel));
}
function parseJson(raw) {
    return JSON.parse(stripJsonComments(raw, { trailingCommas: true }));
}
function safeStat(path, description) {
    try {
        return statSync(path);
    }
    catch (error) {
        console.warn(`${description} could not be read: ${path}: ${formatError(error)}`);
        return null;
    }
}
function safeRealpath(path, description) {
    try {
        return realpathSync(path);
    }
    catch (error) {
        console.warn(`${description} could not be read: ${path}: ${formatError(error)}`);
        return null;
    }
}
function safeReadFile(path, description, containmentRoot) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const openedStats = fstatSync(fd);
        if (!openedStats.isFile()) {
            console.warn(`${description} is not a regular file: ${path}`);
            return null;
        }
        const resolvedPath = safeRealpath(path, description);
        if (!resolvedPath)
            return null;
        if (!isContainedPath(containmentRoot, resolvedPath)) {
            console.warn(`${description} resolves outside the configured plugin directory: ${resolvedPath}`);
            return null;
        }
        const currentStats = safeStat(resolvedPath, description);
        if (!currentStats)
            return null;
        if (openedStats.dev !== currentStats.dev || openedStats.ino !== currentStats.ino) {
            console.warn(`${description} changed while being read: ${path}`);
            return null;
        }
        return readFileSync(fd, "utf8");
    }
    catch (error) {
        console.warn(`${description} could not be read: ${path}: ${formatError(error)}`);
        return null;
    }
    finally {
        if (fd !== undefined)
            closeSync(fd);
    }
}
function safeReadDir(path, description) {
    try {
        return readdirSync(path, { withFileTypes: true });
    }
    catch (error) {
        console.warn(`${description} could not be read: ${path}: ${formatError(error)}`);
        return null;
    }
}
function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}
//# sourceMappingURL=claude-plugin-loader.js.map