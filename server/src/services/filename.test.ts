import { describe, expect, it } from "vitest";
import { displayFilename } from "./filename.js";

describe("uploaded filename normalization", () => {
  it("repairs UTF-8 names decoded as Latin-1", () => {
    expect(displayFilename("ä¸­ææä»¶.pdf")).toBe("中文文件.pdf");
  });

  it("keeps normal Unicode and ASCII names unchanged", () => {
    expect(displayFilename("中文文件.pdf")).toBe("中文文件.pdf");
    expect(displayFilename("notes.pdf")).toBe("notes.pdf");
  });
});
