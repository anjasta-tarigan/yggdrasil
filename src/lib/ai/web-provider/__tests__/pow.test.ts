/**
 * DeepSeekHashV1 + PoW solver contract (Spec §13.1: the PoW hash is the one
 * piece fully verifiable offline).
 *
 * The proof has two layers:
 *  1. Anchor — `deepSeekHash24` (24-round SHA3-256) must match Node's
 *     `crypto.createHash("sha3-256")` for many inputs. This proves the sponge,
 *     pad, and squeeze are byte-correct.
 *  2. Self-consistency — a challenge whose `challenge` field is `deepSeekHashV1`
 *     of `prefix + answer` must solve back to exactly `answer`, and no other
 *     nonce in `[0, difficulty)` may match. This proves the solver, the 23-round
 *     variant, and the hash↔challenge round-trip are correct.
 *
 * The live spike is the only thing that confirms the upstream compares the
 * digest to `challenge` the same way; nothing here depends on it.
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  deepSeekHash24,
  deepSeekHashV1,
  solvePow,
  encodePowResponse,
  digestToHex,
  type PowChallenge,
} from "../pow";

function hex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

describe("deepSeekHash24 anchors the permutation against node:crypto", () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0x61, 0x62, 0x63]), // "abc"
    new Uint8Array([0x00, 0xff, 0x10, 0x20]),
    // A message spanning two rate blocks to exercise the absorb loop twice.
    new Uint8Array(300).map((_, i) => i & 0xff),
  ];

  it.each(cases.map((input, i) => [i === 1 ? '"abc"' : `input#${i}`, input] as const))(
    "matches SHA3-256 for %s",
    (_label, input) => {
      const ours = hex(deepSeekHash24(input));
      const ref = createHash("sha3-256").update(Buffer.from(input)).digest("hex");
      expect(ours).toBe(ref);
    }
  );
});

describe("deepSeekHashV1 is the 23-round production variant", () => {
  it("differs from the 24-round SHA3-256 (it is the reduced-round instance)", () => {
    const input = new TextEncoder().encode("prefix_123_42");
    // The two variants must not be identical for a realistic input.
    expect(hex(deepSeekHashV1(input))).not.toBe(hex(deepSeekHash24(input)));
  });

  it("is deterministic", () => {
    const input = new TextEncoder().encode("deterministic-check");
    expect(hex(deepSeekHashV1(input))).toBe(hex(deepSeekHashV1(input)));
  });
});

describe("solvePow", () => {
  function challengeFor(salt: string, expireAt: number, answer: number, difficulty: number): PowChallenge {
    const prefix = `${salt}_${expireAt}_`;
    const challenge = digestToHex(deepSeekHashV1(new TextEncoder().encode(`${prefix}${answer}`)));
    return {
      algorithm: "DeepSeekHashV1",
      challenge,
      salt,
      signature: "fixture-signature",
      difficulty,
      expire_at: expireAt,
      target_path: "/api/v0/chat/completion",
    };
  }

  it("recovers the exact answer nonce for a self-consistent challenge", () => {
    const challenge = challengeFor("fixture-salt", 1760000000000, 7, 64);
    expect(solvePow(challenge)).toBe(7);
  });

  it("recovers the answer even when it is 0 (first nonce)", () => {
    const challenge = challengeFor("zero-salt", 1760000000000, 0, 32);
    expect(solvePow(challenge)).toBe(0);
  });

  it("recovers the answer for a large nonce value", () => {
    const challenge = challengeFor("big-salt", 1760000000000, 12345, 20000);
    expect(solvePow(challenge)).toBe(12345);
  });

  it("finds no other matching nonce in the search range (uniqueness)", () => {
    const answer = 5;
    const challenge = challengeFor("uniq-salt", 1760000000000, answer, 32);
    // Brute-force the whole range and assert exactly one hit at `answer`.
    const prefix = `uniq-salt_1760000000000_`;
    let hits = 0;
    let hitNonce = -1;
    const target = deepSeekHashV1(new TextEncoder().encode(`${prefix}${answer}`));
    for (let nonce = 0; nonce < challenge.difficulty; nonce += 1) {
      const attempt = new TextEncoder().encode(`${prefix}${nonce}`);
      const digest = deepSeekHashV1(attempt);
      if (
        digest.length === target.length &&
        digest.every((byte, i) => byte === target[i])
      ) {
        hits += 1;
        hitNonce = nonce;
      }
    }
    expect(hits).toBe(1);
    expect(hitNonce).toBe(answer);
  });

  it("returns null when no nonce in [0, difficulty) matches the challenge", () => {
    const challenge = challengeFor("miss-salt", 1760000000000, 999, 16);
    // answer 999 is outside the search window [0,16), so the solver must fail.
    expect(solvePow(challenge)).toBeNull();
  });

  it("treats a challenge whose hex length is not 32 bytes as unsolvable", () => {
    const challenge: PowChallenge = {
      algorithm: "DeepSeekHashV1",
      challenge: "deadbeef", // too short to be a 32-byte digest
      salt: "salt",
      signature: "sig",
      difficulty: 1000,
      expire_at: 1760000000000,
      target_path: "/api/v0/chat/completion",
    };
    expect(solvePow(challenge)).toBeNull();
  });
});

describe("encodePowResponse", () => {
  it("base64-encodes the exact JSON object including the answer", () => {
    const challenge: PowChallenge = {
      algorithm: "DeepSeekHashV1",
      challenge: "abcdef",
      salt: "salt-1",
      signature: "sig-1",
      difficulty: 50,
      expire_at: 1760000000000,
      target_path: "/api/v0/chat/completion",
    };
    const encoded = encodePowResponse(challenge, 12);
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(decoded).toEqual({
      algorithm: "DeepSeekHashV1",
      challenge: "abcdef",
      salt: "salt-1",
      answer: 12,
      signature: "sig-1",
      target_path: "/api/v0/chat/completion",
    });
  });
});
