import { createLinuxPeerCredentialVerifier } from "../linux-peer-credentials";
import { createVerifiedUnixSocketServer } from "../unix-socket-security";

const inheritedFd = Number(process.env.TEST_INHERITED_FD);
const expectedUid = Number(process.env.TEST_EXPECTED_UID);
const verifier = await createLinuxPeerCredentialVerifier();
const server = createVerifiedUnixSocketServer(
  verifier,
  { uid: expectedUid },
  ({ socket, peer }) => {
    socket.end(`verified:${peer.uid}`);
  },
  (error) => console.error(error.message),
  { listenerMode: "inherited-fd-only" },
);

await server.listen({ inheritedFd });
console.log("ready");

process.once("SIGTERM", () => {
  void server.closeAndDrain().finally(() => {
    verifier.close();
    process.exit(0);
  });
});
