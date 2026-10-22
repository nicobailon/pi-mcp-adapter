import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCodemodeScript } from "../../codemode-bridge.ts";

// Loaded through Pi's extension loader, so the bridge's dynamic import resolves the way it does in Pi.
export default function codemodeBridgeProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bridge_probe",
    label: "Bridge probe",
    description: "Run a script through the adapter's codemode bridge",
    parameters: Type.Object({ source: Type.String(), input: Type.Record(Type.String(), Type.Unknown()) }),
    execute: (toolCallId, params, signal, onUpdate, ctx) => runCodemodeScript({
      pi, ctx, toolCallId, signal, onUpdate, tool: "probe", source: params.source, input: params.input,
    }),
  });
}
