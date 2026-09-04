import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Semantic styles shared by the MCP panels.
 *
 * The adapter deliberately keeps the panel roles independent from Pi's theme
 * token names. This lets the panel preserve its existing hierarchy while
 * consuming the active host theme, and gives the setup panel a small boundary
 * to adopt in its follow-up migration.
 */
export interface McpPanelTheme {
  border(text: string): string;
  title(text: string): string;
  selected(text: string): string;
  direct(text: string): string;
  needsAuth(text: string): string;
  placeholder(text: string): string;
  description(text: string): string;
  hint(text: string): string;
  confirm(text: string): string;
  cancel(text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  inverse(text: string): string;
}

const identity = (text: string): string => text;

const PLAIN_THEME: McpPanelTheme = {
  border: identity,
  title: identity,
  selected: identity,
  direct: identity,
  needsAuth: identity,
  placeholder: identity,
  description: identity,
  hint: identity,
  confirm: identity,
  cancel: identity,
  bold: identity,
  italic: identity,
  inverse: identity,
};

/**
 * Build panel styles from the theme supplied to `ctx.ui.custom()`.
 *
 * When the panel is constructed directly (for example by an integration test
 * or an older embedding), plain text remains a safe fallback. No ANSI palette
 * is owned by the adapter anymore.
 */
export function createMcpPanelTheme(theme?: Theme): McpPanelTheme {
  if (!theme) return PLAIN_THEME;

  return {
    border: (text) => theme.fg("border", text),
    title: (text) => theme.fg("accent", text),
    selected: (text) => theme.fg("accent", text),
    direct: (text) => theme.fg("success", text),
    needsAuth: (text) => theme.fg("warning", text),
    placeholder: (text) => theme.fg("dim", text),
    description: (text) => theme.fg("muted", text),
    hint: (text) => theme.fg("dim", text),
    confirm: (text) => theme.fg("success", text),
    cancel: (text) => theme.fg("error", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    inverse: (text) => theme.inverse(text),
  };
}
