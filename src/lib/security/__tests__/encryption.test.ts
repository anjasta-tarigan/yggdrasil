import { describe, it, expect } from "vitest";
import {
  encrypt,
  decrypt,
  isEncrypted,
  encryptSecretConfig,
  decryptSecretConfig,
  rotateSecretConfig,
} from "../encryption";

describe("Application-Level Envelope Encryption (AES-256-GCM)", () => {
  it("encrypts and decrypts a plain text string roundtrip", () => {
    const plain = "sk-ant-api03-secret-test-key-12345";
    const cipher = encrypt(plain, "test-master-secret-32-bytes-long!!");
    expect(cipher).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(isEncrypted(cipher)).toBe(true);
    expect(isEncrypted(plain)).toBe(false);

    const decrypted = decrypt(cipher, "test-master-secret-32-bytes-long!!");
    expect(decrypted).toBe(plain);
  });

  it("produces unique IVs and distinct ciphertexts for identical inputs", () => {
    const plain = "same-payload";
    const secret = "test-master-secret-32-bytes-long!!";
    const c1 = encrypt(plain, secret);
    const c2 = encrypt(plain, secret);
    expect(c1).not.toBe(c2);
    expect(decrypt(c1, secret)).toBe(plain);
    expect(decrypt(c2, secret)).toBe(plain);
  });

  it("throws authentication error when ciphertext or tag is tampered with", () => {
    const plain = "critical-credentials";
    const secret = "test-master-secret-32-bytes-long!!";
    const cipher = encrypt(plain, secret);
    const parts = cipher.split(":");
    // Tamper with ciphertext payload
    parts[4] = "A" + parts[4].slice(1);
    const tampered = parts.join(":");
    expect(() => decrypt(tampered, secret)).toThrow();
  });

  it("recursively encrypts and decrypts sensitive keys in config objects", () => {
    const config = {
      name: "OpenAI",
      apiKey: "sk-live-secret-openai-key",
      endpoint: "https://api.openai.com/v1",
      models: ["gpt-4o"],
      nested: {
        token: "nested-secret-token",
        publicId: "pub-123",
      },
    };
    const secret = "test-master-secret-32-bytes-long!!";
    const encrypted = encryptSecretConfig(config, secret);
    expect(encrypted.name).toBe("OpenAI");
    expect(isEncrypted(encrypted.apiKey)).toBe(true);
    const nested = encrypted.nested as Record<string, unknown>;
    expect(nested.publicId).toBe("pub-123");
    expect(isEncrypted(nested.token)).toBe(true);

    const decrypted = decryptSecretConfig(encrypted, secret);
    expect(decrypted).toEqual(config);
  });

  it("rotates keys cleanly from oldSecret to newSecret", () => {
    const oldSecret = "old-secret-key-for-rotation-32b!";
    const newSecret = "new-secret-key-for-rotation-32b!";
    const config = { apiKey: "my-precious-api-key", provider: "groq" };

    const encOld = encryptSecretConfig(config, oldSecret);
    const encNew = rotateSecretConfig(encOld, oldSecret, newSecret);

    expect(decryptSecretConfig(encNew, newSecret)).toEqual(config);
    expect(() => decryptSecretConfig(encNew, oldSecret)).toThrow();
  });

  it("encrypts and decrypts with the default master secret when secret is omitted", () => {
    const plain = "default-secret-test-payload-data";
    const cipher = encrypt(plain);
    expect(isEncrypted(cipher)).toBe(true);
    const decrypted = decrypt(cipher);
    expect(decrypted).toBe(plain);
  });

  it("throws authentication error when auth tag is tampered with", () => {
    const plain = "critical-credentials-payload";
    const secret = "test-master-secret-32-bytes-long!!";
    const cipher = encrypt(plain, secret);
    const parts = cipher.split(":");
    // parts: ["enc", "v1", ivB64, authTagB64, cipherB64]
    parts[3] = "B" + parts[3].slice(1);
    const tampered = parts.join(":");
    expect(() => decrypt(tampered, secret)).toThrow();
  });

  it("throws error on malformed envelope structures", () => {
    expect(() => decrypt("enc:v1:invalid")).toThrow("Invalid encryption envelope structure");
    expect(() => decrypt("enc:v1:part1:part2")).toThrow("Invalid encryption envelope structure");
    expect(() => decrypt("enc:v1:part1:part2:part3:part4")).toThrow("Invalid encryption envelope structure");
  });

  it("encrypts and decrypts empty strings properly", () => {
    const plain = "";
    const cipher = encrypt(plain);
    expect(isEncrypted(cipher)).toBe(true);
    expect(decrypt(cipher)).toBe("");
  });

  it("encrypts compound sensitive keys (accessToken, tool_approval_secret, etc.)", () => {
    const config = {
      accessToken: "access-token-val",
      refreshToken: "refresh-token-val",
      tool_approval_secret: "approval-secret-val",
      publicName: "unencrypted-name",
    };
    const encrypted = encryptSecretConfig(config);
    expect(isEncrypted(encrypted.accessToken)).toBe(true);
    expect(isEncrypted(encrypted.refreshToken)).toBe(true);
    expect(isEncrypted(encrypted.tool_approval_secret)).toBe(true);
    expect(encrypted.publicName).toBe("unencrypted-name");

    const decrypted = decryptSecretConfig(encrypted);
    expect(decrypted).toEqual(config);
  });
});
