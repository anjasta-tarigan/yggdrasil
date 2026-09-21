/**
 * Fake-server tests using `node:http`.
 *
 * Spins up a minimal HTTP server that implements the Projects API surface
 * (matching the guard logic in `src/app/api/projects/guard.ts`) and drives
 * `FetchTransport` against it end-to-end. This validates the transport's
 * HTTP calls, header handling, SSE parsing, and error propagation without
 * needing a running Next.js dev server.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import * as path from "node:path";
import * as os from "node:os";
import {
  FetchTransport,
  runScenarioLive,
  runAllLive,
} from "../run";
import type { StoredProject } from "../run";
import { SCENARIO_T0_AGENTIC_SUCCESS, SCENARIO_T1_CHAT_FAILURE } from "../selftest-scenarios";
import { TRANSCRIPT_T0_AGENTIC_SUCCESS, TRANSCRIPT_T1_CHAT_FAILURE } from "../transcripts";
import { parseUiMessageStream, drainStreamToText } from "../parse-stream";
import { computeMetrics } from "../metrics";
import { cleanupFixtures } from "../evaluate";

/** Records every request the fake server receives. */
interface RequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Configuration for the fake server's behaviour. */
interface FakeServerConfig {
  /** SSE transcript to return from the chat endpoint. */
  chatTranscript?: string;
  /** Function to dynamically determine the chat transcript from the request body. */
  chatTranscriptFn?: (body: unknown) => string;
  /** HTTP status to return from the chat endpoint (non-200 for error tests). */
  chatStatus?: number;
  /** HTTP status to return from create-project (non-201 for error tests). */
  createProjectStatus?: number;
  /** Whether to enforce Content-Type: application/json on POST (guard behavior). */
  enforceContentType?: boolean;
  /** Custom handler for a specific path/method, returning (status, body). */
  override?: (method: string, url: string, body: unknown) => { status: number; body: unknown } | null;
}

/** State shared between the test and the fake server. */
interface FakeServerState {
  config: FakeServerConfig;
  requests: RequestRecord[];
  projects: Map<string, StoredProject>;
  sessions: Map<string, { id: string; projectId: string }>;
}

/** Reads the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let chunks = "";
    req.on("data", (chunk) => {
      chunks += chunk;
    });
    req.on("end", () => resolve(chunks));
  });
}

/**
 * Guards a request the same way `src/app/api/projects/guard.ts` does:
 * - Rejects POST/PATCH without `Content-Type: application/json` (415).
 * - Rejects non-loopback Origin on mutating requests (403).
 * Returns an error message string if the request should be rejected, or
 * null if it passes.
 */
function guardRequest(
  method: string,
  headers: Record<string, string>,
  config: FakeServerConfig
): string | null {
  const isMutating = ["POST", "PATCH", "DELETE", "PUT"].includes(method);
  if (!isMutating) return null;

  // Content-Type validation (matches guard.ts).
  if (config.enforceContentType !== false) {
    const contentType = headers["content-type"] ?? headers["Content-Type"];
    const expectsBody = method === "POST" || method === "PATCH";
    if (expectsBody) {
      if (!contentType || !contentType.toLowerCase().includes("application/json")) {
        return "Content-Type must be application/json";
      }
    }
  }

  // Origin validation (matches guard.ts — only if Origin is present).
  const origin = headers["origin"] ?? headers["Origin"];
  if (origin) {
    try {
      const url = new URL(origin);
      const hostname = url.hostname.toLowerCase();
      const isLoopback =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1" ||
        hostname === "[::1]";
      if (!isLoopback) {
        return "Forbidden: invalid origin";
      }
    } catch {
      return "Forbidden: invalid origin";
    }
  }

  return null;
}

/**
 * Creates a fake HTTP server that implements the Projects API endpoints.
 * The server matches the guard logic from `src/app/api/projects/guard.ts`.
 */
