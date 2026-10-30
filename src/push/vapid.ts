import { existsSync, linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import webpush from "web-push";

export const VAPID_FILE = "vapid.json";
const VAPID_SUBJECT = "mailto:sandcastle@localhost.invalid";

/** The private key never leaves the server process: it is not part of any state, route or log line. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

function parse(raw: string): VapidKeys | undefined {
  try {
    const value = JSON.parse(raw) as Partial<VapidKeys>;
    if (typeof value.publicKey !== "string" || typeof value.privateKey !== "string") return undefined;
    return { publicKey: value.publicKey, privateKey: value.privateKey, subject: value.subject ?? VAPID_SUBJECT };
  } catch {
    return undefined;
  }
}

/** Reads `<dir>/vapid.json`, generating it (owner-only) on first use. A corrupt file is an error, never silently replaced: that would orphan every subscription. */
export function loadOrCreateVapid(dir: string): VapidKeys {
  const file = join(dir, VAPID_FILE);
  if (existsSync(file)) {
    const keys = parse(readFileSync(file, "utf8"));
    if (!keys) throw new Error(`${file} is not a valid VAPID key file; delete it to regenerate (existing push subscriptions will stop working)`);
    return keys;
  }
  mkdirSync(dir, { recursive: true });
  const keys: VapidKeys = { ...webpush.generateVAPIDKeys(), subject: VAPID_SUBJECT };
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  try {
    // link fails if another process created the file first, so concurrent starts never replace (and orphan) each other's keys
    linkSync(temp, file);
    return keys;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    return loadOrCreateVapid(dir);
  } finally {
    unlinkSync(temp);
  }
}
