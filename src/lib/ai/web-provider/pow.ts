/**
 * DeepSeekHashV1 — the proof-of-work hash DeepSeek Web requires before every
 * `/chat/completion` call.
 *
 * UNVERIFIED CONTRACT — derived from the reference implementations (OmniRoute
 * `open-sse/executors/deepseek-web.ts`), not confirmed against the live service
 * (Spec §13.1). No live account is needed to verify the math offline: this is a
 * standard Keccak-p[1600] sponge, so the 24-round variant is byte-identical to
 * Node's SHA3-256 — which `pow.test.ts` asserts against `node:crypto`. The
 * production variant runs one round fewer (`DEEPSEEK_HASH_ROUNDS` = 23).
 *
 * Sponge parameters (identical to SHA3-256): rate 136 bytes, domain suffix
 * `0x06`, 32-byte output. The only deviation from SHA3-256 is the round count.
 * Per the Keccak submission, a reduced-round instance `Keccak-p[1600, r]`
 * starts at round index `(12 + 2·ℓ − r)` with ℓ = 6, so r = 23 starts at index
 * 1 and applies round constants `RC[1..23]`. That start index is the one
 * unverifiable-from-offline assumption; it is isolated in `DEEPSEEK_HASH_ROUND_START`
 * so a live spike can flip it without touching the permutation.
 *
 * No new dependency: the Keccak-p[1600] permutation is implemented from scratch
 * using the standard round constants and rotation offsets. `BigInt` literals
 * (`0n`) are avoided because the project targets ES2017; the `BigInt(...)`
 * constructor is used throughout instead.
 */

export interface PowChallenge {
  algorithm: "DeepSeekHashV1";
  challenge: string;
  salt: string;
  signature: string;
  difficulty: number;
  expire_at: number;
  target_path: string;
}

const RATE_BYTES = 136;
const OUTPUT_BYTES = 32;
/** SHA3-256 family domain separation suffix (pad10*1 with the `01` bits). */
const DOMAIN_SUFFIX = 0x06;
/** Production permutation rounds. */
const DEEPSEEK_HASH_ROUNDS = 23;
/**
 * First round-constant index for the reduced-round instance. r = 23 ⇒ start 1
 * (Keccak-p[1600, r] definition). SHA3-256 (r = 24) starts at 0.
 */
const DEEPSEEK_HASH_ROUND_START = 24 - DEEPSEEK_HASH_ROUNDS;
const LANE_BIT_COUNT = 64;
const LANE_BITS = BigInt(LANE_BIT_COUNT);
const LANE_MASK = (BigInt(1) << LANE_BITS) - BigInt(1);

/** The 24 Keccak round constants RC[0..23]. */
const ROUND_CONSTANTS: readonly bigint[] = [
  BigInt("0x0000000000000001"), BigInt("0x0000000000008082"), BigInt("0x800000000000808a"),
  BigInt("0x8000000080008000"), BigInt("0x000000000000808b"), BigInt("0x0000000080000001"),
  BigInt("0x8000000080008081"), BigInt("0x8000000000008009"), BigInt("0x000000000000008a"),
  BigInt("0x0000000000000088"), BigInt("0x0000000080008009"), BigInt("0x000000008000000a"),
  BigInt("0x000000008000808b"), BigInt("0x800000000000008b"), BigInt("0x8000000000008089"),
  BigInt("0x8000000000008003"), BigInt("0x8000000000008002"), BigInt("0x8000000000000080"),
  BigInt("0x000000000000800a"), BigInt("0x800000008000000a"), BigInt("0x8000000080008081"),
  BigInt("0x8000000000008080"), BigInt("0x0000000080000001"), BigInt("0x8000000080008008"),
];

/**
 * Keccak ρ rotation offsets indexed by lane position `x + 5·y` (0..24).
 * Lane index 0 is the unused corner; its offset is irrelevant.
 */
const RHO_OFFSETS: readonly number[] = [
  0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

/** Rotates a 64-bit lane left by `shift` bits (mod 64). */
function rotl64(lane: bigint, shift: number): bigint {
  if (shift === 0) return lane & LANE_MASK;
  return ((lane << BigInt(shift)) | (lane >> (LANE_BITS - BigInt(shift)))) & LANE_MASK;
}

/** One Keccak-p[1600] round: θ, ρ, π, χ, ι. */
function keccakRound(state: bigint[], roundConstant: bigint): void {
  // θ — parity XOR
  const c = new Array<bigint>(5);
  for (let x = 0; x < 5; x += 1) {
    c[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
  }
  const d = new Array<bigint>(5);
  for (let x = 0; x < 5; x += 1) {
    // d[x] = c[x-1] XOR rotl(c[x+1], 1)
    d[x] = c[(x + 4) % 5] ^ rotl64(c[(x + 1) % 5], 1);
  }
  for (let x = 0; x < 5; x += 1) {
    for (let y = 0; y < 5; y += 1) {
      state[x + 5 * y] ^= d[x];
    }
  }

  // ρ and π — rotate-and-permute into a scratch state
  const b = new Array<bigint>(25);
  for (let x = 0; x < 5; x += 1) {
    for (let y = 0; y < 5; y += 1) {
      const lane = state[x + 5 * y];
      const rotated = rotl64(lane, RHO_OFFSETS[x + 5 * y]);
      b[y + 5 * ((2 * x + 3 * y) % 5)] = rotated;
    }
  }

  // χ — non-linear mixing
  for (let x = 0; x < 5; x += 1) {
    for (let y = 0; y < 5; y += 1) {
      const idx = x + 5 * y;
      state[idx] = b[idx] ^ (~b[((x + 1) % 5) + 5 * y] & b[((x + 2) % 5) + 5 * y]);
    }
  }

  // ι — add the round constant
  state[0] ^= roundConstant;
}

/**
 * Runs the full SHA3-256 sponge over `message`: the 136-byte-rate, `0x06`-domain
 * pad, 24-round Keccak-p[1600] permutation, 32-byte squeeze. This is the one
 * variant Node's `crypto` exposes (`sha3-256`), so it anchors the offline proof:
 * `pow.test.ts` asserts `deepSeekHash24` matches `crypto.createHash("sha3-256")`
 * for many inputs. If the 23-round production variant is wrong, the 24-round
 * anchor still proves the permutation, pad, and squeeze are byte-correct.
 */
export function deepSeekHash24(message: Uint8Array): Uint8Array {
  return sponge(message, 0, 24);
}

/**
 * Computes DeepSeekHashV1 of `message`: a SHA3-256 sponge run with 23 rounds
 * (the production PoW variant). Exposed for testing and for the solver; the
 * adapter never calls it directly.
 */
export function deepSeekHashV1(message: Uint8Array): Uint8Array {
  return sponge(message, DEEPSEEK_HASH_ROUND_START, DEEPSEEK_HASH_ROUNDS);
}

/** Shared sponge: absorb-rate blocks, permute `rounds` times from `startRound`. */
function sponge(message: Uint8Array, startRound: number, rounds: number): Uint8Array {
  const state = new Array<bigint>(25).fill(BigInt(0));
  const padded = padMessage(message);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    const block = padded.subarray(offset, offset + RATE_BYTES);
    const blockLanes = bytesToState(block);
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      state[lane] ^= blockLanes[lane];
    }
    keccakPermutation(state, startRound, rounds);
  }
  // SHA3 squeezes within the rate; the 32-byte output is the first four lanes.
  return stateToBytes(state, OUTPUT_BYTES / 8);
}

