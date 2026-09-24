import { expect, test } from "bun:test";
import { browserAddress } from "./BrowserPane";

test("the address bar accepts full URLs and bare hosts", () => {
  expect(browserAddress(" https://a.example.test/x?y=1 ")).toBe(
    "https://a.example.test/x?y=1",
  );
  expect(browserAddress("a.example.test/path")).toBe(
    "https://a.example.test/path",
  );
  expect(browserAddress("localhost:3000")).toBe("http://localhost:3000/");
  expect(browserAddress("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
});

test("the address bar rejects empty input and non-web schemes", () => {
  expect(browserAddress("   ")).toBeNull();
  expect(browserAddress("javascript://alert(1)")).toBeNull();
  expect(browserAddress("file:///etc/passwd")).toBeNull();
});