function createFakeServer(state: FakeServerState): Server {
  return http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const rawUrl = req.url ?? "/";
    const method = req.method ?? "GET";
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = Array.isArray(value) ? value.join(", ") : value ?? "";
    }

    const bodyText = await readBody(req);
    let parsedBody: unknown = undefined;
    if (bodyText) {
      try {
        parsedBody = JSON.parse(bodyText);
      } catch {
        parsedBody = bodyText;
      }
    }

    // Record the request for assertions.
    state.requests.push({ method, url: rawUrl, headers, body: parsedBody });

    // Apply guard.
    const guardError = guardRequest(method, headers, state.config);
    if (guardError) {
      const status = guardError.startsWith("Content-Type") ? 415 : 403;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: guardError }));
      return;
    }

    // Check for override.
    if (state.config.override) {
      const override = state.config.override(method, rawUrl, parsedBody);
      if (override) {
        res.writeHead(override.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(override.body));
        return;
      }
    }

    // Route: POST /api/projects — create project.
    if (method === "POST" && rawUrl === "/api/projects") {
      if (state.config.createProjectStatus && state.config.createProjectStatus !== 201) {
        res.writeHead(state.config.createProjectStatus, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Failed to create project" }));
        return;
      }
      const payload = parsedBody as { name?: string; mode?: string; directoryPath?: string };
      const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const dirPath = payload.directoryPath ?? `/tmp/eval-${projectId}`;
      state.projects.set(projectId, { id: projectId, name: payload.name ?? "unnamed", directoryPath: dirPath });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: projectId, directoryPath: dirPath }));
      return;
    }

    // Route: GET /api/projects — list all projects.
    if (method === "GET" && rawUrl === "/api/projects") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(Array.from(state.projects.values())));
      return;
    }

    // Route: POST /api/projects/:id/trust — set trusted.
    if (method === "POST" && rawUrl.match(/^\/api\/projects\/[^/]+\/trust$/)) {
      const projectId = rawUrl.split("/")[3]!;
      if (!state.projects.has(projectId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Project not found" }));
        return;
      }
      const payload = parsedBody as { trusted?: boolean };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: projectId, trusted: payload.trusted }));
      return;
    }

    // Route: POST /api/projects/:id/sessions — create session.
    if (method === "POST" && rawUrl.match(/^\/api\/projects\/[^/]+\/sessions$/)) {
      const projectId = rawUrl.split("/")[3]!;
      if (!state.projects.has(projectId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Project not found" }));
        return;
      }
      const payload = parsedBody as { title?: string };
      const sessionId = `psess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      state.sessions.set(sessionId, { id: sessionId, projectId });
      res.writeHead(201, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: sessionId, projectId, title: payload.title ?? "New Session" }));
      return;
    }

    // Route: POST /api/projects/chat — chat (SSE stream).
    if (method === "POST" && rawUrl === "/api/projects/chat") {
      const status = state.config.chatStatus ?? 200;
      if (status !== 200) {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Chat failed" }));
        return;
      }
      const transcript = state.config.chatTranscriptFn?.(parsedBody) ?? state.config.chatTranscript ?? TRANSCRIPT_T0_AGENTIC_SUCCESS;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.end(transcript);
      return;
    }

    // Route: DELETE /api/projects/:id — delete project.
    if (method === "DELETE" && rawUrl.match(/^\/api\/projects\/[^/]+$/)) {
      const projectId = rawUrl.split("/")[3]!;
      if (!state.projects.has(projectId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Project not found" }));
        return;
      }
      state.projects.delete(projectId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // Route: GET /api/projects/:id — get project (for verification).
    if (method === "GET" && rawUrl.match(/^\/api\/projects\/[^/]+$/)) {
      const projectId = rawUrl.split("/")[3]!;
      const project = state.projects.get(projectId);
      if (!project) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Project not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(project));
      return;
    }

    // Default: 404.
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });
}

/**
 * Starts a fake server on a random loopback port and returns the server
 * instance plus its base URL.
 */
function startFakeServer(config: FakeServerConfig = {}): Promise<{
  server: Server;
  baseUrl: string;
  state: FakeServerState;
}> {
  return new Promise((resolve) => {
    const state: FakeServerState = {
      config,
      requests: [],
      projects: new Map(),
      sessions: new Map(),
    };
    const server = createFakeServer(state);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("Server address is not a TCP address");
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({ server, baseUrl, state });
    });
  });
}

/** Stops a fake server and waits for it to close. */
function stopFakeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

const baseDir = path.join(os.tmpdir(), `evals-fake-server-${process.pid}-${Date.now()}`);

afterEach(async () => {
  await cleanupFixtures(baseDir);
});

describe("FetchTransport against fake server", () => {
  let server: Server;
  let baseUrl: string;
  let state: FakeServerState;

  beforeEach(async () => {
    const result = await startFakeServer();
    server = result.server;
    baseUrl = result.baseUrl;
    state = result.state;
  });

  afterEach(async () => {
    await stopFakeServer(server);
  });

  it("createProject sends POST /api/projects with Content-Type: application/json and parses the response", async () => {
    const transport = new FetchTransport(baseUrl);
    const result = await transport.createProject({
      name: "test-project",
      mode: "existing",
      directoryPath: "/tmp/test-project",
    });

    expect(result.id).toMatch(/^proj_/);
    expect(result.directoryPath).toBe("/tmp/test-project");

    // Verify the request was recorded.
    expect(state.requests).toHaveLength(1);
    const req = state.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/projects");
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.headers["origin"]).toBe(baseUrl);
    expect(req.body).toEqual({
      name: "test-project",
      mode: "existing",
      directoryPath: "/tmp/test-project",
    });
  });

  it("setTrusted sends POST /api/projects/:id/trust with the trusted flag", async () => {
    const transport = new FetchTransport(baseUrl);
    // Create a project first.
    const project = await transport.createProject({
      name: "test",
      mode: "existing",
      directoryPath: "/tmp/test",
    });

    await transport.setTrusted(project.id, true);

    // Find the trust request.
    const trustReq = state.requests.find(
      (r) => r.method === "POST" && r.url === `/api/projects/${project.id}/trust`
    );
    expect(trustReq).toBeDefined();
    expect(trustReq!.body).toEqual({ trusted: true });
  });

  it("createSession sends POST /api/projects/:id/sessions and parses the session id", async () => {
    const transport = new FetchTransport(baseUrl);
    const project = await transport.createProject({
      name: "test",
      mode: "existing",
      directoryPath: "/tmp/test",
    });

    const session = await transport.createSession(project.id, "eval-T0");
    expect(session.id).toMatch(/^psess_/);

    const sessionReq = state.requests.find(
      (r) => r.method === "POST" && r.url === `/api/projects/${project.id}/sessions`
    );
    expect(sessionReq).toBeDefined();
    expect(sessionReq!.body).toEqual({ title: "eval-T0" });
  });

  it("chat sends POST /api/projects/chat with Accept: text/event-stream and Content-Type: application/json", async () => {
    const transport = new FetchTransport(baseUrl);
    const project = await transport.createProject({
      name: "test",
      mode: "existing",
      directoryPath: "/tmp/test",
    });
    const session = await transport.createSession(project.id, "eval-T0");

    const response = await transport.chat(project.id, session.id, {
      projectId: project.id,
      sessionId: session.id,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Write marker.txt" }] },
      ],
      model: "server::gpt-4o",
      effort: "high",
    });

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("text/event-stream");

    const chatReq = state.requests.find(
      (r) => r.method === "POST" && r.url === "/api/projects/chat"
    );
    expect(chatReq).toBeDefined();
    expect(chatReq!.headers["content-type"]).toContain("application/json");
    expect(chatReq!.headers["accept"]).toBe("text/event-stream");
    expect(chatReq!.body).toEqual({
      projectId: project.id,
      sessionId: session.id,
      messages: [
        { role: "user", parts: [{ type: "text", text: "Write marker.txt" }] },
      ],
      model: "server::gpt-4o",
      effort: "high",
    });
  });

  it("deleteProject sends DELETE /api/projects/:id", async () => {
    const transport = new FetchTransport(baseUrl);
    const project = await transport.createProject({
      name: "test",
      mode: "existing",
      directoryPath: "/tmp/test",
    });

    await transport.deleteProject(project.id);

    const deleteReq = state.requests.find(
      (r) => r.method === "DELETE" && r.url === `/api/projects/${project.id}`
    );
    expect(deleteReq).toBeDefined();
    expect(state.projects.has(project.id)).toBe(false);
  });

  it("chat SSE stream is parseable by parseUiMessageStream", async () => {
    const transport = new FetchTransport(baseUrl);
    const project = await transport.createProject({
      name: "test",
      mode: "existing",
      directoryPath: "/tmp/test",
    });
    const session = await transport.createSession(project.id, "eval-S0");

    const response = await transport.chat(project.id, session.id, {
      projectId: project.id,
      sessionId: session.id,
      messages: [{ role: "user", parts: [{ type: "text", text: "Hi" }] }],
    });

    // Drain the SSE stream.
    const sseText = await drainStreamToText(response.body);

    // Parse and verify.
    const chunks = parseUiMessageStream(sseText);
    expect(chunks.length).toBeGreaterThan(0);
    const metrics = computeMetrics(chunks);
    expect(metrics.steps).toBe(1);
    expect(metrics.toolCalls).toHaveLength(1);
    expect(metrics.toolCalls[0]!.name).toBe("file_operations");
    expect(metrics.finishReason).toBe("stop");
  });

  it("throws on 404 when creating a session for a non-existent project", async () => {
    const transport = new FetchTransport(baseUrl);
    await expect(
      transport.createSession("nonexistent-project", "test")
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws on 415 when Content-Type is missing (guard enforcement)", async () => {
    // Create a transport with the guard enforcement enabled.
    const { server: srv, baseUrl: url, state: st } = await startFakeServer({
      enforceContentType: true,
    });
    // Override the transport to not send Content-Type by using a raw fetch.
    const res = await fetch(`${url}/api/projects`, {
      method: "POST",
      body: JSON.stringify({ name: "test", mode: "existing", directoryPath: "/tmp/test" }),
      // Intentionally omit Content-Type.
    });
    expect(res.status).toBe(415);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Content-Type must be application/json");
    await stopFakeServer(srv);
    void st; // suppress unused warning
  });

  it("throws on 403 when Origin is non-loopback (guard enforcement)", async () => {
    const { server: srv, baseUrl: url } = await startFakeServer({
      enforceContentType: true,
    });
    const res = await fetch(`${url}/api/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://evil.example.com",
      },
      body: JSON.stringify({ name: "test", mode: "existing", directoryPath: "/tmp/test" }),
    });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error: string };
    expect(data.error).toBe("Forbidden: invalid origin");
    await stopFakeServer(srv);
  });

  it("chat error response (500) is propagated as a thrown error", async () => {
    const { server: srv, baseUrl: url } = await startFakeServer({
      chatStatus: 500,
    });
    const transport = new FetchTransport(url);
    await expect(
      transport.chat("proj_1", "sess_1", {
        projectId: "proj_1",
        sessionId: "sess_1",
        messages: [],
      })
    ).rejects.toThrow(/HTTP 500/);
    await stopFakeServer(srv);
  });

  it("createProject error response (400) is propagated as a thrown error", async () => {
    const { server: srv, baseUrl: url } = await startFakeServer({
      createProjectStatus: 400,
    });
    const transport = new FetchTransport(url);
    await expect(
      transport.createProject({ name: "test", mode: "existing", directoryPath: "/tmp/test" })
    ).rejects.toThrow(/HTTP 400/);
    await stopFakeServer(srv);
  });

  it("transport throws on connection refused to a dead port", async () => {
    const transport = new FetchTransport("http://127.0.0.1:1");
    await expect(
      transport.createProject({ name: "test", mode: "existing", directoryPath: "/tmp/test" })
    ).rejects.toThrow();
  });
});