/** Applies `rounds` Keccak-p[1600] rounds starting at `startRound`. */
function keccakPermutation(state: bigint[], startRound: number, rounds: number): void {
  for (let i = 0; i < rounds; i += 1) {
    keccakRound(state, ROUND_CONSTANTS[startRound + i]);
  }
}

/** Decodes `rate`-byte blocks (17 lanes of 8 bytes, little-endian) into lanes. */
function bytesToState(bytes: Uint8Array): bigint[] {
  const state = new Array<bigint>(25).fill(BigInt(0));
  for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
    let value = BigInt(0);
    for (let byte = 7; byte >= 0; byte -= 1) {
      value = (value << BigInt(8)) | BigInt(bytes[lane * 8 + byte]);
    }
    state[lane] = value;
  }
  return state;
}

/** Serializes the first `count` lanes back to bytes (little-endian). */
function stateToBytes(state: bigint[], count: number): Uint8Array {
  const out = new Uint8Array(count * 8);
  for (let lane = 0; lane < count; lane += 1) {
    let value = state[lane];
    for (let byte = 0; byte < 8; byte += 1) {
      out[lane * 8 + byte] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
    }
  }
  return out;
}

/** Multi-rate padding: message ‖ 0x06 ‖ 0x00… ‖ 0x80, aligned to the rate. */
function padMessage(message: Uint8Array): Uint8Array {
  const padLength = RATE_BYTES - (message.length % RATE_BYTES);
  const padded = new Uint8Array(message.length + padLength);
  padded.set(message, 0);
  // First padding byte carries the domain suffix; the final padding byte sets
  // the multi-rate high bit. When padLength is 1 they merge into 0x86.
  padded[message.length] = DOMAIN_SUFFIX;
  padded[message.length + padLength - 1] |= 0x80;
  return padded;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex string length");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Constant-time-ish length-then-content equality (lengths are fixed here). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Solves a PoW challenge. Iterates `nonce` from 0 to `difficulty - 1`, hashing
 * `${salt}_${expire_at}_${nonce}` and comparing the 32-byte digest to
 * `challenge` (hex). Returns the matching nonce, or `null` if none in range.
 *
 * The offline correctness proof is self-consistency: a fixture whose `challenge`
 * is `deepSeekHashV1(prefix + answer)` yields exactly `answer`. The live spike
 * is the only thing that confirms the upstream compares the same way (Spec §13.1).
 */
export function solvePow(challenge: PowChallenge): number | null {
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  const prefixBytes = new TextEncoder().encode(prefix);
  const targetBytes = hexToBytes(challenge.challenge);

  for (let nonce = 0; nonce < challenge.difficulty; nonce += 1) {
    const attempt = new Uint8Array(prefixBytes.length + byteLengthOf(nonce));
    attempt.set(prefixBytes, 0);
    writeNonce(attempt, prefixBytes.length, nonce);
    if (bytesEqual(deepSeekHashV1(attempt), targetBytes)) return nonce;
  }
  return null;
}

/** Number of UTF-8 bytes `String(nonce)` occupies (all ASCII digits). */
function byteLengthOf(nonce: number): number {
  return String(nonce).length;
}

/** Writes the decimal nonce into `out` starting at `offset` (ASCII digits). */
function writeNonce(out: Uint8Array, offset: number, nonce: number): void {
  const text = String(nonce);
  for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
}

/**
 * Builds the `X-Ds-Pow-Response` header value: base64 of the JSON object
 * `{ algorithm, challenge, salt, answer, signature, target_path }`.
 */
export function encodePowResponse(challenge: PowChallenge, answer: number): string {
  const payload = {
    algorithm: challenge.algorithm,
    challenge: challenge.challenge,
    salt: challenge.salt,
    answer,
    signature: challenge.signature,
    target_path: challenge.target_path,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

/** Test helper: hex-encodes a digest (used by fixtures and tests only). */
export function digestToHex(digest: Uint8Array): string {
  return bytesToHex(digest);
}
