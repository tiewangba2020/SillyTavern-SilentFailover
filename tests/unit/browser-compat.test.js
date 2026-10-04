import { test, expect, vi, afterEach } from "vitest";
import { requestId, requestDeadline } from "../../extension/browser-compat.js";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
test("HTTP-safe IDs use secure randomness and remain valid independent task IDs", () => {
  const random = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
  vi.stubGlobal("crypto", { getRandomValues: random });
  const ids = Array.from({ length: 1000 }, requestId);
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    ids.every((id) =>
      /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
        id,
      ),
    ),
  ).toBe(true);
});
test("deadlines preserve cancellation and clean up timers and listeners", () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const deadline = requestDeadline(parent.signal, 100);
  parent.abort(new DOMException("user stop", "AbortError"));
  expect(deadline.signal.aborted).toBe(true);
  expect(deadline.signal.reason).toBe(parent.signal.reason);
  deadline.dispose();
  expect(vi.getTimerCount()).toBe(0);
  const expired = requestDeadline(undefined, 100);
  vi.advanceTimersByTime(100);
  expect(expired.signal.reason.name).toBe("TimeoutError");
  expired.dispose();
  const completed = requestDeadline(undefined, 100);
  completed.dispose();
  vi.advanceTimersByTime(101);
  expect(completed.signal.aborted).toBe(false);
  const alreadyStopped = requestDeadline(parent.signal);
  expect(alreadyStopped.signal.aborted).toBe(true);
  alreadyStopped.dispose();
  expect(vi.getTimerCount()).toBe(0);
});