describe("runScenarioLive against fake server", () => {
  let server: Server;
  let baseUrl: string;
  let state: FakeServerState;

  beforeEach(async () => {
    const result = await startFakeServer({ chatTranscript: TRANSCRIPT_T0_AGENTIC_SUCCESS });
    server = result.server;
    baseUrl = result.baseUrl;
    state = result.state;
  });

  afterEach(async () => {
    await stopFakeServer(server);
    await cleanupFixtures(baseDir);
  });

  it("runs T0 end-to-end: create project, trust, session, chat, judge, delete", async () => {
    const transport = new FetchTransport(baseUrl);
    const { result, sseText } = await runScenarioLive(SCENARIO_T0_AGENTIC_SUCCESS, transport, {
      baseDir,
    });

    // Verify the SSE stream was captured.
    expect(sseText).toContain("data: {\"type\":\"start\"");
    expect(sseText).toContain("data: [DONE]");

    // Verify the judge ran (T0 fails because the fake server doesn't write
    // marker.txt to disk — ground-truth check fails, which is expected).
    expect(result.scenarioId).toBe("T0");
    expect(result.verdict).toBe("fail");
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.toolCalls).toHaveLength(1);
    expect(result.metrics!.toolCalls[0]!.name).toBe("file_operations");

    // Verify all 5 endpoints were called.
    const methods = state.requests.map((r) => r.method);
    expect(methods).toContain("POST"); // createProject, setTrusted, createSession, chat
    expect(methods).toContain("DELETE"); // deleteProject

    // Verify the project was cleaned up.
    expect(state.projects.size).toBe(0);
  });

  it("runs T1 (chat failure) end-to-end and detects no tool calls", async () => {
    // Reconfigure the server to return the chat-failure transcript.
    state.config.chatTranscript = TRANSCRIPT_T1_CHAT_FAILURE;

    const transport = new FetchTransport(baseUrl);
    const { result } = await runScenarioLive(SCENARIO_T1_CHAT_FAILURE, transport, {
      baseDir,
    });

    expect(result.scenarioId).toBe("T1");
    expect(result.verdict).toBe("fail");
    expect(result.metrics).not.toBeNull();
    expect(result.metrics!.toolCalls).toHaveLength(0);
    expect(result.metrics!.hadError).toBe(false);
  });

  it("propagates chat errors as a thrown error from runScenarioLive", async () => {
    state.config.chatStatus = 500;

    const transport = new FetchTransport(baseUrl);
    await expect(
      runScenarioLive(SCENARIO_T0_AGENTIC_SUCCESS, transport, { baseDir })
    ).rejects.toThrow(/HTTP 500/);

    // The project should still have been cleaned up (finally block).
    expect(state.projects.size).toBe(0);
  });

  it("runAllLive runs multiple scenarios against the fake server", async () => {
    // Alternate transcripts: T0 gets AGENTIC_SUCCESS (1 tool call), T1 gets CHAT_FAILURE (0 tool calls).
    let chatCallCount = 0;
    state.config.chatTranscriptFn = () => {
      const transcript = chatCallCount === 0 ? TRANSCRIPT_T0_AGENTIC_SUCCESS : TRANSCRIPT_T1_CHAT_FAILURE;
      chatCallCount++;
      return transcript;
    };

    const transport = new FetchTransport(baseUrl);
    const results = await runAllLive(
      [SCENARIO_T0_AGENTIC_SUCCESS, SCENARIO_T1_CHAT_FAILURE],
      transport,
      { baseDir }
    );

    expect(results).toHaveLength(2);
    // Both fail because the fake server doesn't write files to disk.
    expect(results[0].verdict).toBe("fail");
    expect(results[1].verdict).toBe("fail");
    expect(results[0].metrics!.toolCalls).toHaveLength(1); // T0 has one tool call
    expect(results[1].metrics!.toolCalls).toHaveLength(0); // T1 has no tool calls
  });

  it("honors the trusted flag — setTrusted is called when trusted is true", async () => {
    const transport = new FetchTransport(baseUrl);
    await runScenarioLive(SCENARIO_T0_AGENTIC_SUCCESS, transport, { baseDir });

    const trustReq = state.requests.find(
      (r) => r.method === "POST" && r.url?.includes("/trust")
    );
    expect(trustReq).toBeDefined();
    expect(trustReq!.body).toEqual({ trusted: true });
  });

  it("skips setTrusted when scenario.trusted is false", async () => {
    const scenario = { ...SCENARIO_T0_AGENTIC_SUCCESS, trusted: false };
    const transport = new FetchTransport(baseUrl);
    await runScenarioLive(scenario, transport, { baseDir });

    const trustReq = state.requests.find(
      (r) => r.method === "POST" && r.url?.includes("/trust")
    );
    expect(trustReq).toBeUndefined();
  });

  it("passes the model and effort to the chat endpoint", async () => {
    const transport = new FetchTransport(baseUrl);
    await runScenarioLive(SCENARIO_T0_AGENTIC_SUCCESS, transport, {
      baseDir,
      model: "server::gpt-4o",
      effort: "high",
    });

    const chatReq = state.requests.find(
      (r) => r.method === "POST" && r.url === "/api/projects/chat"
    );
    expect(chatReq).toBeDefined();
    const body = chatReq!.body as {
      model?: string;
      effort?: string;
      messages: Array<{ role: string; parts: unknown[] }>;
    };
    expect(body.model).toBe("server::gpt-4o");
    expect(body.effort).toBe("high");
    // The messages array must contain exactly one user message — no system message.
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]!.role).toBe("user");
  });
});

