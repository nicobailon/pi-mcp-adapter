import { matchesKey, type KeyId } from "@earendil-works/pi-tui";

/** The panel keybinding ids the adapter panels resolve through pi-tui. */
export type PanelSelectKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.confirm";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface PanelKeybindings {
  matches(data: string, keybinding: PanelSelectKeybinding): boolean;
  getUserBindings?(): Record<string, KeyId | KeyId[] | undefined>;
}

/**
 * Key matchers for panel actions: user bindings when a manager is provided,
 * otherwise the previous hardcoded defaults.
 */
export interface PanelKeys {
  selectUp(data: string): boolean;
  selectDown(data: string): boolean;
  selectConfirm(data: string): boolean;
  save(data: string): boolean;
  saveLabel(): string | null;
}

function configuredSaveKeys(keybindings?: PanelKeybindings): { keys: KeyId[]; configured: boolean } {
  const explicit = keybindings?.getUserBindings?.()["mcp.panel.save"];
  if (explicit !== undefined) return { keys: Array.isArray(explicit) ? explicit : [explicit], configured: true };
  return { keys: [], configured: false };
}

export function createPanelKeys(keybindings?: PanelKeybindings): PanelKeys {
  const saveBinding = configuredSaveKeys(keybindings);
  if (keybindings) {
    return {
      selectUp: (data) => keybindings.matches(data, "tui.select.up"),
      selectDown: (data) => keybindings.matches(data, "tui.select.down"),
      selectConfirm: (data) => keybindings.matches(data, "tui.select.confirm"),
      save: (data) => saveBinding.keys.length > 0
        ? saveBinding.keys.some((key) => matchesKey(data, key))
        : !saveBinding.configured && matchesKey(data, "ctrl+s"),
      saveLabel: () => saveBinding.keys[0] ?? (saveBinding.configured ? null : "ctrl+s"),
    };
  }
  return {
    selectUp: (data) => matchesKey(data, "up"),
    selectDown: (data) => matchesKey(data, "down"),
    selectConfirm: (data) => matchesKey(data, "return"),
    save: (data) => matchesKey(data, "ctrl+s"),
    saveLabel: () => "ctrl+s",
  };
}
