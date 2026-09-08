import { describe, it, expect } from "vitest";
import { mergeCapabilities } from "@/lib/ai/capability-detection/merge";
import { Capabilities, CapabilitySources } from "@/lib/ai/provider-config/schema";

describe("mergeCapabilities", () => {
  it("catalog fills, provider-meta overrides limits, probes fill only still-null modalities", () => {
    const { capabilities, capabilitySources } = mergeCapabilities(
      {
        catalog: {
          contextWindow: 100,
          maxOutputTokens: 50,
          inputModalities: ["text"],
          outputModalities: ["text"],
          supportsToolCalls: true,
          supportsReasoning: false,
        },
        providerMeta: {
          contextWindow: 80,
        },
        probes: {
          inputModalities: ["text", "image"],
          supportsReasoning: true,
        },
      },
      {}
    );

    expect(capabilities.contextWindow).toBe(80);
    expect(capabilitySources.contextWindow).toBe("provider-metadata");

    expect(capabilities.maxOutputTokens).toBe(50);
    expect(capabilitySources.maxOutputTokens).toBe("models.dev");

    // The catalog already sourced inputModalities — the probe must NOT
    // stomp it (spec Layer 3: fills only still-null fields).
    expect(capabilities.inputModalities).toEqual(["text"]);
    expect(capabilitySources.inputModalities).toBe("models.dev");

    // supportsReasoning came from the catalog too — also protected.
    expect(capabilities.supportsReasoning).toBe(false);
    expect(capabilitySources.supportsReasoning).toBe("models.dev");

    expect(capabilities.supportsToolCalls).toBe(true);
    expect(capabilitySources.supportsToolCalls).toBe("models.dev");
  });

  it("never overwrites fields where existingSources[field]==='user'", () => {
    const existingCapabilities: Capabilities = {
      contextWindow: 42000,
      maxOutputTokens: 2048,
      inputModalities: ["text", "pdf"],
      outputModalities: ["text"],
      supportsToolCalls: true,
      supportsReasoning: true,
    };
    const existingSources: CapabilitySources = {
      contextWindow: "user",
      inputModalities: "user",
    };

    const { capabilities, capabilitySources } = mergeCapabilities(
      {
        catalog: { contextWindow: 999, inputModalities: ["text", "image"] },
        providerMeta: { contextWindow: 888 },
        probes: { inputModalities: ["text", "audio"] },
      },
      { capabilities: existingCapabilities, capabilitySources: existingSources }
    );

    // User overrides are preserved
    expect(capabilities.contextWindow).toBe(42000);
    expect(capabilitySources.contextWindow).toBe("user");

    expect(capabilities.inputModalities).toEqual(["text", "pdf"]);
    expect(capabilitySources.inputModalities).toBe("user");
  });

  it("unknown fields stay null", () => {
    const { capabilities, capabilitySources } = mergeCapabilities({}, {});
    expect(capabilities.contextWindow).toBeNull();
    expect(capabilities.maxOutputTokens).toBeNull();
    expect(capabilities.inputModalities).toEqual(["text"]);
    expect(capabilities.outputModalities).toEqual(["text"]);
    expect(capabilities.supportsToolCalls).toBeNull();
    expect(capabilities.supportsReasoning).toBeNull();
    expect(capabilitySources).toEqual({});
  });

  it("accepts existingSources directly as second argument if existing is just sources", () => {
    const { capabilitySources } = mergeCapabilities(
      { catalog: { contextWindow: 100 } },
      { contextWindow: "user" }
    );
    // If passed directly as capabilitySources without existing.capabilities
    expect(capabilitySources.contextWindow).toBe("user");
  });

  it("probes do NOT overwrite a modality list an earlier layer already sourced (spec: probes fill only still-null fields)", () => {
    // Layer 1/2 established inputModalities; a probe result arriving in
    // the same call must not stomp it.
    const { capabilities, capabilitySources } = mergeCapabilities(
      {
        providerMeta: { inputModalities: ["text", "image"] },
        probes: { inputModalities: ["text"] },
      },
      {}
    );
    expect(capabilities.inputModalities).toEqual(["text", "image"]);
    expect(capabilitySources.inputModalities).toBe("provider-metadata");
  });

  it("probes DO fill a modality list when no earlier layer provided it", () => {
    const { capabilities, capabilitySources } = mergeCapabilities(
      { probes: { inputModalities: ["text", "image"] } },
      {}
    );
    expect(capabilities.inputModalities).toEqual(["text", "image"]);
    expect(capabilitySources.inputModalities).toBe("live-probe");
  });
});
