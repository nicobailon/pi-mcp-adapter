export type UiToolVisibility = "model" | "app";
export declare function extractUiToolVisibility(meta: Record<string, unknown> | undefined): UiToolVisibility[] | undefined;
export declare function isUiToolVisibleToModel(visibility: readonly UiToolVisibility[] | undefined): boolean;
export declare function isUiToolCallableByApp(visibility: readonly UiToolVisibility[] | undefined): boolean;
