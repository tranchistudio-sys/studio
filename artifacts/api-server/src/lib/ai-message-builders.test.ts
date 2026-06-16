import { describe, it, expect } from "vitest";
import {
  buildClaudeMessages,
  buildOpenAIMessages,
  type ChatMessage,
} from "./ai-message-builders";

describe("buildClaudeMessages", () => {
  it("text-only message → content is the plain string (backward compat)", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hello" }];
    const result = buildClaudeMessages(messages);
    expect(result).toEqual([{ role: "user", content: "hello" }]);
    expect(typeof result[0].content).toBe("string");
  });

  it("message with one image → image block first, text block last", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "caption?",
        images: [{ mediaType: "image/jpeg", dataBase64: "AAA" }],
      },
    ];
    const result = buildClaudeMessages(messages);
    const content = result[0].content;
    expect(Array.isArray(content)).toBe(true);
    const arr = content as unknown[];
    expect(arr[0]).toEqual({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "AAA" },
    });
    expect(arr[arr.length - 1]).toEqual({ type: "text", text: "caption?" });
  });
});

describe("buildOpenAIMessages", () => {
  it("text-only → system message then plain-string user message", () => {
    const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
    const result = buildOpenAIMessages("sys", messages);
    expect(result).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("with one png image → text part then image_url data URL part", () => {
    const messages: ChatMessage[] = [
      {
        role: "user",
        content: "c",
        images: [{ mediaType: "image/png", dataBase64: "B64" }],
      },
    ];
    const result = buildOpenAIMessages("sys", messages);
    expect(result[0]).toEqual({ role: "system", content: "sys" });
    const userContent = result[1].content as unknown[];
    expect(userContent[0]).toEqual({ type: "text", text: "c" });
    expect(userContent[1]).toEqual({
      type: "image_url",
      image_url: { url: "data:image/png;base64,B64" },
    });
  });
});
