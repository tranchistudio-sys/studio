import { describe, it, expect } from "vitest";
import { splitExactReplyMessages, formatLuluHumanChatMessages } from "./sale-human-chat";

describe("splitExactReplyMessages — 'nói y chang' giữ nguyên xuống dòng", () => {
  it("acceptance: 3 đoạn cách nhau bằng dòng trống → 3 bubble, giữ emoji, không gộp 1 dòng", () => {
    const input =
      "Dạ em chào anh ạ 😊\n\n" +
      "Em là Hoa bên Amazing Studio.\n\n" +
      "Anh đang cần em tư vấn phần chụp cưới, beauty, gia đình hay thuê trang phục để em hỗ trợ đúng nhu cầu nha?";
    const chunks = splitExactReplyMessages(input);
    expect(chunks.map((c) => c.text)).toEqual([
      "Dạ em chào anh ạ 😊",
      "Em là Hoa bên Amazing Studio.",
      "Anh đang cần em tư vấn phần chụp cưới, beauty, gia đình hay thuê trang phục để em hỗ trợ đúng nhu cầu nha?",
    ]);
    // emoji được GIỮ (verbatim)
    expect(chunks[0].text).toContain("😊");
  });

  it("một đoạn có xuống dòng đơn → 1 bubble, GIỮ nguyên \\n bên trong (không tách câu)", () => {
    const input = "Dòng một\nDòng hai\nDòng ba";
    const chunks = splitExactReplyMessages(input);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("Dòng một\nDòng hai\nDòng ba");
  });

  it("nhiều dòng trống liên tiếp → gộp thành 1 ranh giới (không tạo bubble rỗng)", () => {
    const input = "Đoạn A\n\n\n\nĐoạn B";
    const chunks = splitExactReplyMessages(input);
    expect(chunks.map((c) => c.text)).toEqual(["Đoạn A", "Đoạn B"]);
  });

  it("đoạn vừa nhiều dòng vừa cách dòng trống: giữ \\n nội bộ + tách bubble theo đoạn", () => {
    const input = "Tiêu đề\nDòng phụ\n\nĐoạn 2 dòng đơn";
    const chunks = splitExactReplyMessages(input);
    expect(chunks.map((c) => c.text)).toEqual(["Tiêu đề\nDòng phụ", "Đoạn 2 dòng đơn"]);
  });

  it("CRLF được chuẩn hoá về LF, vẫn tách đúng đoạn", () => {
    const input = "Câu 1\r\n\r\nCâu 2";
    const chunks = splitExactReplyMessages(input);
    expect(chunks.map((c) => c.text)).toEqual(["Câu 1", "Câu 2"]);
  });

  it("chuỗi rỗng / chỉ khoảng trắng → []", () => {
    expect(splitExactReplyMessages("")).toEqual([]);
    expect(splitExactReplyMessages("   \n\n  ")).toEqual([]);
  });

  it("KHÁC formatLuluHumanChatMessages: formatter cũ tách theo câu/bỏ emoji, splitExact giữ verbatim", () => {
    const input = "Dạ em chào anh ạ 😊\n\nEm là Hoa bên Amazing Studio.";
    const exact = splitExactReplyMessages(input).map((c) => c.text);
    const formatted = formatLuluHumanChatMessages(input, { allowEmoji: false }).map((c) => c.text);
    // splitExact giữ NGUYÊN câu chào + emoji; formatter (allowEmoji:false) bỏ emoji.
    expect(exact[0]).toBe("Dạ em chào anh ạ 😊");
    expect(formatted.join(" ")).not.toContain("😊");
  });
});
