import { describe, it, expect } from "vitest";
import {
  isTextOrCodeMediaType,
  decodeDataUrlContent,
  formatDecodedFileBlock,
  processIncomingMessageAttachments,
} from "../attachments";
import type { UIMessage } from "ai";

describe("attachments - Universal File Content Extraction", () => {
  describe("isTextOrCodeMediaType", () => {
    it("identifies text media types", () => {
      expect(isTextOrCodeMediaType("text/plain")).toBe(true);
      expect(isTextOrCodeMediaType("text/markdown")).toBe(true);
      expect(isTextOrCodeMediaType("text/csv")).toBe(true);
      expect(isTextOrCodeMediaType("text/html")).toBe(true);
      expect(isTextOrCodeMediaType("text/css")).toBe(true);
      expect(isTextOrCodeMediaType("text/javascript")).toBe(true);
    });

    it("identifies application code/structured data media types", () => {
      expect(isTextOrCodeMediaType("application/json")).toBe(true);
      expect(isTextOrCodeMediaType("application/typescript")).toBe(true);
      expect(isTextOrCodeMediaType("application/javascript")).toBe(true);
      expect(isTextOrCodeMediaType("application/x-typescript")).toBe(true);
      expect(isTextOrCodeMediaType("application/x-javascript")).toBe(true);
      expect(isTextOrCodeMediaType("application/xml")).toBe(true);
      expect(isTextOrCodeMediaType("application/x-yaml")).toBe(true);
      expect(isTextOrCodeMediaType("application/yaml")).toBe(true);
      expect(isTextOrCodeMediaType("application/sql")).toBe(true);
    });

    it("identifies code/text files by extension even with generic or missing mediaType", () => {
      expect(isTextOrCodeMediaType(undefined, "server.ts")).toBe(true);
      expect(isTextOrCodeMediaType("", "app.tsx")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "script.py")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "main.rs")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "main.go")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "data.json")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "schema.sql")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "config.yaml")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "config.yml")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "table.csv")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "README.md")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "notes.txt")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", ".env")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", ".env.local")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "Dockerfile")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "Makefile")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "gemfile.rb")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.c")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.cpp")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.java")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.sh")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.bash")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "test.zsh")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "style.scss")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "style.less")).toBe(true);
      expect(isTextOrCodeMediaType("application/octet-stream", "doc.xml")).toBe(true);
    });

    it("returns false for images, audio, video, binary and pdf files", () => {
      expect(isTextOrCodeMediaType("image/png", "image.png")).toBe(false);
      expect(isTextOrCodeMediaType("image/jpeg", "photo.jpg")).toBe(false);
      expect(isTextOrCodeMediaType("image/webp", "photo.webp")).toBe(false);
      expect(isTextOrCodeMediaType("image/gif", "anim.gif")).toBe(false);
      expect(isTextOrCodeMediaType("audio/mp3", "audio.mp3")).toBe(false);
      expect(isTextOrCodeMediaType("video/mp4", "video.mp4")).toBe(false);
      expect(isTextOrCodeMediaType("application/pdf", "document.pdf")).toBe(false);
      expect(isTextOrCodeMediaType("application/zip", "archive.zip")).toBe(false);
      expect(isTextOrCodeMediaType("application/octet-stream", "binary.bin")).toBe(false);
      expect(isTextOrCodeMediaType("application/octet-stream", "app.exe")).toBe(false);
    });
  });

  describe("decodeDataUrlContent", () => {
    it("decodes utf-8 base64 data URLs", () => {
      const text = "export const greeting = 'Hello, World!';";
      const base64 = Buffer.from(text, "utf-8").toString("base64");
      const dataUrl = `data:text/typescript;base64,${base64}`;

      expect(decodeDataUrlContent(dataUrl)).toBe(text);
    });

    it("decodes url-encoded (plain) data URLs", () => {
      const text = "Hello World! Special chars: <>&=";
      const dataUrl = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

      expect(decodeDataUrlContent(dataUrl)).toBe(text);
    });

    it("handles unicode text correctly in base64", () => {
      const text = "こんにちは世界 / 🌲 Yggdrasil Cognitive Engine 🚀";
      const base64 = Buffer.from(text, "utf-8").toString("base64");
      const dataUrl = `data:text/plain;base64,${base64}`;

      expect(decodeDataUrlContent(dataUrl)).toBe(text);
    });

    it("returns null for invalid data URLs", () => {
      expect(decodeDataUrlContent("http://example.com/file.txt")).toBe(null);
      expect(decodeDataUrlContent("not-a-data-url")).toBe(null);
      expect(decodeDataUrlContent("data:")).toBe(null);
      expect(decodeDataUrlContent("")).toBe(null);
    });
  });

  describe("formatDecodedFileBlock", () => {
    it("formats a decoded file block with filename, mediaType, and language syntax", () => {
      const content = "function add(a: number, b: number): number {\n  return a + b;\n}";
      const formatted = formatDecodedFileBlock("src/math.ts", "application/typescript", content);

      expect(formatted).toContain("[Attached File: src/math.ts (application/typescript)]");
      expect(formatted).toContain("```typescript\nfunction add(a: number, b: number): number {\n  return a + b;\n}\n```");
    });

    it("infers language from filename extension when mediaType is missing or generic", () => {
      const content = "print('hello from python')";
      const formatted = formatDecodedFileBlock("script.py", undefined, content);

      expect(formatted).toContain("[Attached File: script.py]");
      expect(formatted).toContain("```python\nprint('hello from python')\n```");
    });

    it("uses default language tag when neither filename nor mediaType indicate specific lang", () => {
      const content = "some plain content";
      const formatted = formatDecodedFileBlock(undefined, undefined, content);

      expect(formatted).toContain("[Attached File: attachment]");
      expect(formatted).toContain("```text\nsome plain content\n```");
    });
  });

  describe("processIncomingMessageAttachments", () => {
    it("transforms text/code file parts into decoded markdown blocks inside user message text", async () => {
      const pyCode = "def solve():\n    return 42";
      const pyBase64 = Buffer.from(pyCode, "utf-8").toString("base64");
      const pyDataUrl = `data:text/x-python;base64,${pyBase64}`;

      const messages: UIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            { type: "text", text: "Please review my Python script:" },
            {
              type: "file",
              filename: "solution.py",
              mediaType: "text/x-python",
              url: pyDataUrl,
            },
          ],
        },
      ];

      const processed = await processIncomingMessageAttachments(messages);

      expect(processed).toHaveLength(1);
      const parts = processed[0].parts;
      // The file part should have been removed from parts and merged into text
      expect(parts.some((p) => p.type === "file")).toBe(false);
      const textParts = parts.filter((p) => p.type === "text") as { type: "text"; text: string }[];
      expect(textParts).toHaveLength(1);
      expect(textParts[0].text).toContain("Please review my Python script:");
      expect(textParts[0].text).toContain("[Attached File: solution.py (text/x-python)]");
      expect(textParts[0].text).toContain("```python\ndef solve():\n    return 42\n```");
    });

    it("retains image file parts for vision models while decoding text file parts", async () => {
      const code = "console.log('hi');";
      const codeBase64 = Buffer.from(code, "utf-8").toString("base64");
      const codeDataUrl = `data:application/javascript;base64,${codeBase64}`;

      const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      const imageDataUrl = `data:image/png;base64,${imageBase64}`;

      const messages: UIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            { type: "text", text: "Look at the screenshot and code:" },
            {
              type: "file",
              filename: "screenshot.png",
              mediaType: "image/png",
              url: imageDataUrl,
            },
            {
              type: "file",
              filename: "index.js",
              mediaType: "application/javascript",
              url: codeDataUrl,
            },
          ],
        },
      ];

      const processed = await processIncomingMessageAttachments(messages);

      expect(processed).toHaveLength(1);
      const parts = processed[0].parts;

      // Image part must be retained as a file part
      const imageParts = parts.filter((p) => p.type === "file");
      expect(imageParts).toHaveLength(1);
      expect((imageParts[0] as { filename?: string }).filename).toBe("screenshot.png");
      expect((imageParts[0] as { mediaType?: string }).mediaType).toBe("image/png");

      // Text part must contain decoded JS code
      const textPart = parts.find((p) => p.type === "text") as { type: "text"; text: string };
      expect(textPart.text).toContain("Look at the screenshot and code:");
      expect(textPart.text).toContain("[Attached File: index.js (application/javascript)]");
      expect(textPart.text).toContain("console.log('hi');");
    });

    it("handles multiple code files uploaded in the same message", async () => {
      const tsCode = "export interface Config { port: number; }";
      const jsonCode = '{\n  "port": 3000\n}';

      const tsDataUrl = `data:application/typescript;base64,${Buffer.from(tsCode).toString("base64")}`;
      const jsonDataUrl = `data:application/json;base64,${Buffer.from(jsonCode).toString("base64")}`;

      const messages: UIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            {
              type: "file",
              filename: "config.ts",
              mediaType: "application/typescript",
              url: tsDataUrl,
            },
            {
              type: "file",
              filename: "config.json",
              mediaType: "application/json",
              url: jsonDataUrl,
            },
          ],
        },
      ];

      const processed = await processIncomingMessageAttachments(messages);
      const textPart = processed[0].parts.find((p) => p.type === "text") as { type: "text"; text: string };

      expect(textPart).toBeDefined();
      expect(textPart.text).toContain("[Attached File: config.ts (application/typescript)]");
      expect(textPart.text).toContain("export interface Config { port: number; }");
      expect(textPart.text).toContain("[Attached File: config.json (application/json)]");
      expect(textPart.text).toContain('"port": 3000');
    });

    it("does not mutate non-user messages or messages without text/code file parts", async () => {
      const messages: UIMessage[] = [
        {
          id: "msg-1",
          role: "assistant",
          parts: [{ type: "text", text: "I can help with code." }],
        },
        {
          id: "msg-2",
          role: "user",
          parts: [{ type: "text", text: "Just a regular text message" }],
        },
      ];

      const processed = await processIncomingMessageAttachments(messages);
      expect(processed).toEqual(messages);
    });

    it("gracefully leaves file parts untouched if data URL decoding fails", async () => {
      const messages: UIMessage[] = [
        {
          id: "msg-1",
          role: "user",
          parts: [
            { type: "text", text: "Here is an invalid file:" },
            {
              type: "file",
              filename: "invalid.txt",
              mediaType: "text/plain",
              url: "not-a-valid-data-url",
            },
          ],
        },
      ];

      const processed = await processIncomingMessageAttachments(messages);
      // If decoding fails, file part should be preserved rather than throwing or losing data
      const filePart = processed[0].parts.find((p) => p.type === "file");
      expect(filePart).toBeDefined();
    });
  });
});
