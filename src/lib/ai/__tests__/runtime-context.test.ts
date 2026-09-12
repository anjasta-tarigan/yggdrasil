import { describe, it, expect } from "vitest";
import { buildRuntimeContext } from "../runtime-context";

/**
 * The helper returns `Record<string, unknown>` (the shape the AI SDK v7
 * `runtimeContext` option expects). For test assertions we cast to a typed
 * view so we can read the string fields without `unknown`-typed accesses.
 */
interface RuntimeContextShape {
  requestId: string;
  chatId: string;
  modelId: string;
  featureFlags: Record<string, boolean>;
  startedAt: string;
}
const asContext = (ctx: Record<string, unknown>): RuntimeContextShape =>
  ctx as unknown as RuntimeContextShape;

describe("buildRuntimeContext", () => {
  it("returns an object with all core fields", () => {
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-123",
        modelId: "gpt-4o",
      }),
    );
    expect(ctx).toHaveProperty("requestId");
    expect(ctx).toHaveProperty("chatId");
    expect(ctx).toHaveProperty("modelId");
    expect(ctx).toHaveProperty("featureFlags");
    expect(ctx).toHaveProperty("startedAt");
  });

  it("passes through chatId and modelId unchanged", () => {
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-abc",
        modelId: "anthropic/claude-3-5-sonnet",
      }),
    );
    expect(ctx.chatId).toBe("chat-abc");
    expect(ctx.modelId).toBe("anthropic/claude-3-5-sonnet");
  });

  it("generates a unique requestId when not provided", () => {
    const a = asContext(
      buildRuntimeContext({ chatId: "c1", modelId: "m1" }),
    );
    const b = asContext(
      buildRuntimeContext({ chatId: "c2", modelId: "m2" }),
    );
    // generateId() from the AI SDK produces a compact unique token; the key
    // invariant is that two calls yields distinct, non-empty strings.
    expect(a.requestId.length).toBeGreaterThan(0);
    expect(b.requestId.length).toBeGreaterThan(0);
    expect(a.requestId).not.toBe(b.requestId);
  });

  it("generates a requestId that is non-empty and distinct from a seed", () => {
    // Belt-and-suspenders: the generated id must not be blank and, across a
    // small sample, never collide (uniqueness is the contract the test list
    // calls out).
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const ctx = asContext(
        buildRuntimeContext({ chatId: "c", modelId: "m" }),
      );
      expect(ctx.requestId.length).toBeGreaterThan(0);
      ids.add(ctx.requestId);
    }
    expect(ids.size).toBe(50);
  });

  it("reuses the requestId when one is provided", () => {
    const provided = "req-explicit-0123456789abcdef";
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-1",
        modelId: "gpt-4o",
        requestId: provided,
      }),
    );
    expect(ctx.requestId).toBe(provided);
  });

  it("defaults featureFlags to an empty object when not provided", () => {
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-1",
        modelId: "gpt-4o",
      }),
    );
    expect(ctx.featureFlags).toEqual({});
  });

  it("preserves the provided featureFlags", () => {
    const flags = { delegated: true, experimental: false };
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-1",
        modelId: "gpt-4o",
        featureFlags: flags,
      }),
    );
    expect(ctx.featureFlags).toEqual(flags);
  });

  it("sets startedAt to a valid ISO timestamp", () => {
    const before = Date.now();
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-1",
        modelId: "gpt-4o",
      }),
    );
    const after = Date.now();
    const parsed = Date.parse(ctx.startedAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it("returns a JSON-serializable object that round-trips", () => {
    const ctx = asContext(
      buildRuntimeContext({
        chatId: "chat-1",
        modelId: "gpt-4o",
        featureFlags: { delegated: true },
      }),
    );
    // Should not throw.
    const json = JSON.stringify(ctx);
    // Round-trips back to equivalent values (string fields deep-equal).
    const roundTripped = JSON.parse(json) as RuntimeContextShape;
    expect(roundTripped.chatId).toBe(ctx.chatId);
    expect(roundTripped.modelId).toBe(ctx.modelId);
    expect(roundTripped.requestId).toBe(ctx.requestId);
    expect(roundTripped.featureFlags).toEqual(ctx.featureFlags);
    expect(roundTripped.startedAt).toBe(ctx.startedAt);
  });
});
