import { type AscClient, type AscResource, query, single } from "./asc";
import { platformProfile } from "./platforms";
import type { ApplePlatform, AppStoreReleaseType } from "./types";

type App = AscResource<{ bundleId?: string; name?: string; sku?: string }>;
type BundleId = AscResource<{
  identifier?: string;
  name?: string;
  platform?: string;
}>;
type Build = AscResource<{
  version?: string;
  processingState?: string;
  uploadedDate?: string;
  expired?: boolean;
  usesNonExemptEncryption?: boolean | null;
}>;
type AppStoreVersion = AscResource<{
  versionString?: string;
  platform?: string;
  appStoreState?: string;
  appVersionState?: string;
  releaseType?: string;
  createdDate?: string;
}>;
type BetaGroup = AscResource<{
  name?: string;
  isInternalGroup?: boolean;
  hasAccessToAllBuilds?: boolean;
  publicLinkEnabled?: boolean;
}>;

export const APP_STORE_CONNECT_APPS_URL =
  "https://appstoreconnect.apple.com/apps";

/** Version states where the version, its build, and its metadata can still be
 *  edited and submitted. */
const EDITABLE_VERSION_STATES = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
]);

function versionState(version: AppStoreVersion): string {
  return (
    version.attributes?.appVersionState ??
    version.attributes?.appStoreState ??
    "UNKNOWN"
  );
}

export async function findApp(
  client: AscClient,
  bundleId: string,
): Promise<App | undefined> {
  const { data } = await client.list<NonNullable<App["attributes"]>>(
    query("/v1/apps", { "filter[bundleId]": bundleId, limit: 50 }),
    1,
  );
  return data.find((app) => app.attributes?.bundleId === bundleId);
}

export async function requireApp(
  client: AscClient,
  bundleId: string,
): Promise<App> {
  const app = await findApp(client, bundleId);
  if (!app) {
    throw new Error(
      `App Store Connect has no app with bundle ID ${bundleId}. Create it at ${APP_STORE_CONNECT_APPS_URL} (New App), or run apple_release_app_status for the exact values.`,
    );
  }
  return app;
}

export async function findBundleId(
  client: AscClient,
  identifier: string,
): Promise<BundleId | undefined> {
  const { data } = await client.list<NonNullable<BundleId["attributes"]>>(
    query("/v1/bundleIds", { "filter[identifier]": identifier, limit: 50 }),
    1,
  );
  return data.find((bundle) => bundle.attributes?.identifier === identifier);
}

/** Apple allows only letters, numbers, and spaces in a bundle ID's name. */
export function bundleIdName(name: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "App"
  );
}

export async function registerBundleId(
  client: AscClient,
  input: { identifier: string; name: string; platform: ApplePlatform },
) {
  const existing = await findBundleId(client, input.identifier);
  if (existing) {
    return { created: false, id: existing.id, identifier: input.identifier };
  }
  const created = single(
    await client.request<NonNullable<BundleId["attributes"]>>(
      "POST",
      "/v1/bundleIds",
      {
        data: {
          type: "bundleIds",
          attributes: {
            identifier: input.identifier,
            name: bundleIdName(input.name),
            platform: platformProfile(input.platform).asc,
          },
        },
      },
    ),
    "bundle ID",
  );
  return { created: true, id: created.id, identifier: input.identifier };
}

function buildNumberValue(version: string | undefined): number | undefined {
  if (!version || !/^\d+$/.test(version)) return undefined;
  return Number(version);
}

/** The next integer build number: one above every build uploaded for the app,
 *  across all versions, because App Store Connect requires uniqueness there
 *  for most apps and a monotonic number is never wrong. */
export async function nextBuildNumber(
  client: AscClient,
  appId: string,
): Promise<string> {
  const { data } = await client.list<NonNullable<Build["attributes"]>>(
    query("/v1/builds", {
      "filter[app]": appId,
      "fields[builds]": "version",
      sort: "-uploadedDate",
      limit: 200,
    }),
    5,
  );
  const highest = data
    .map((build) => buildNumberValue(build.attributes?.version))
    .filter((value): value is number => value !== undefined)
    .reduce((max, value) => Math.max(max, value), 0);
  return String(highest + 1);
}

function summarizeBuild(build: Build, included: AscResource[]) {
  const preRelease = build.relationships?.preReleaseVersion?.data;
  const versionRef = Array.isArray(preRelease) ? undefined : preRelease;
  const version = versionRef
    ? included.find(
        (item) => item.type === versionRef.type && item.id === versionRef.id,
      )
    : undefined;
  return {
    id: build.id,
    marketingVersion:
      (version?.attributes?.version as string | undefined) ?? null,
    buildNumber: build.attributes?.version ?? null,
    processingState: build.attributes?.processingState ?? null,
    uploadedDate: build.attributes?.uploadedDate ?? null,
    expired: build.attributes?.expired ?? false,
    exportCompliance:
      build.attributes?.usesNonExemptEncryption === undefined ||
      build.attributes?.usesNonExemptEncryption === null
        ? "missing"
        : "declared",
  };
}

