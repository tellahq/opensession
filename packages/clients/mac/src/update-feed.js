// Where the app looks for its own updates.
//
// Squirrel.Mac reads a static JSON feed (Electron's `serverType: "json"`): the
// current version and where its zip is. The app follows the organization it is
// pointed at: a team server serves that feed itself, for the build its people
// should run. "This Mac" has no server to ask but the one inside the app, so
// it reads the feed file each release publishes beside its zip, straight from
// the repository this build came from. That keeps an install whose own server
// will not start able to update its way out.
//
// Squirrel installs only a build signed by the identity the running app
// carries, whichever feed named it.
const FEED_ASSET = "OpenSession-arm64-update.json";
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

/** The feed file of the latest release of `repo` ("owner/name"), or null. */
function publicFeedUrl(repo) {
  if (typeof repo !== "string" || !REPO.test(repo)) return null;
  return `https://github.com/${repo}/releases/latest/download/${FEED_ASSET}`;
}

/** The feed for the organization in use, or null when there is none to ask.
 * `override` is for trying an update against a feed served by hand. */
function updateFeedUrl({ origin, local, version, releaseRepo, override }) {
  if (override) return override;
  if (local) return publicFeedUrl(releaseRepo);
  if (!origin) return null;
  return `${origin}/api/packages/clients/mac/update?version=${encodeURIComponent(version)}`;
}

/** The feed file a release publishes: Squirrel updates to `currentRelease`
 * whenever the running app is another version. */
function releaseFeed({ repo, tag, publishedAt = new Date() }) {
  const version = String(tag || "").replace(/^v/, "");
  if (!REPO.test(String(repo)) || !VERSION.test(version))
    throw new Error(`Cannot write an update feed for ${repo} ${tag}`);
  return {
    currentRelease: version,
    releases: [
      {
        version,
        updateTo: {
          version,
          name: `v${version}`,
          pub_date: new Date(publishedAt).toISOString(),
          notes: `https://github.com/${repo}/releases/tag/${tag}`,
          url: `https://github.com/${repo}/releases/download/${tag}/OpenSession-${version}-arm64.zip`,
        },
      },
    ],
  };
}

module.exports = { FEED_ASSET, publicFeedUrl, releaseFeed, updateFeedUrl };
