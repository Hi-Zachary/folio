import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./auth.js";

describe("password authentication", () => {
  it("hashes and verifies passwords without storing the plain text", async () => {
    const password = "correct-horse-battery-staple";
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", hash)).resolves.toBe(false);
  });
});
