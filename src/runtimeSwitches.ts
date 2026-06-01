import { rename, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type RuntimeSwitches = {
  groupFixedReplyEnabled: boolean;
  directFixedReplyEnabled: boolean;
  directSmartReplyEnabled: boolean;
  updatedAt?: string;
};

export const defaultRuntimeSwitches: RuntimeSwitches = {
  groupFixedReplyEnabled: true,
  directFixedReplyEnabled: true,
  directSmartReplyEnabled: true
};

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const switchesFile = resolve(rootDir, process.env.LARK_AUTOREPLY_SWITCHES_FILE || ".lark-auto-reply-switches.json");

export async function loadRuntimeSwitches(): Promise<RuntimeSwitches> {
  try {
    return normalizeRuntimeSwitches(JSON.parse(await readFile(switchesFile, "utf8")) as Partial<RuntimeSwitches>);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { ...defaultRuntimeSwitches };
    }
    throw error;
  }
}

export async function saveRuntimeSwitches(switches: RuntimeSwitches): Promise<RuntimeSwitches> {
  const nextSwitches = normalizeRuntimeSwitches({ ...switches, updatedAt: new Date().toISOString() });
  const temporaryFile = `${switchesFile}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(nextSwitches, null, 2)}\n`, "utf8");
  await rename(temporaryFile, switchesFile);
  return nextSwitches;
}

export function normalizeRuntimeSwitches(value: Partial<RuntimeSwitches>): RuntimeSwitches {
  return {
    groupFixedReplyEnabled: readBoolean(value.groupFixedReplyEnabled, defaultRuntimeSwitches.groupFixedReplyEnabled),
    directFixedReplyEnabled: readBoolean(value.directFixedReplyEnabled, defaultRuntimeSwitches.directFixedReplyEnabled),
    directSmartReplyEnabled: readBoolean(value.directSmartReplyEnabled, defaultRuntimeSwitches.directSmartReplyEnabled),
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined
  };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === "object" && "code" in error);
}