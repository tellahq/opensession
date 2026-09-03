import { describe, expect, test } from "bun:test";
import { publicWebhookAvailable } from "./slack-setup";

describe("publicWebhookAvailable", () => {
  test("rejects simple-mode and loopback URLs", () => {
    for (const url of [
      "http://127.0.0.1:3850",
      "http://localhost:3850",
      "http://[::1]:3850",
      "http://0.0.0.0:3848",
      "not a url",
    ]) {
      expect(publicWebhookAvailable(url)).toBe(false);
    }
  });

  test("accepts an internet-facing webhook URL", () => {
    expect(publicWebhookAvailable("https://hooks.example.com")).toBe(true);
  });
});
