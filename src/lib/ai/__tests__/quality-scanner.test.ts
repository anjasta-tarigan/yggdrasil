import { describe, it, expect } from "vitest";
import { evaluateMessageQuality } from "@/lib/ai/pipeline/quality-scanner";

describe("Internal Quality & Anti-Slop Scanner", () => {
  it("bypasses short turns (pings, brief greetings, simple answers) without displaying indicator", () => {
    const ping = "Pong! All systems operational.";
    const report1 = evaluateMessageQuality(ping);
    expect(report1.shouldDisplay).toBe(false);

    const greeting = "Hello! How can I help you today?";
    const report2 = evaluateMessageQuality(greeting);
    expect(report2.shouldDisplay).toBe(false);

    const shortCode = "The port is 3000.";
    const report3 = evaluateMessageQuality(shortCode);
    expect(report3.shouldDisplay).toBe(false);
  });

  it("evaluates substantial factual prose as clean and high signal", () => {
    const text = `To run SQLite in WAL mode with Node.js and better-sqlite3:

1. Open your database connection synchronously.
2. Run PRAGMA journal_mode = WAL immediately after initialization.
3. This ensures concurrent read operations do not block ongoing writes.
4. Always verify that foreign keys are enabled using PRAGMA foreign_keys = ON.
5. Set busy_timeout to 5000 to handle contention during concurrent write bursts.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.tier).toBe("clean");
    expect(report.score).toBeLessThanOrEqual(15);
    expect(report.flaggedPatterns.length).toBe(0);
  });

  it("detects tier 1 AI buzzwords and promotional fluff", () => {
    const text = `In this multifaceted tapestry of software architecture, we must delve deeply into the intricate nuances that stand as a testament to our bedrock engineering principles. By doing so, we foster growth and unleash unprecedented synergy across the entire ecosystem, navigating the complexities of modern engineering.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(40);
    expect(report.flaggedPatterns).toContain("delve");
    expect(report.flaggedPatterns).toContain("tapestry");
  });

  it("detects code defect patterns such as empty catch blocks", () => {
    const textWithCode = `Here is how you handle the query safely:

\`\`\`typescript
async function fetchUser(id: string) {
  try {
    const res = await api.get('/users/' + id);
    return res.data;
  } catch (err) {
  }
}
\`\`\`
This ensures the error is caught during execution.`;

    const report = evaluateMessageQuality(textWithCode);
    expect(report.shouldDisplay).toBe(true);
    expect(report.codeIssues).toContain("Empty catch block (silent error suppression)");
  });

  it("detects structural clichés and sycophantic openers", () => {
    const text = `Great question! You raise a really interesting point. It's not just a caching layer, it's a game-changer for latency. In today's fast-paced world, only time will tell how this architecture scales.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("sycophantic opener");
    expect(report.flaggedPatterns).toContain("theatrical contrast (not just X, it's Y)");
  });

  it("does not flag banned words inside markdown link targets", () => {
    const text = `For more info, see [the tapestry docs](https://tapestry.example.com/framework).
  The server runs on port 3000 and accepts connections from the local network adapter.
  This is the standard configuration for the development environment and it works well
  across all supported platforms without any additional setup steps required here.`;
    const report = evaluateMessageQuality(text);
    expect(report.flaggedPatterns).not.toContain("tapestry");
  });
});
