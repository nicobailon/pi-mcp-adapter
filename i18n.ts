import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const namespace = "pi-mcp-adapter";
type Params = Record<string, string | number>;
type I18nApi = { t?: (key: string, params?: Params) => string };

let api: I18nApi | null = null;

export function initI18n(pi: ExtensionAPI): void {
  const events = pi.events;
  if (!events) return;

  events.emit("pi-core/i18n/registerBundle", jaBundle);
  events.emit("pi-core/i18n/registerBundle", zhCnBundle);
  events.emit("pi-core/i18n/registerBundle", deBundle);
  events.emit("pi-core/i18n/requestApi", {
    reply(candidate: I18nApi) {
      api = candidate;
    },
  });
}

export function t(key: string, fallback: string, params?: Params): string {
  const fullKey = `${namespace}.${key}`;
  const value = api?.t?.(fullKey, params);
  return value && value !== fullKey ? value : format(fallback, params);
}

function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_m, name) => String(params[name] ?? `{${name}}`));
}

const jaBundle = {
  schemaVersion: 1,
  namespace,
  locale: "ja",
  messages: {
    "status.header": "MCP サーバーの状態:",
    "status.notConnected": "未接続",
    "status.connected": "接続済み",
    "status.needsAuth": "認証が必要",
    "status.failedAgo": "{seconds} 秒前に失敗",
    "status.cached": "キャッシュ済み",
    "status.noServers": "MCP サーバーが設定されていません",
    "status.setupHint": "/mcp setup を実行してインポートを採用するか、スターター .mcp.json を作成してください",
    "tools.none": "利用可能な MCP ツールはありません",
    "reconnect.serverNotFound": "サーバー \"{server}\" は設定にありません",
    "reconnect.requiresOAuth": "MCP: {server} は OAuth が必要です。先に /mcp-auth {server} を実行してください。",
    "reconnect.success": "MCP: {server} に再接続しました（{tools} ツール、{resources} リソース）",
    "reconnect.toolsSkipped": "MCP: {server} - {count} 個のツールをスキップしました",
    "reconnect.failed": "MCP: {server} への再接続に失敗しました: {message}",
    "auth.notOAuth": "サーバー \"{server}\" は OAuth 認証を使用していません。\n\"auth\": \"oauth\" を設定するか、自動検出のため auth を省略してください。",
    "auth.noUrl": "サーバー \"{server}\" には URL が設定されていません（OAuth には HTTP transport が必要です）",
    "auth.status": "{server} を認証中...",
    "auth.success": "\"{server}\" の OAuth 認証に成功しました！\n新しいトークンで接続するには /mcp reconnect {server} を実行してください。",
    "auth.failed": "\"{server}\" の OAuth 認証に失敗しました。",
    "auth.failedWithMessage": "\"{server}\" の認証に失敗しました: {message}",
    "setup.run.label": "セットアップを実行",
    "setup.run.description": "検出された設定を確認し、インポートを採用し、最小限の `.mcp.json` を作成します。",
    "setup.adopt.label": "検出された互換インポートを採用",
    "setup.adopt.description": "Pi が独自の override ファイルに取り込むホスト別 MCP 設定を選択します。{count} 件のソースが見つかりました。",
    "setup.example.label": "`.mcp.json` の例を見る",
    "setup.example.description": "貼り付けまたは調整できる共有 MCP 設定の例をプレビューします。",
    "setup.scaffold.label": "プロジェクト `.mcp.json` を作成",
    "setup.scaffold.description": "標準の共有 MCP ファイルパスを使って最小限のプロジェクト設定を書き込み、Pi をリロードします。",
    "setup.precedence.label": "設定の優先順位を説明",
    "setup.precedence.description": "読み込み順と Pi が互換設定を書き込む場所を表示します。",
    "setup.paths.label": "検出された設定パスを開く",
    "setup.paths.description": "このマシンで Pi が検出した実際の設定ファイルを参照します。",
    "setup.repoprompt.label": "RepoPrompt を共有 MCP 設定に追加",
    "setup.repoprompt.description": "推奨される共有ターゲットに RepoPrompt の標準 MCP エントリを書き込み、セッション内で MCP をリロードします。",
    "setup.close.label": "閉じる",
    "setup.close.description": "オンボーディングを終了します。"
  }
};

