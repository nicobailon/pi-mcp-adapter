import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";

/**
 * A width-aware frame shared by the MCP panel views.
 *
 * DynamicBorder owns the horizontal sizing; the panel supplies the corners so
 * each view can retain its existing frame shape without hand-building a
 * border-width-dependent ANSI line.
 */
export class McpPanelFrame implements Component {
  private readonly border: DynamicBorder;

  constructor(
    private readonly theme: McpPanelTheme,
    private readonly left: string,
    private readonly right: string,
    private readonly title?: string,
  ) {
    this.border = new DynamicBorder((text: string) => this.theme.border(text));
  }

  render(width: number): string[] {
    if (width <= 0) return [];
    if (width === 1) return [truncateToWidth(this.theme.border(this.left), width, "", false)];

    const innerWidth = width - 2;
    if (this.title !== undefined) {
      const titleText = truncateToWidth(` ${this.title} `, innerWidth, "", false);
      const borderLength = Math.max(0, innerWidth - visibleWidth(titleText));
      const leftLength = Math.floor(borderLength / 2);
      const rightLength = borderLength - leftLength;
      return [
        this.theme.border(this.left) +
          this.renderBorderSegment(leftLength) +
          this.theme.title(titleText) +
          this.renderBorderSegment(rightLength) +
          this.theme.border(this.right),
      ];
    }

    return [
      this.theme.border(this.left) +
        this.renderBorderSegment(innerWidth) +
        this.theme.border(this.right),
    ];
  }

  invalidate(): void {
    this.border.invalidate();
  }

  private renderBorderSegment(width: number): string {
    if (width <= 0) return "";
    return this.border.render(width)[0] ?? "";
  }
}

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
