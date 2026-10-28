import { describe, it, expect, vi, beforeEach } from "vitest";
import type { UIMessage } from "ai";
import {
  cleanGeneratedTitle,
  generateChatTitle,
  TITLE_MAX_LENGTH,
} from "../title-generation";

const { generateTextMock } = vi.hoisted(() => ({ generateTextMock: vi.fn() }));

vi.mock("ai", () => ({ generateText: generateTextMock }));

function user(text: string): UIMessage {
  return { id: `u-${text}`, role: "user", parts: [{ type: "text", text }] };
}

function assistant(text: string): UIMessage {
  return { id: `a-${text}`, role: "assistant", parts: [{ type: "text", text }] };
}

beforeEach(() => {
  generateTextMock.mockReset();
});

describe("cleanGeneratedTitle", () => {
  it("strips wrapping quotes, backticks and markdown emphasis", () => {
    expect(cleanGeneratedTitle('"Fix SQLite migrations"')).toBe(
      "Fix SQLite migrations"
    );
    expect(cleanGeneratedTitle("`Fix SQLite migrations`")).toBe(
      "Fix SQLite migrations"
    );
    expect(cleanGeneratedTitle('**"Fix SQLite migrations"**')).toBe(
      "Fix SQLite migrations"
    );
  });

  it("strips a Title:/Judul: prefix and closing punctuation", () => {
    expect(cleanGeneratedTitle('Title: "Fix SQLite migrations".')).toBe(
      "Fix SQLite migrations"
    );
    expect(cleanGeneratedTitle("Judul — Perbaiki migrasi SQLite")).toBe(
      "Perbaiki migrasi SQLite"
    );
    expect(cleanGeneratedTitle("Chat title: Deploy the server")).toBe(
      "Deploy the server"
    );
  });

  it("keeps only the first non-empty line", () => {
    expect(
      cleanGeneratedTitle("\n  \nFix SQLite migrations\nExplanation here")
    ).toBe("Fix SQLite migrations");
  });

  it("truncates long titles at a word boundary", () => {
    const title = cleanGeneratedTitle(
      "An extremely long title that keeps going and going far beyond the limit"
    );
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
    expect(title.endsWith(" ")).toBe(false);
    expect(title.startsWith("An extremely long title")).toBe(true);
  });

  it("returns an empty string for empty input", () => {
    expect(cleanGeneratedTitle("   \n  ")).toBe("");
  });
});

describe("generateChatTitle", () => {
  it("returns fallback when there are no user messages", async () => {
    const result = await generateChatTitle([assistant("Hello")], {} as never, {
      fallback: "Default Title",
    });
    expect(result).toBe("Default Title");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("returns fallback when user text is empty after filtering", async () => {
    const messages: UIMessage[] = [
      { id: "1", role: "user", parts: [{ type: "text", text: "   " }] },
    ];
    const result = await generateChatTitle(messages, {} as never, {
      fallback: "No Content",
    });
    expect(result).toBe("No Content");
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("uses the assistant reply, not just the first user message", async () => {
    generateTextMock.mockResolvedValue({
      text: "Fix SQLite migrations",
      finalStep: {},
    });

    const result = await generateChatTitle(
      [user("Kenapa migrasi SQLite gagal?"), assistant("Karena kolom pinned belum ada.")],
      {} as never,
      { fallback: "fallback" }
    );

    expect(result).toBe("Fix SQLite migrations");
    const call = generateTextMock.mock.calls[0][0] as {
      prompt: string;
      instructions: string;
    };
    expect(call.prompt).toContain("Kenapa migrasi SQLite gagal?");
    expect(call.prompt).toContain("Karena kolom pinned belum ada.");
    expect(call.instructions).toMatch(/same language/i);
  });

  it("scope recent uses the latest exchange", async () => {
    generateTextMock.mockResolvedValue({ text: "Deploy the server", finalStep: {} });

    await generateChatTitle(
      [
        user("First topic: SQLite"),
        assistant("SQLite reply"),
        user("Second topic: deployment"),
        assistant("Deployment reply"),
      ],
      {} as never,
      { fallback: "fallback", scope: "recent" }
    );

    const call = generateTextMock.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain("Second topic: deployment");
    expect(call.prompt).toContain("Deployment reply");
    expect(call.prompt).not.toContain("First topic: SQLite");
  });

  it("cleans the model output before returning it", async () => {
    generateTextMock.mockResolvedValue({
      text: 'Title: "Fix SQLite migrations".',
      finalStep: {},
    });
    const result = await generateChatTitle(
      [user("sqlite"), assistant("use ensureColumn")],
      {} as never,
      { fallback: "fallback" }
    );
    expect(result).toBe("Fix SQLite migrations");
  });

  it("returns the fallback for a meta comment instead of a title", async () => {
    generateTextMock.mockResolvedValue({
      text: "The user is asking about SQLite migrations",
      finalStep: {},
    });
    const result = await generateChatTitle(
      [user("sqlite"), assistant("use ensureColumn")],
      {} as never,
      { fallback: "sqlite" }
    );
    expect(result).toBe("sqlite");
  });

  it("returns the fallback when generation throws", async () => {
    generateTextMock.mockRejectedValue(new Error("model unavailable"));
    const result = await generateChatTitle([user("sqlite")], {} as never, {
      fallback: "sqlite",
    });
    expect(result).toBe("sqlite");
  });

  it("truncates a very long generated title", async () => {
    generateTextMock.mockResolvedValue({
      text: "A".repeat(100),
      finalStep: {},
    });
    const result = await generateChatTitle([user("quantum computing")], {} as never, {
      fallback: "fallback",
    });
    expect(result.length).toBeLessThanOrEqual(TITLE_MAX_LENGTH);
  });
});
