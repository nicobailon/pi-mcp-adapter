import { getEventListeners } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { combineAbortSignals } from "../runtime-owner.ts";

const nativeAny = AbortSignal.any;
afterEach(() => vi.unstubAllGlobals());

function withoutNativeAny() {
  class LegacyAbortSignal extends AbortSignal {}
  Object.defineProperty(LegacyAbortSignal, "any", { value: undefined });
  vi.stubGlobal("AbortSignal", LegacyAbortSignal);
}

for (const fallback of [false, true]) {
  describe(fallback ? "fallback signal combination" : "runtime signal combination", () => {
    it("preserves empty and single-signal fast paths", () => {
      if (fallback) withoutNativeAny();
      const signal = new AbortController().signal;
      expect(combineAbortSignals()).toBeUndefined();
      expect(combineAbortSignals(undefined, undefined)).toBeUndefined();
      expect(combineAbortSignals(undefined, signal, undefined)).toBe(signal);
    });

    it("uses input order for already-aborted reasons without adding listeners", () => {
      if (fallback) withoutNativeAny();
      const live = new AbortController();
      const first = new AbortController();
      const second = new AbortController();
      second.abort(new Error("second"));
      first.abort(new Error("first"));
      const signal = combineAbortSignals(live.signal, first.signal, second.signal)!;
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(first.signal.reason);
      for (const input of [live, first, second]) {
        expect(getEventListeners(input.signal, "abort")).toHaveLength(0);
      }
    });

    it("settles once with the first observed reason and removes all listeners", () => {
      if (fallback) withoutNativeAny();
      const first = new AbortController();
      const second = new AbortController();
      const signal = combineAbortSignals(first.signal, undefined, second.signal, first.signal)!;
      const aborted = vi.fn();
      signal.addEventListener("abort", aborted);
      expect(signal.aborted).toBe(false);
      const reason = { message: "second aborted first" };
      second.abort(reason);
      expect(signal.aborted).toBe(true);
      expect(signal.reason).toBe(reason);
      expect(getEventListeners(first.signal, "abort")).toHaveLength(0);
      expect(getEventListeners(second.signal, "abort")).toHaveLength(0);
      first.abort(new Error("later"));
      expect(signal.reason).toBe(reason);
      expect(aborted).toHaveBeenCalledTimes(1);
    });
  });
}

it.skipIf(typeof nativeAny !== "function")("delegates multiple signals to native AbortSignal.any", () => {
  const result = new AbortController().signal;
  const any = vi.fn(() => result);
  class NativeAbortSignal extends AbortSignal {}
  Object.defineProperty(NativeAbortSignal, "any", { value: any });
  vi.stubGlobal("AbortSignal", NativeAbortSignal);
  const first = new AbortController().signal;
  const second = new AbortController().signal;
  expect(combineAbortSignals(first, undefined, second)).toBe(result);
  expect(any).toHaveBeenCalledExactlyOnceWith([first, second]);
});
