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

  it("detects Tier 3 light signals when clustered", () => {
    const text = `To address the problem, we should additionally consider the available options and weigh all factors carefully before making a decision.
    Furthermore, the solution is significantly more complex than it initially appears to most observers in the field.
    Consequently, we must enhance our approach to ensure optimal results across all deployment environments.
    Ultimately, the best strategy is to pivot toward a more pragmatic approach that balances risk and reward.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("additionally");
    expect(report.flaggedPatterns).toContain("furthermore");
    expect(report.flaggedPatterns).toContain("consequently");
  });

  it("does not flag Tier 3 words when sparsely used (bypass threshold)", () => {
    const text = `The server runs on port 3000. This is crucial for the deployment.`;
    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(false);
  });

  it("detects buzzword collocations (phrases beat words)", () => {
    const text = `We built a robust framework that delivers meaningful results across the digital landscape and helps our team grow.
    This multifaceted approach leverages continuous improvement and a holistic approach to drive key drivers of innovation throughout the engineering organization as we scale.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain("robust ___");
    expect(report.flaggedPatterns).toContain("meaningful ___");
    expect(report.flaggedPatterns).toContain("digital ___");
    expect(report.flaggedPatterns).toContain("multifaceted ___");
    expect(report.flaggedPatterns).toContain("continuous ___");
    expect(report.flaggedPatterns).toContain("holistic ___");
    expect(report.flaggedPatterns).toContain("key driver");
  });

  it("detects paragraph opener cadence (same connective starting paragraphs)", () => {
    const text = `First, we need to understand the basics of the system architecture.

    Additionally, the system requires proper configuration of all environment variables.

    Additionally, we must verify the installation path matches the expected location.

    Additionally, the firewall settings need to be checked before deployment.

    Additionally, the database connection must be established with the correct credentials.`;

    const report = evaluateMessageQuality(text);
    expect(report.shouldDisplay).toBe(true);
    expect(report.flaggedPatterns).toContain(
      "paragraph opener cadence (4+ paragraphs with same leading connective)"
    );
  });

  it("weights structural patterns higher than vocabulary hits", () => {
    // 1 structural + 1 Tier 1 + 2 Tier 2
    const textA = `In a recent tapestry of events, it's not just about the code, it's about the journey we have undertaken.
    This multifaceted approach underscores our dedication to excellence and leveraging best practices across all engineering teams and organizations.`;
    const reportA = evaluateMessageQuality(textA);

    // Same number of hits, but all Tier 2 — no structural pattern
    const textB = `This robust solution is seamless and comprehensive across all platforms and environments.
    The work is truly remarkable and exceptional in ways we could never have imagined before.
    Additionally, the pivotal nature of this approach is fundamentally important to consider for future projects.`;
    const reportB = evaluateMessageQuality(textB);

    // textA has structural pattern weight (3× effective) + Tier 1, so should score higher
    expect(reportA.score).toBeGreaterThan(reportB.score);
  });
});
