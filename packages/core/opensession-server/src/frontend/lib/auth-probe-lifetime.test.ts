import { expect, test } from "bun:test";
import {
  beginClientLogout,
  captureAuthProbeEpoch,
  isCurrentAuthProbeEpoch,
} from "./auth-probe-lifetime";

test("logout fences delayed A GET and focus probes while logout POST is pending", async () => {
  const get = Promise.withResolvers<void>();
  const post = Promise.withResolvers<void>();
  let published = 0;
  const epoch = captureAuthProbeEpoch();
  expect(isCurrentAuthProbeEpoch(epoch)).toBe(true);
  const probe = get.promise.then(() => {
    if (isCurrentAuthProbeEpoch(epoch)) published++;
  });
  beginClientLogout();
  const logout = post.promise;
  expect(captureAuthProbeEpoch()).toBeNull();
  get.resolve();
  await probe;
  expect(published).toBe(0);
  expect(isCurrentAuthProbeEpoch(epoch)).toBe(false);
  post.resolve();
  await logout;
  expect(captureAuthProbeEpoch()).toBeNull();
});
