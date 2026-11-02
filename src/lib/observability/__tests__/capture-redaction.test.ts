import { describe, it, expect } from "vitest";
import { redactSecrets } from "@/lib/observability/capture";

describe("redactSecrets", () => {
  it("redacts Bearer tokens", () => {
    expect(redactSecrets("Authorization: Bearer abc123def456")).toBe(
      "Authorization: Bearer [REDACTED]"
    );
  });

  it("redacts token= assignments", () => {
    expect(redactSecrets("token=ghp_verylongsecretvalue123456")).toBe(
      "token=[REDACTED]"
    );
  });

  it("redacts client_secret values", () => {
    expect(redactSecrets('client_secret: "supersecretvalue0000000000"')).toBe(
      'client_secret: "[REDACTED]"'
    );
  });

  it("redacts JWT-shaped blobs", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNa6cTZpfLRQjoHQ";
    expect(redactSecrets(`got ${jwt} back`)).toBe("got [REDACTED] back");
  });

  it("leaves non-secret text intact", () => {
    expect(redactSecrets("server started on port 2302")).toBe(
      "server started on port 2302"
    );
  });
});
