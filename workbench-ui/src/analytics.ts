import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { PostHog } from "posthog-node";
import { SPLASH_VERSION } from "./media/splash";
import { workbenchDir } from "./state/workbench-paths";

const DEFAULT_POSTHOG_KEY = "phc_CdzkdtByGpBEadwSyG5UwmCT2GSdcg4scmWtq9Fdrm9N";
const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const ANONYMOUS_ID_FILE = "analytics-id";

type AnalyticsProperties = Record<
  string,
  boolean | number | string | null | undefined
>;

let client: PostHog | undefined;
let distinctId: string | undefined;
let stopped = false;

export function analyticsEnabled(
  env: Record<string, string | undefined> = Bun.env
): boolean {
  return !(
    env.WORKBENCH_TELEMETRY === "0" ||
    env.DO_NOT_TRACK === "1" ||
    env.WORKBENCH_CLI_HOT === "1" ||
    env.WORKBENCH_UI_E2E === "1" ||
    env.WORKBENCH_UI_SCREENSHOT === "1" ||
    env.NODE_ENV === "test"
  );
}

export function captureAnalytics(
  event: string,
  properties: AnalyticsProperties = {}
): void {
  const analytics = analyticsClient();
  const anonymousId = analyticsDistinctId();
  if (!(analytics && anonymousId)) {
    return;
  }
  analytics.capture({
    distinctId: anonymousId,
    event,
    properties: {
      ...properties,
      $process_person_profile: false,
      app_version: SPLASH_VERSION,
      architecture: arch(),
      platform: platform(),
    },
  });
}

export async function shutdownAnalytics(): Promise<void> {
  if (stopped) {
    return;
  }
  stopped = true;
  const analytics = client;
  client = undefined;
  if (!analytics) {
    return;
  }
  try {
    await analytics.shutdown(750);
  } catch {
    // Analytics must never delay or prevent Workbench shutdown.
  }
}

function analyticsClient(): PostHog | undefined {
  if (stopped || !analyticsEnabled()) {
    return;
  }
  client ??= new PostHog(Bun.env.WORKBENCH_POSTHOG_KEY ?? DEFAULT_POSTHOG_KEY, {
    disableGeoip: true,
    enableExceptionAutocapture: false,
    flushAt: 1,
    flushInterval: 0,
    host: Bun.env.WORKBENCH_POSTHOG_HOST ?? DEFAULT_POSTHOG_HOST,
    maxQueueSize: 100,
    privacyMode: true,
  });
  return client;
}

function analyticsDistinctId(): string | undefined {
  if (distinctId) {
    return distinctId;
  }
  try {
    const directory = workbenchDir();
    const path = join(directory, ANONYMOUS_ID_FILE);
    mkdirSync(directory, { recursive: true });
    try {
      const saved = readFileSync(path, "utf8").trim();
      if (saved) {
        distinctId = saved;
        return distinctId;
      }
    } catch {
      // Create an identifier below.
    }
    distinctId = crypto.randomUUID();
    writeFileSync(path, `${distinctId}\n`, { mode: 0o600 });
    return distinctId;
  } catch {
    return;
  }
}
