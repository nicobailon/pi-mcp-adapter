export function extractUiToolVisibility(meta) {
    if (!meta || typeof meta !== "object")
        return undefined;
    const ui = meta.ui;
    if (!ui || typeof ui !== "object" || Array.isArray(ui))
        return undefined;
    const visibility = ui.visibility;
    if (visibility === undefined)
        return undefined;
    if (!Array.isArray(visibility))
        return [];
    const values = [];
    for (const entry of visibility) {
        if (entry !== "model" && entry !== "app")
            return [];
        if (!values.includes(entry))
            values.push(entry);
    }
    return values;
}
export function isUiToolVisibleToModel(visibility) {
    return visibility === undefined || visibility.includes("model");
}
export function isUiToolCallableByApp(visibility) {
    return visibility === undefined || visibility.includes("app");
}
//# sourceMappingURL=ui-tool-visibility.js.map