export async function recentBuilds(
  client: AscClient,
  appId: string,
  limit = 10,
) {
  const document = await client.get<NonNullable<Build["attributes"]>>(
    query("/v1/builds", {
      "filter[app]": appId,
      sort: "-uploadedDate",
      limit,
      include: "preReleaseVersion",
    }),
  );
  const data = Array.isArray(document.data) ? document.data : [document.data];
  return data.map((build) => summarizeBuild(build, document.included ?? []));
}

export async function findBuild(
  client: AscClient,
  input: {
    appId: string;
    buildNumber: string;
    marketingVersion?: string;
    platform: ApplePlatform;
  },
) {
  const document = await client.get<NonNullable<Build["attributes"]>>(
    query("/v1/builds", {
      "filter[app]": input.appId,
      "filter[version]": input.buildNumber,
      "filter[preReleaseVersion.version]": input.marketingVersion,
      "filter[preReleaseVersion.platform]": platformProfile(input.platform).asc,
      include: "preReleaseVersion",
      limit: 10,
    }),
  );
  const builds = (
    Array.isArray(document.data) ? document.data : [document.data]
  ).map((build) => summarizeBuild(build, document.included ?? []));
  if (builds.length === 0) {
    throw new Error(
      `No build ${input.buildNumber}${input.marketingVersion ? ` for version ${input.marketingVersion}` : ""} in App Store Connect`,
    );
  }
  if (builds.length > 1) {
    throw new Error(
      `Build ${input.buildNumber} exists for several versions (${builds.map((build) => build.marketingVersion).join(", ")}); pass marketingVersion`,
    );
  }
  return builds[0]!;
}

function requireProcessed(build: ReturnType<typeof summarizeBuild>) {
  if (build.processingState !== "VALID") {
    throw new Error(
      `Build ${build.buildNumber} is ${build.processingState ?? "not processed"}; wait until App Store Connect finishes processing it`,
    );
  }
  if (build.expired) throw new Error(`Build ${build.buildNumber} has expired`);
}

export async function appVersions(
  client: AscClient,
  appId: string,
  platform: ApplePlatform,
) {
  const { data } = await client.list<
    NonNullable<AppStoreVersion["attributes"]>
  >(
    query(`/v1/apps/${appId}/appStoreVersions`, {
      "filter[platform]": platformProfile(platform).asc,
      limit: 10,
    }),
    1,
  );
  return data;
}

async function betaGroups(client: AscClient, appId: string) {
  const { data } = await client.list<NonNullable<BetaGroup["attributes"]>>(
    query(`/v1/apps/${appId}/betaGroups`, { limit: 50 }),
    2,
  );
  return data;
}

export interface AppStatusInput {
  bundleId: string;
  platform: ApplePlatform;
  name?: string;
}

/** Everything needed to know what to do next for one app, read-only. */
export async function appStatus(client: AscClient, input: AppStatusInput) {
  const nextSteps: string[] = [];
  const bundle = await findBundleId(client, input.bundleId);
  const app = await findApp(client, input.bundleId);
  if (!bundle) {
    nextSteps.push(
      `Register the bundle ID with apple_release_register_bundle_id.`,
    );
  }
  if (!app) {
    nextSteps.push(
      `Create the app record at ${APP_STORE_CONNECT_APPS_URL}: New App, platform ${platformProfile(input.platform).xcodegen}, bundle ID ${input.bundleId}, SKU ${input.bundleId}${input.name ? `, name ${input.name}` : ""}. Apple's API cannot create app records.`,
    );
    return {
      bundleId: input.bundleId,
      bundleIdRegistered: Boolean(bundle),
      app: null,
      nextSteps,
    };
  }
  const [builds, versions, groups] = await Promise.all([
    recentBuilds(client, app.id),
    appVersions(client, app.id, input.platform),
    betaGroups(client, app.id),
  ]);
  if (builds.length === 0) {
    nextSteps.push("Upload a first build with apple_release_plan_testflight.");
  }
  const processing = builds.filter(
    (build) => build.processingState === "PROCESSING",
  );
  if (processing.length) {
    nextSteps.push(
      `Wait for App Store Connect to finish processing build ${processing.map((build) => build.buildNumber).join(", ")}.`,
    );
  }
  if (
    builds.some(
      (build) =>
        build.processingState === "VALID" &&
        build.exportCompliance === "missing",
    )
  ) {
    nextSteps.push(
      "Some builds are missing export compliance. Set ITSAppUsesNonExemptEncryption in Info.plist, or answer the question in App Store Connect.",
    );
  }
  if (!groups.some((group) => group.attributes?.isInternalGroup)) {
    nextSteps.push(
      "Create an internal TestFlight group in App Store Connect to give teammates builds.",
    );
  }
  return {
    bundleId: input.bundleId,
    bundleIdRegistered: Boolean(bundle),
    app: {
      id: app.id,
      name: app.attributes?.name ?? null,
      sku: app.attributes?.sku ?? null,
      url: `${APP_STORE_CONNECT_APPS_URL}/${app.id}`,
    },
    builds,
    appStoreVersions: versions.map((version) => ({
      id: version.id,
      versionString: version.attributes?.versionString ?? null,
      state: versionState(version),
      releaseType: version.attributes?.releaseType ?? null,
    })),
    betaGroups: groups.map((group) => ({
      id: group.id,
      name: group.attributes?.name ?? null,
      internal: group.attributes?.isInternalGroup ?? false,
      receivesEveryBuild: group.attributes?.hasAccessToAllBuilds ?? false,
    })),
    nextSteps,
  };
}

