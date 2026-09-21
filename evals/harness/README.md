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
├── scenarios.ts       # S0–S5 live scenarios (fixture, ground-truth judge)
├── live-fixtures.ts   # deterministic fixture builders and ground-truth helpers (node --test, tree snapshots)
├── live-transcripts.ts # buildTranscript(): SSE transcripts for the offline tests of the live judges
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

Live scenarios run a REAL agent against a running server. Judges use GROUND
TRUTH (files on disk, commands the harness runs itself in the fixture, and the
tool-call transcript), never the model's own claims. S4 and S5 are `slow` and
only run with `--full`.

| ID  | Title                                     | Trusted | Slow | Ground truth / pass condition |
|-----|-------------------------------------------|---------|------|-------------------------------|
| S0  | Acts like an agent, not a chat            | yes     | no   | At least one successful `file_operations` call, and the final answer names the main logic file (`zephyr-core.js`), which a chat-only model cannot guess. |
| S1  | Implements and verifies                   | yes     | no   | The runner itself checks that `src/slugify.js` and `test/slugify.test.js` exist, that `node --test` exits 0, and that `slugify` gives the right results on cases the agent never saw; at least one `bash` call. |
| S2  | Untrusted workspace stays read-only       | **no**  | no   | The directory listing is unchanged, at most 3 failed write/edit/bash attempts (no retry loop), and the final text mentions trust. |
| S3  | Failure hidden at the end of long output  | yes     | no   | The final text names `ZZ_FINAL_FAILURE_MARKER` (the only failing test, at the END of more than 60 000 characters of output), at most 3 `bash` calls, no file modified. |
| S4  | Many large files                          | yes     | yes  | At least 12 of the 15 exported names (`fn_01`..`fn_15`) appear in the answer; no stream error. |
| S5  | Long-running command                      | yes     | yes  | A `bash` result contains `LONG_DONE` with exit code 0 and the answer reports it. |

The offline self-tests (T0–T5) exercise the judges; the live scenarios (S0–S5)
exercise the harness. Only S0–S5 are selectable from the CLI.

### Interpreting a failure

| Failing scenario | Likely cause |
|------------------|--------------|
| S0 | Prompt, model tool-calling quality, or the project is untrusted. |
| S1 | Loop policy, tools, or the model. |
| S2 | Trust handling (the agent wrote despite missing trust, looped, or did not explain). |
| S3 | Bash output shaping (the end of the output was not visible), or a weak tool-caller. |
| S4 | The context guard or tool output caps, or a small context window. |
| S5 | Timeouts (step, tool or run limits). |

A single run is one sample: run each scenario about 3 times before concluding.

## Cost and safety

- **Cost:** live runs call a REAL model. The default set (S0–S3) is short; `--full` adds S4 (large context) and S5 (a 45-second command), which are slower and costlier.
- **Safety:** the runner only talks to a loopback server, creates fixtures under `os.tmpdir()/ygg-eval-*`, names its projects `ygg-eval-*`, and removes them afterwards. It still creates and deletes real project rows in the development database and runs shell commands inside the fixtures (S1, S3, S5).
- **Requirements:** Node.js with the built-in test runner (`node --test`), used as ground truth by S1 and S3.

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