const zhCnBundle = {
  schemaVersion: 1,
  namespace,
  locale: "zh-CN",
  messages: {
    "status.header": "MCP 服务器状态：",
    "status.notConnected": "未连接",
    "status.connected": "已连接",
    "status.needsAuth": "需要认证",
    "status.failedAgo": "{seconds} 秒前失败",
    "status.cached": "已缓存",
    "status.noServers": "尚未配置 MCP 服务器",
    "status.setupHint": "运行 /mcp setup 以采用导入配置，或生成 starter .mcp.json",
    "tools.none": "没有可用的 MCP 工具",
    "reconnect.serverNotFound": "配置中找不到服务器 \"{server}\"",
    "reconnect.requiresOAuth": "MCP：{server} 需要 OAuth。请先运行 /mcp-auth {server}。",
    "reconnect.success": "MCP：已重新连接到 {server}（{tools} 个工具，{resources} 个资源）",
    "reconnect.toolsSkipped": "MCP：{server} - 已跳过 {count} 个工具",
    "reconnect.failed": "MCP：重新连接到 {server} 失败：{message}",
    "auth.notOAuth": "服务器 \"{server}\" 未使用 OAuth 认证。\n请设置 \"auth\": \"oauth\"，或省略 auth 以自动检测。",
    "auth.noUrl": "服务器 \"{server}\" 没有配置 URL（OAuth 需要 HTTP transport）",
    "auth.status": "正在认证 {server}...",
    "auth.success": "\"{server}\" 的 OAuth 认证成功！\n运行 /mcp reconnect {server} 以使用新 token 连接。",
    "auth.failed": "\"{server}\" 的 OAuth 认证失败。",
    "auth.failedWithMessage": "认证 \"{server}\" 失败：{message}",
    "setup.run.label": "运行设置",
    "setup.run.description": "检查检测到的配置，采用导入项，并生成最小 `.mcp.json`。",
    "setup.adopt.label": "采用检测到的兼容导入",
    "setup.adopt.description": "选择 Pi 应导入到自身 override 文件的主机专用 MCP 配置。发现 {count} 个来源。",
    "setup.example.label": "查看 `.mcp.json` 示例",
    "setup.example.description": "预览可粘贴或调整的共享 MCP 配置示例。",
    "setup.scaffold.label": "生成项目 `.mcp.json`",
    "setup.scaffold.description": "使用标准共享 MCP 文件路径写入最小项目配置，然后重新加载 Pi。",
    "setup.precedence.label": "说明配置优先级",
    "setup.precedence.description": "显示读取顺序以及 Pi 写入兼容设置的位置。",
    "setup.paths.label": "打开检测到的配置路径",
    "setup.paths.description": "浏览 Pi 在本机发现的实际配置文件。",
    "setup.repoprompt.label": "将 RepoPrompt 添加到共享 MCP 配置",
    "setup.repoprompt.description": "将 RepoPrompt 的标准 MCP 条目写入推荐的共享目标，然后在会话中重新加载 MCP。",
    "setup.close.label": "关闭",
    "setup.close.description": "退出引导流程。"
  }
};

const deBundle = {
  schemaVersion: 1,
  namespace,
  locale: "de",
  messages: {
    "status.header": "MCP-Serverstatus:",
    "status.notConnected": "nicht verbunden",
    "status.connected": "verbunden",
    "status.needsAuth": "Authentifizierung erforderlich",
    "status.failedAgo": "vor {seconds}s fehlgeschlagen",
    "status.cached": "zwischengespeichert",
    "status.noServers": "Keine MCP-Server konfiguriert",
    "status.setupHint": "Führe /mcp setup aus, um Imports zu übernehmen oder eine Starter-.mcp.json zu erzeugen",
    "tools.none": "Keine MCP-Tools verfügbar",
    "reconnect.serverNotFound": "Server \"{server}\" wurde in der Konfiguration nicht gefunden",
    "reconnect.requiresOAuth": "MCP: {server} benötigt OAuth. Führe zuerst /mcp-auth {server} aus.",
    "reconnect.success": "MCP: Wieder mit {server} verbunden ({tools} Tools, {resources} Ressourcen)",
    "reconnect.toolsSkipped": "MCP: {server} - {count} Tools übersprungen",
    "reconnect.failed": "MCP: Wiederverbindung zu {server} fehlgeschlagen: {message}",
    "auth.notOAuth": "Server \"{server}\" verwendet keine OAuth-Authentifizierung.\nSetze \"auth\": \"oauth\" oder lasse auth für automatische Erkennung weg.",
    "auth.noUrl": "Server \"{server}\" hat keine URL konfiguriert (OAuth benötigt HTTP-Transport)",
    "auth.status": "Authentifiziere {server}...",
    "auth.success": "OAuth-Authentifizierung für \"{server}\" erfolgreich!\nFühre /mcp reconnect {server} aus, um mit dem neuen Token zu verbinden.",
    "auth.failed": "OAuth-Authentifizierung für \"{server}\" fehlgeschlagen.",
    "auth.failedWithMessage": "Authentifizierung für \"{server}\" fehlgeschlagen: {message}",
    "setup.run.label": "Setup ausführen",
    "setup.run.description": "Erkannte Konfigurationen prüfen, Imports übernehmen und eine minimale `.mcp.json` erstellen.",
    "setup.adopt.label": "Erkannte Kompatibilitäts-Imports übernehmen",
    "setup.adopt.description": "Auswählen, welche host-spezifischen MCP-Konfigurationen Pi in die eigene Override-Datei importieren soll. {count} Quellen gefunden.",
    "setup.example.label": "Beispiel-`.mcp.json` anzeigen",
    "setup.example.description": "Eine funktionierende gemeinsame MCP-Konfiguration zum Einfügen oder Anpassen vorab ansehen.",
    "setup.scaffold.label": "Projekt-`.mcp.json` erzeugen",
    "setup.scaffold.description": "Eine minimale Projektkonfiguration mit dem Standardpfad für gemeinsame MCP-Dateien schreiben und Pi neu laden.",
    "setup.precedence.label": "Konfigurationsreihenfolge erklären",
    "setup.precedence.description": "Lesereihenfolge und Speicherort der Pi-Kompatibilitätseinstellungen anzeigen.",
    "setup.paths.label": "Erkannte Konfigurationspfade öffnen",
    "setup.paths.description": "Die tatsächlichen Konfigurationsdateien durchsuchen, die Pi auf diesem Rechner gefunden hat.",
    "setup.repoprompt.label": "RepoPrompt zur gemeinsamen MCP-Konfiguration hinzufügen",
    "setup.repoprompt.description": "Einen Standard-MCP-Eintrag für RepoPrompt in das empfohlene gemeinsame Ziel schreiben und MCP in der Sitzung neu laden.",
    "setup.close.label": "Schließen",
    "setup.close.description": "Onboarding beenden."
  }
};