/** Adds "What to Test" notes and hands a processed build to internal groups.
 *  External groups need Beta App Review and stay out of this tool. */
export async function distributeTestFlight(
  client: AscClient,
  input: {
    bundleId: string;
    platform: ApplePlatform;
    buildNumber: string;
    marketingVersion?: string;
    whatToTest?: string;
    groups?: string[];
    locale?: string;
  },
) {
  const app = await requireApp(client, input.bundleId);
  const build = await findBuild(client, { appId: app.id, ...input });
  requireProcessed(build);
  const effects: string[] = [];

  if (input.whatToTest !== undefined) {
    const locale = input.locale ?? "en-US";
    const { data: localizations } = await client.list<{
      locale?: string;
      whatsNew?: string;
    }>(`/v1/builds/${build.id}/betaBuildLocalizations`, 1);
    const existing = localizations.find(
      (item) => item.attributes?.locale === locale,
    );
    if (existing) {
      await client.request(
        "PATCH",
        `/v1/betaBuildLocalizations/${existing.id}`,
        {
          data: {
            type: "betaBuildLocalizations",
            id: existing.id,
            attributes: { whatsNew: input.whatToTest },
          },
        },
      );
    } else {
      await client.request("POST", "/v1/betaBuildLocalizations", {
        data: {
          type: "betaBuildLocalizations",
          attributes: { locale, whatsNew: input.whatToTest },
          relationships: {
            build: { data: { type: "builds", id: build.id } },
          },
        },
      });
    }
    effects.push(`Set What to Test (${locale})`);
  }

  if (input.groups?.length) {
    const groups = await betaGroups(client, app.id);
    const selected = input.groups.map((name) => {
      const group = groups.find((item) => item.attributes?.name === name);
      if (!group) {
        throw new Error(
          `No TestFlight group named ${name}; groups: ${groups.map((item) => item.attributes?.name).join(", ") || "none"}`,
        );
      }
      if (!group.attributes?.isInternalGroup) {
        throw new Error(
          `${name} is an external group. External testing needs Beta App Review; add the build in App Store Connect.`,
        );
      }
      return group;
    });
    const needed = selected.filter(
      (group) => !group.attributes?.hasAccessToAllBuilds,
    );
    if (needed.length) {
      await client.request(
        "POST",
        `/v1/builds/${build.id}/relationships/betaGroups`,
        {
          data: needed.map((group) => ({ type: "betaGroups", id: group.id })),
        },
      );
    }
    for (const group of selected) {
      effects.push(
        group.attributes?.hasAccessToAllBuilds
          ? `${group.attributes?.name} already receives every build`
          : `Added to ${group.attributes?.name}`,
      );
    }
  }
  return { build, effects };
}

/** Read-only checks used while planning a submission, so the approver sees a
 *  build that exists and is processed. */
export async function checkSubmission(
  client: AscClient,
  input: {
    bundleId: string;
    platform: ApplePlatform;
    marketingVersion: string;
    buildNumber: string;
  },
) {
  const app = await requireApp(client, input.bundleId);
  const build = await findBuild(client, { appId: app.id, ...input });
  requireProcessed(build);
  const versions = await appVersions(client, app.id, input.platform);
  const existing = versions.find(
    (version) => version.attributes?.versionString === input.marketingVersion,
  );
  if (existing && !EDITABLE_VERSION_STATES.has(versionState(existing))) {
    throw new Error(
      `Version ${input.marketingVersion} is ${versionState(existing)} and cannot be submitted`,
    );
  }
  return {
    app,
    build,
    existingVersion: existing
      ? { id: existing.id, state: versionState(existing) }
      : null,
  };
}

/** Creates or reuses the App Store version, attaches the build, and submits it
 *  for App Review. */
