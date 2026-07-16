import { describe, expect, it } from "vitest";

import { validatePublicUrl } from "./compile.js";

describe("validatePublicUrl", () => {
  it.each([
    "http://[::1]/secret",
    "http://[fd00::1]/secret",
    "http://[fe80::1]/secret",
    "http://[::ffff:127.0.0.1]/secret",
    "http://127.0.0.1/secret",
    "http://169.254.169.254/metadata",
  ])("rejects private address %s", (url) => {
    expect(() => validatePublicUrl(url)).toThrow("Private network");
  });

  it("does not reject a public hostname merely because it starts with fd", () => {
    expect(validatePublicUrl("https://fda.gov/").hostname).toBe("fda.gov");
  });
});
