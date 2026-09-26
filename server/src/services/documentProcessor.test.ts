import { describe, expect, it } from "vitest";
import { splitPage } from "./documentProcessor.js";

describe("document chunking", () => {
  it("keeps page numbers, section titles and overlapping chunks", () => {
    const text = `# 支持向量机\n${"软间隔用于处理噪声和线性不可分数据。".repeat(160)}`;
    const chunks = splitPage({ pageNo: 3, text }, 100, 700, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.pageNo === 3)).toBe(true);
    expect(chunks[0].sectionTitle).toBe("支持向量机");
    expect(chunks[1].charStart).toBeLessThan(chunks[0].charEnd + 1);
  });
});
