import { describe, expect, it } from "vitest";

import { resolveDesktopPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  it("builds desktop pairing URLs with token in the hash", () => {
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });
});
