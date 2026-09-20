/**
 * Live evaluation runner: drives a real Projects chat session, captures the
 * SSE stream, and applies the same judges used in offline mode.
 *
 * The network layer is abstracted behind {@link HarnessTransport} so the
 * runner can be unit-tested with a mock transport (no server required) while
 * the production path uses {@link FetchTransport} against a running dev server.
 */
import type { Scenario, EvaluationResult, UiMessageChunk } from "./contracts";
import { parseUiMessageStream, drainStreamToText } from "./parse-stream";
import { computeMetrics } from "./metrics";
import { prepareFixture, cleanupFixtures } from "./evaluate";

export interface ChatRequestBody {
  projectId: string;
  sessionId: string;
  messages: unknown[];
  model?: string;
  effort?: string;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: ReadableStream<Uint8Array>;
}

/**
 * Abstract transport for talking to the Projects API. Implementations must
 * be injectable so tests can mock the server without touching the network.
 */
export interface HarnessTransport {
  createProject(input: {
    name: string;
    mode: "existing";
    directoryPath: string;
  }): Promise<{ id: string; directoryPath: string }>;
  setTrusted(projectId: string, trusted: boolean): Promise<void>;
  createSession(projectId: string, title: string): Promise<{ id: string }>;
  chat(
    projectId: string,
    sessionId: string,
    body: ChatRequestBody
  ): Promise<HttpResponse>;
  deleteProject(projectId: string): Promise<void>;
}

/**
 * Validates that a URL targets the loopback interface. The harness MUST only
 * talk to localhost — a production endpoint is a configuration error, not a
 * network call we should attempt.
 */
export function assertLoopbackUrl(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname;
  // Accept only the standard loopback hostnames: 127.0.0.1, ::1, [::1],
  // and localhost. Subdomains of .localhost are NOT accepted — the guard
  // (src/app/api/projects/guard.ts) only allows these exact hostnames, so
  // the harness must match to avoid a 403 on live runs.
  if (
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "localhost"
  ) {
    return;
  }
  throw new Error(
    `Refusing to connect to non-loopback host "${host}" — the eval harness may only target localhost.`
  );
}

/** Production transport backed by `fetch`. */
export class FetchTransport implements HarnessTransport {
  readonly baseUrl: string;
  readonly headers: Record<string, string>;

