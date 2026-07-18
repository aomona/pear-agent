import { describe, expect, it } from "vitest";

import { readBodyWithLimit, validatePublicUrl } from "./public-url.js";

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

  it("stops reading a chunked response as soon as the byte limit is exceeded", async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(8));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
    await expect(readBodyWithLimit(response, 10)).rejects.toThrow("Source exceeds 10 bytes");
    expect(cancelled).toBe(true);
  });
});
