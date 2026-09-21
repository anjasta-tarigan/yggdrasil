# Eval Harness

A self-contained agentic eval harness that judges AI agent behavior against
ground truth on disk. It ships with hand-written SSE transcripts for offline
verification, a mock-transport layer for live-runner tests, and loopback-only
networking.

## Design

- **Ground truth on disk, not model claims.** Judges read the filesystem, not
  the tool result. A scenario passes only when the expected files exist with
  the expected content.
- **Offline-first.** Each self-test scenario (T0–T5) has a static SSE transcript
  + a `judge` that takes `{ metrics, fixtureRoot, expected }`. The same judge
  is used for live runs, so pass/fail logic is identical in both paths.
- **Live scenarios (S0–S5).** Each live scenario has a `buildFixture` that sets
  up the initial filesystem state, a `verify` function that checks ground truth,
  and a `judge` that combines metrics + disk state.
- **Mock transport for runner tests.** `HarnessTransport` interface with a
  `FetchTransport` implementation; loopback validation via `assertLoopbackUrl`.

## Directory layout

```
evals/harness/
├── contracts.ts       # Types: UiMessageChunk, ToolCall, RunMetrics, EvaluationResult, Scenario, VerifyResult, StoredProject
├── parse-stream.ts    # splitSseEvents, parseUiMessageStream, drainStreamToText
├── metrics.ts         # buildToolCalls, findRepeatedToolCalls, computeMetrics
├── transcripts.ts     # 6 hand-written raw SSE transcripts (T0–T5)
├── selftest-scenarios.ts  # T0–T5 self-test scenarios (transcript-driven judges)
├── scenarios.ts       # S0–S5 live scenarios (buildFixture/verify/judge)
├── evaluate.ts        # prepareFixture, evaluateScenario, evaluateWithTranscript, cleanupFixtures
├── run.ts             # HarnessTransport, FetchTransport, assertLoopbackUrl, runScenarioLive, runAllLive, RunOptions, ReasoningEffortTier
├── cli.ts             # CLI: main(), parseCliArgs, validateEffort, filterScenarios, findUnknownIds; flags --base-url --model --effort --only --full --out --json --cleanup-stale --replay --help
├── index.ts           # Barrel exports
└── __tests__/         # Vitest unit tests
```

## Scenarios

### Self-test scenarios (T0–T5)

Offline, transcript-driven scenarios used by unit tests. Each has a hand-written
SSE transcript and a `judge` function.

| ID  | Name                | What it tests                                      |
|-----|---------------------|----------------------------------------------------|
| T0  | agentic-success     | Agent writes `marker.txt` with `"hello"`           |
| T1  | chat-like-failure   | Chat-only agent never writes the file → fail       |
| T2  | stream-error        | Transcript contains an error chunk → fail          |
| T3  | retry-loop          | Identical tool calls re-issued → fail              |
| T4  | multi-step-agentic  | Read `note.txt` then write `marker.txt` → pass     |
| T5  | wrong-content       | File written with wrong content → fail             |

### Live scenarios (S0–S5)

Live scenarios run against a real server. Each has `buildFixture`, `verify`,
and `judge`. S4 and S5 are marked `slow` and excluded from the default run.

| ID  | Name                  | Slow | What it tests                                         |
|-----|-----------------------|------|-------------------------------------------------------|
| S0  | simple-write          | no   | Agent writes `marker.txt` with `"hello"`              |
| S1  | tool-call-required    | no   | Chat-only agent never writes the file → fail          |
| S2  | error-recovery        | no   | Stream error chunk → fail                             |
| S3  | no-retry-loop         | no   | Duplicate tool calls → fail                           |
| S4  | multi-step-read-write | yes  | Read `note.txt` then write `marker.txt` → pass        |
| S5  | content-correctness   | yes  | File written with wrong content → fail                |

## Usage

### Offline (unit tests)

```bash
pnpm test:evals
```

This runs the hand-written transcripts through `evaluateScenario` /
`evaluateWithTranscript` and applies each scenario's judge against a temp
fixture directory.

### CLI runner

```bash
pnpm eval:harness [options]
```

Options:

| Flag              | Description                                                              |
|-------------------|--------------------------------------------------------------------------|
| `--base-url <url>` | Server base URL (must be loopback). Default: `http://127.0.0.1:3000`    |
| `--model <ref>`   | Model ref (e.g. `"server::gpt-4o"`). **Required** for live runs.        |
| `--effort <level>` | Reasoning effort tier: `xhigh` \| `high` \| `medium` \| `low` \| `none` \| `auto` |
| `--only <ids>`    | Comma-separated scenario IDs to run (e.g. `S0,S4`). Case-insensitive.   |
| `--full`          | Run all scenarios including slow ones (S4, S5). Default: S0–S3 only.  |
| `--out <dir>`     | Write JSON results to `<dir>/<scenario-id>.json`.                       |
| `--json`          | Print results as JSON to stdout.                                        |
| `--cleanup-stale` | Delete stale `ygg-eval-*` projects from the server via `GET /api/projects`. |
| `--replay <file>` | Replay a captured SSE transcript file instead of hitting the server.   |
| `--help`          | Show help message. Exits before any HTTP.                               |

Examples:

```bash
pnpm eval:harness --base-url http://localhost:3000 --model server::gpt-4o --full
pnpm eval:harness --base-url http://localhost:3000 --only S0,S4 --json --out eval-results/
pnpm eval:harness --cleanup-stale
pnpm eval:harness --replay eval-results/S0-sse.txt --base-url http://localhost:3000
```

### Programmatic API

```ts
import { FetchTransport, runAllLive } from "./evals/harness";
import { ALL_SCENARIOS } from "./evals/harness/scenarios";

const transport = new FetchTransport("http://localhost:3000");
const results = await runAllLive(ALL_SCENARIOS, transport, {
  baseDir: "/tmp/evals",
  model: "server::gpt-4o",
  effort: "high",
});
```

The harness refuses to connect to any non-loopback host — `localhost`,
`127.0.0.1`, `::1`, and `*.localhost` are accepted; everything else throws.

## API surface

The harness talks to the Projects API on the eval server:

| Method   | Endpoint                  | Purpose                          |
|----------|---------------------------|----------------------------------|
| `POST`   | `/api/projects`           | Create a project (returns `id`)  |
| `GET`    | `/api/projects`           | List all projects                |
| `DELETE` | `/api/projects/{id}`      | Delete a project                 |
| `POST`   | `/api/projects/{id}/trust`| Set the `trusted` flag           |
| `POST`   | `/api/projects/{id}/sessions` | Create a session (returns `id`) |
| `POST`   | `/api/projects/chat`      | Run a chat (SSE stream response) |

Projects are named `ygg-eval-{scenarioId}-{8-char-hex}` for cleanup filtering
and concurrency safety. The `--cleanup-stale` command uses `GET /api/projects`
to enumerate, then `DELETE`s every project whose name matches the `ygg-eval-*`
prefix.

## Wire format

The parser follows AI-SDK v7 `toUIMessageStream`:

- `finish-step` carries `usage` (consumed by the route's `messageMetadata` mapper).
- `finish` carries `finishReason` as a **string**.
- Errors arrive via `error` chunks (`errorText`) or `abort` chunks (`reason`).
- `[DONE]` sentinels are dropped.
