# Eval Harness

A self-contained agentic eval harness that judges AI agent behavior against
ground truth on disk. It ships with hand-written SSE transcripts for offline
verification, a mock-transport layer for live-runner tests, and loopback-only
networking.

## Design

- **Ground truth on disk, not model claims.** Judges read the filesystem, not
  the tool result. A scenario passes only when the expected files exist with
  the expected content.
- **Offline-first.** Each scenario has a static SSE transcript + a `judge`
  that takes `{ metrics, fixtureRoot, expected }`. The same judge is used for
  live runs, so pass/fail logic is identical in both paths.
- **Mock transport for runner tests.** `HarnessTransport` interface with a
  `FetchTransport` implementation; loopback validation via `assertLoopbackUrl`.

## Directory layout

```
evals/harness/
├── contracts.ts       # Types: UiMessageChunk, ToolCall, RunMetrics, EvaluationResult, Scenario, GroundTruthFile
├── parse-stream.ts    # splitSseEvents, parseUiMessageStream, drainStreamToText
├── metrics.ts         # buildToolCalls, findRepeatedToolCalls, computeMetrics
├── scenarios.ts       # S0–S5 scenarios with judges + ground-truth file checks
├── transcripts.ts     # 6 hand-written raw SSE transcripts
├── evaluate.ts        # prepareFixture, evaluateScenario, evaluateWithTranscript, cleanupFixtures
├── run.ts             # HarnessTransport, FetchTransport, assertLoopbackUrl, runScenarioLive, runAllLive
├── index.ts           # Barrel exports
└── __tests__/         # Vitest unit tests
```

## Scenarios

| ID  | Name                  | What it tests                                      |
|-----|-----------------------|----------------------------------------------------|
| S0  | agentic-success       | Agent writes `marker.txt` with `"hello"`           |
| S1  | chat-failure          | Chat-only agent never writes the file → fail       |
| S2  | stream-error          | Transcript contains an error chunk → fail          |
| S3  | retry-loop            | Identical tool calls re-issued → fail              |
| S4  | multi-step-agentic    | Read `note.txt` then write `marker.txt` → pass     |
| S5  | wrong-content         | File written with wrong content → fail             |

## Usage

### Offline (unit tests)

```bash
pnpm test:evals
```

This runs the hand-written transcripts through `evaluateScenario` /
`evaluateWithTranscript` and applies each scenario's judge against a temp
fixture directory.

### Live runner

```ts
import { FetchTransport, runAllLive } from "./evals/harness";
import { ALL_SCENARIOS } from "./evals/harness/scenarios";

const transport = new FetchTransport("http://localhost:3000");
const results = await runAllLive(ALL_SCENARIOS, transport, { baseDir: "/tmp/evals" });
```

The harness refuses to connect to any non-loopback host — `localhost`,
`127.0.0.1`, `::1`, and `*.localhost` are accepted; everything else throws.

## Wire format

The parser follows AI-SDK v7 `toUIMessageStream`:

- `finish-step` carries `usage` (consumed by the route's `messageMetadata` mapper).
- `finish` carries `finishReason` as a **string**.
- Errors arrive via `error` chunks (`errorText`) or `abort` chunks (`reason`).
- `[DONE]` sentinels are dropped.