export async function submitForReview(
  client: AscClient,
  input: {
    bundleId: string;
    platform: ApplePlatform;
    marketingVersion: string;
    buildNumber: string;
    releaseType: AppStoreReleaseType;
    whatsNew?: string;
  },
) {
  const checked = await checkSubmission(client, input);
  const ascPlatform = platformProfile(input.platform).asc;
  const releaseType =
    input.releaseType === "manual" ? "MANUAL" : "AFTER_APPROVAL";
  let versionId = checked.existingVersion?.id;
  if (versionId) {
    await client.request("PATCH", `/v1/appStoreVersions/${versionId}`, {
      data: {
        type: "appStoreVersions",
        id: versionId,
        attributes: { releaseType },
      },
    });
  } else {
    versionId = single(
      await client.request("POST", "/v1/appStoreVersions", {
        data: {
          type: "appStoreVersions",
          attributes: {
            platform: ascPlatform,
            versionString: input.marketingVersion,
            releaseType,
          },
          relationships: {
            app: { data: { type: "apps", id: checked.app.id } },
          },
        },
      }),
      "App Store version",
    ).id;
  }

  await client.request(
    "PATCH",
    `/v1/appStoreVersions/${versionId}/relationships/build`,
    { data: { type: "builds", id: checked.build.id } },
  );

  if (input.whatsNew !== undefined) {
    const { data: localizations } = await client.list(
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
      1,
    );
    for (const localization of localizations) {
      await client.request(
        "PATCH",
        `/v1/appStoreVersionLocalizations/${localization.id}`,
        {
          data: {
            type: "appStoreVersionLocalizations",
            id: localization.id,
            attributes: { whatsNew: input.whatsNew },
          },
        },
      );
    }
  }

  // Reuse a draft submission if one is open; App Store Connect allows one.
  const { data: drafts } = await client.list<{ state?: string }>(
    query("/v1/reviewSubmissions", {
      "filter[app]": checked.app.id,
      "filter[platform]": ascPlatform,
      "filter[state]": "READY_FOR_REVIEW",
      limit: 10,
    }),
    1,
  );
  const submissionId =
    drafts[0]?.id ??
    single(
      await client.request("POST", "/v1/reviewSubmissions", {
        data: {
          type: "reviewSubmissions",
          attributes: { platform: ascPlatform },
          relationships: {
            app: { data: { type: "apps", id: checked.app.id } },
          },
        },
      }),
      "review submission",
    ).id;

  const { data: items } = await client.list(
    query(`/v1/reviewSubmissions/${submissionId}/items`, {
      include: "appStoreVersion",
      limit: 50,
    }),
    1,
  );
  const alreadyIncluded = items.some((item) => {
    const ref = item.relationships?.appStoreVersion?.data;
    return !Array.isArray(ref) && ref?.id === versionId;
  });
  if (!alreadyIncluded) {
    await client.request("POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: {
            data: { type: "reviewSubmissions", id: submissionId },
          },
          appStoreVersion: {
            data: { type: "appStoreVersions", id: versionId },
          },
        },
      },
    });
  }

  const submitted = single<{ state?: string }>(
    await client.request<{ state?: string }>(
      "PATCH",
      `/v1/reviewSubmissions/${submissionId}`,
      {
        data: {
          type: "reviewSubmissions",
          id: submissionId,
          attributes: { submitted: true },
        },
      },
    ),
    "review submission",
  );
  return {
    appId: checked.app.id,
    appStoreVersionId: versionId,
    buildId: checked.build.id,
    reviewSubmissionId: submissionId,
    reviewSubmissionState: submitted.attributes?.state ?? null,
  };
}

export async function checkRelease(
  client: AscClient,
  input: {
    bundleId: string;
    platform: ApplePlatform;
    marketingVersion: string;
  },
) {
  const app = await requireApp(client, input.bundleId);
  const versions = await appVersions(client, app.id, input.platform);
  const version = versions.find(
    (item) => item.attributes?.versionString === input.marketingVersion,
  );
  if (!version) {
    throw new Error(`No App Store version ${input.marketingVersion}`);
  }
  if (versionState(version) !== "PENDING_DEVELOPER_RELEASE") {
    throw new Error(
      `Version ${input.marketingVersion} is ${versionState(version)}; only an approved version waiting for developer release can be released`,
    );
  }
  return { app, versionId: version.id };
}

/** Releases an approved, manually released version to the App Store. */
export async function releaseVersion(
  client: AscClient,
  input: {
    bundleId: string;
    platform: ApplePlatform;
    marketingVersion: string;
  },
) {
  const { app, versionId } = await checkRelease(client, input);
  await client.request("POST", "/v1/appStoreVersionReleaseRequests", {
    data: {
      type: "appStoreVersionReleaseRequests",
      relationships: {
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  });
  return { appId: app.id, appStoreVersionId: versionId, released: true };
}