describe("FetchTransport header validation", () => {
  let server: Server;
  let baseUrl: string;
  let state: FakeServerState;

  beforeEach(async () => {
    const result = await startFakeServer({ enforceContentType: true });
    server = result.server;
    baseUrl = result.baseUrl;
    state = result.state;
  });

  afterEach(async () => {
    await stopFakeServer(server);
  });

  it("sends Content-Type: application/json on all POST requests", async () => {
    const transport = new FetchTransport(baseUrl);
    const project = await transport.createProject({ name: "t", mode: "existing", directoryPath: "/tmp/t" });
    const session = await transport.createSession(project.id, "test");
    await transport.setTrusted(project.id, true);
    await transport.chat(project.id, session.id, {
      projectId: project.id,
      sessionId: session.id,
      messages: [],
    });

    // Every POST request should have Content-Type: application/json.
    const postRequests = state.requests.filter((r) => r.method === "POST");
    expect(postRequests.length).toBeGreaterThan(0);
    for (const req of postRequests) {
      expect(req.headers["content-type"]).toContain("application/json");
    }
  });

  it("sends Origin header matching the base URL origin", async () => {
    const transport = new FetchTransport(baseUrl);
    await transport.createProject({ name: "t", mode: "existing", directoryPath: "/tmp/t" });

    const req = state.requests[0]!;
    expect(req.headers["origin"]).toBe(baseUrl);
  });

  it("does not override a custom Content-Type if explicitly set via constructor headers", async () => {
    const transport = new FetchTransport(baseUrl, {
      "Content-Type": "application/json; charset=utf-8",
    });
    await transport.createProject({ name: "t", mode: "existing", directoryPath: "/tmp/t" });

    const req = state.requests[0]!;
    expect(req.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});
