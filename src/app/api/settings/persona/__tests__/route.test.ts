import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db";
import { settings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { GET, PUT } from "@/app/api/settings/persona/route";
import { POST as POST_RESET } from "@/app/api/settings/persona/reset/route";
import { DEFAULT_SYSTEM_PERSONA } from "@/lib/persona/types";

describe("/api/settings/persona", () => {
  beforeEach(async () => {
    await db.delete(settings).where(eq(settings.key, "system_persona"));
  });

  it("GET returns current persona and default persona", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.persona).toEqual(DEFAULT_SYSTEM_PERSONA);
    expect(data.defaultPersona).toEqual(DEFAULT_SYSTEM_PERSONA);
  });

  it("PUT updates persona with valid input and returns 200", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "DevOps Engineer",
        instructions: "Focus on CI/CD pipelines, Dockerfiles, and bash scripts.",
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.persona.name).toBe("DevOps Engineer");
    expect(data.persona.instructions).toBe("Focus on CI/CD pipelines, Dockerfiles, and bash scripts.");
  });

  it("PUT accepts empty instructions and resolves gracefully", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Blank Instructions",
        instructions: "",
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.persona.name).toBe("Blank Instructions");
    expect(data.persona.instructions).toBe("");
  });

  it("PUT returns 400 when instructions exceed length limit", async () => {
    const req = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        instructions: "x".repeat(10_001),
      }),
    });

    const res = await PUT(req);
    expect(res.status).toBe(400);
  });

  it("POST /reset resets persona back to default", async () => {
    // First save a customized persona
    const updateReq = new Request("http://localhost/api/settings/persona", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Custom",
        instructions: "Custom text",
      }),
    });
    await PUT(updateReq);

    // Call reset
    const resetRes = await POST_RESET();
    expect(resetRes.status).toBe(200);
    const resetData = await resetRes.json();
    expect(resetData.success).toBe(true);
    expect(resetData.persona.name).toBe(DEFAULT_SYSTEM_PERSONA.name);
    expect(resetData.persona.instructions).toBe(DEFAULT_SYSTEM_PERSONA.instructions);
  });
});