  constructor(baseUrl: string, headers: Record<string, string> = {}) {
    assertLoopbackUrl(baseUrl);
    this.baseUrl = baseUrl;
    this.headers = headers;
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const url = new URL(pathname, this.baseUrl);
    const headers: Record<string, string> = {
      ...this.headers,
      ...(init.headers as Record<string, string> | undefined),
    };
    // The guard (src/app/api/projects/guard.ts) requires Content-Type:
    // application/json on POST requests. Add it automatically when a body
    // is present and no explicit content-type was set.
    if (init.body && !headers["content-type"] && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    // Set the Origin header to the base URL origin so the guard's CSRF
    // validation passes (it checks that the Origin hostname is loopback).
    if (!headers["origin"]) {
      headers["Origin"] = new URL(this.baseUrl).origin;
    }
    const res = await fetch(url, { ...init, headers });
    if (!res.ok) {
      let detail = "";
      try {
        detail = await res.text();
      } catch {
        /* ignore */
      }
      throw new Error(
        `HTTP ${res.status} ${res.statusText} for ${url}: ${detail.slice(0, 500)}`
      );
    }
    return res;
  }

  async createProject(input: {
    name: string;
    mode: "existing";
    directoryPath: string;
  }): Promise<{ id: string; directoryPath: string }> {
    const res = await this.request("/api/projects", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const data = (await res.json()) as { id: string; directoryPath: string };
    return data;
  }

  async setTrusted(projectId: string, trusted: boolean): Promise<void> {
    await this.request(`/api/projects/${projectId}/trust`, {
      method: "POST",
      body: JSON.stringify({ trusted }),
    });
  }

  async createSession(projectId: string, title: string): Promise<{ id: string }> {
    const res = await this.request(
      `/api/projects/${projectId}/sessions`,
      {
        method: "POST",
        body: JSON.stringify({ title }),
      }
    );
    const data = (await res.json()) as { id: string };
    return data;
  }

  async chat(
    projectId: string,
    sessionId: string,
    body: ChatRequestBody
  ): Promise<HttpResponse> {
    const res = await this.request("/api/projects/chat", {
      method: "POST",
      headers: { Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: res.status,
      headers,
      body: res.body as ReadableStream<Uint8Array>,
    };
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.request(`/api/projects/${projectId}`, { method: "DELETE" });
  }
}

/**
 * Runs a single scenario against a live server, capturing the SSE stream and
 * applying the scenario's judge.
 *
 * The fixture directory is prepared (and torn down) by this function. The
 * project created on the server is always cleaned up — even on error — to
 * avoid leaking state between runs.
 */
export async function runScenarioLive(
  scenario: Scenario,
  transport: HarnessTransport,
  opts: {
    baseDir: string;
    model?: string;
    effort?: "low" | "medium" | "high";
    timeoutMs?: number;
  }
): Promise<{ result: EvaluationResult; fixtureRoot: string; sseText: string }> {
  const fixtureRoot = await prepareFixture(scenario, opts.baseDir);
  const project = await transport.createProject({
    name: `eval-${scenario.id}`,
    mode: "existing",
    directoryPath: fixtureRoot,
  });
  const projectId = project.id;

  let cleanupDone = false;
  const cleanup = async () => {
    if (cleanupDone) return;
    cleanupDone = true;
    try {
      await transport.deleteProject(projectId);
    } catch (err) {
      // Log but never throw — cleanup errors must not mask the real result.
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[eval-harness] cleanup: failed to delete project ${projectId}: ${msg}`);
    }
  };

  // SIGINT/SIGTERM handling: ensure the project is cleaned up if the process
  // is interrupted mid-run. The signal listeners are removed once the run
  // completes normally (success or failure).
  const onSignal = async () => {
    await cleanup();
    process.exit(1);
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    // Trust the project so the agent can execute file operations.
    // Honors the per-scenario `trusted` flag (default true).
    const trusted = scenario.trusted ?? true;
    if (trusted) {
      await transport.setTrusted(projectId, true);
    }
    const session = await transport.createSession(projectId, `eval-${scenario.id}`);

    const body: ChatRequestBody = {
      projectId,
      sessionId: session.id,
      messages: [
        { role: "system", parts: [{ type: "text", text: "You are a coding agent." }] },
        {
          role: "user",
          parts: [{ type: "text", text: scenario.prompt }],
        },
      ],
      model: opts.model,
      effort: opts.effort,
    };

    const response = await transport.chat(projectId, session.id, body);
    const sseText = await drainStreamToText(response.body);

    const chunks = parseUiMessageStream(sseText);
    const metrics = computeMetrics(chunks);
    const judgeResult = await scenario.judge({
      metrics,
      fixtureRoot,
      expected: scenario.expectedFiles ?? [],
    });

    const result: EvaluationResult = {
      ...judgeResult,
      metrics: judgeResult.metrics ?? metrics,
    };
    return { result, fixtureRoot, sseText };
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await cleanup();
  }
}

/**
 * Runs all scenarios against a live server and returns the results.
 * Continues past individual failures so a full report is produced.
 */
export async function runAllLive(
  scenarios: Scenario[],
  transport: HarnessTransport,
  opts: { baseDir: string; model?: string; effort?: "low" | "medium" | "high" }
): Promise<EvaluationResult[]> {
  const results: EvaluationResult[] = [];
  for (const scenario of scenarios) {
    try {
      const { result } = await runScenarioLive(scenario, transport, opts);
      results.push(result);
    } catch (err) {
      results.push({
        scenarioId: scenario.id,
        verdict: "error",
        reason: `Runner failed: ${err instanceof Error ? err.message : String(err)}`,
        metrics: null,
        detail: {},
      });
    }
  }
  await cleanupFixtures(opts.baseDir);
  return results;
}

// Re-export for convenience.
export { parseUiMessageStream, computeMetrics, drainStreamToText };
export type { UiMessageChunk };
