import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
  fetchServerDescriptor,
  refreshServerDescriptorEffect,
  publishServerDescriptor,
  serverDescriptorSnapshot,
  subscribeServerDescriptor,
} from "./server-capabilities";
import { supportsCapability } from "@tellahq/opensession-protocol/capabilities";

const wire = {
  serverVersion: "0.1.0",
  protocolVersion: 1,
  capabilities: { deskVoice: true, futureFeature: { version: 9 } },
};

test("fetch decodes tolerantly through Effect Schema and bypasses caches", async () => {
  let requested = "";
  let options: RequestInit | undefined;
  const fetcher = async (url: string, init: RequestInit) => {
    requested = String(url);
    options = init;
    return Response.json(wire);
  };
  const value = await Effect.runPromise(fetchServerDescriptor(fetcher));
  expect(requested).toBe("/api/capabilities");
  expect(options?.cache).toBe("no-store");
  expect(options?.signal).toBeInstanceOf(AbortSignal);
  expect(value?.capabilities).toEqual({ deskVoice: true });
});

test("old, unreachable and malformed servers support nothing", async () => {
  for (const response of [
    new Response("missing", { status: 404 }),
    Response.json({ capabilities: {} }),
    Response.json("not a descriptor"),
  ]) {
    expect(
      await Effect.runPromise(fetchServerDescriptor(async () => response)),
    ).toBeNull();
  }
  expect(
    await Effect.runPromise(
      fetchServerDescriptor(async () => {
        throw new Error("offline");
      }),
    ),
  ).toBeNull();
});

test("hello absence and downgrade revoke previously advertised features", () => {
  let notifications = 0;
  const unsubscribe = subscribeServerDescriptor(() => notifications++);
  publishServerDescriptor({ ...wire, capabilities: { deskVoice: true } });
  expect(supportsCapability(serverDescriptorSnapshot(), "deskVoice")).toBe(
    true,
  );
  publishServerDescriptor({ ...wire, capabilities: {} });
  expect(supportsCapability(serverDescriptorSnapshot(), "deskVoice")).toBe(
    false,
  );
  publishServerDescriptor(undefined);
  expect(serverDescriptorSnapshot()).toBeNull();
  expect(notifications).toBe(3);
  unsubscribe();
});

test("late HTTP bootstrap cannot overwrite a downgrade hello", async () => {
  let release: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const pending = Effect.runPromise(
    refreshServerDescriptorEffect(async () => response),
  );
  publishServerDescriptor({ ...wire, capabilities: {} });
  release(Response.json(wire));
  await pending;
  expect(supportsCapability(serverDescriptorSnapshot(), "deskVoice")).toBe(
    false,
  );
  publishServerDescriptor(null);
});
