import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

type Locale = "en" | "es" | "fr" | "pt-BR";
type Params = Record<string, string | number>;

const translations: Record<Exclude<Locale, "en">, Record<string, string>> = {
  es: {
    "mcp.status.title": "Estado de servidores MCP:",
    "mcp.status.notConnected": "no conectado",
    "mcp.status.connected": "conectado",
    "mcp.status.needsAuth": "requiere autenticación",
    "mcp.status.failedAgo": "falló hace {seconds}s",
    "mcp.status.cached": "en caché",
    "mcp.status.tools": "{count} herramientas",
    "mcp.status.toolsCached": "{count} herramientas, en caché",
    "mcp.status.noneConfigured": "No hay servidores MCP configurados",
    "mcp.status.setupHint": "Ejecuta /mcp setup para adoptar importaciones o crear un .mcp.json inicial",
  },
  fr: {
    "mcp.status.title": "État des serveurs MCP :",
    "mcp.status.notConnected": "non connecté",
    "mcp.status.connected": "connecté",
    "mcp.status.needsAuth": "authentification requise",
    "mcp.status.failedAgo": "échec il y a {seconds}s",
    "mcp.status.cached": "en cache",
    "mcp.status.tools": "{count} outils",
    "mcp.status.toolsCached": "{count} outils, en cache",
    "mcp.status.noneConfigured": "Aucun serveur MCP configuré",
    "mcp.status.setupHint": "Exécutez /mcp setup pour adopter des imports ou créer un .mcp.json de départ",
  },
  "pt-BR": {
    "mcp.status.title": "Status dos servidores MCP:",
    "mcp.status.notConnected": "não conectado",
    "mcp.status.connected": "conectado",
    "mcp.status.needsAuth": "requer autenticação",
    "mcp.status.failedAgo": "falhou há {seconds}s",
    "mcp.status.cached": "em cache",
    "mcp.status.tools": "{count} ferramentas",
    "mcp.status.toolsCached": "{count} ferramentas, em cache",
    "mcp.status.noneConfigured": "Nenhum servidor MCP configurado",
    "mcp.status.setupHint": "Execute /mcp setup para adotar importações ou criar um .mcp.json inicial",
  },
};

let currentLocale: Locale = "en";

export function initI18n(pi: ExtensionAPI): void {
  pi.events?.emit?.("pi-core/i18n/registerBundle", {
    namespace: "pi-mcp-adapter",
    defaultLocale: "en",
    locales: translations,
  });

  pi.events?.emit?.("pi-core/i18n/requestApi", {
    onReady: (api: { getLocale?: () => string; onLocaleChange?: (cb: (locale: string) => void) => void }) => {
      const next = api.getLocale?.();
      if (isLocale(next)) currentLocale = next;
      api.onLocaleChange?.((locale) => {
        if (isLocale(locale)) currentLocale = locale;
      });
    },
  });
}

export function t(key: string, fallback: string, params: Params = {}): string {
  const template = currentLocale === "en" ? fallback : translations[currentLocale]?.[key] ?? fallback;
  return template.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? `{${name}}`));
}

function isLocale(locale: string | undefined): locale is Locale {
  return locale === "en" || locale === "es" || locale === "fr" || locale === "pt-BR";
}
