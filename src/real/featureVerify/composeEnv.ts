import type { TargetRepo } from "../../model/runModel.js";
import { ENV_PLACEHOLDER } from "../../project/projectConfig.js";

export const MONGO_ALIAS = "mongo";
export const MONGO_PORT = 27017;

const MONGO_URI = /mongodb(?:\+srv)?:\/\/\S*/gi;
const SRV_SCHEME = /^mongodb\+srv:\/\//i;
const PLAIN_SCHEME = /^mongodb:\/\//i;
const CREDENTIALS = /^[^@/]*@/;
const CREDENTIAL_KEY = /TOKEN|SECRET|KEY|PASSWORD/i;

export function verifyDatabaseName(feature: string): string {
  return `sandcastle_verify_${feature.replace(/[^A-Za-z0-9]+/g, "_")}`;
}

export function localMongoUri(feature: string): string {
  return `mongodb://${MONGO_ALIAS}:${MONGO_PORT}/${verifyDatabaseName(feature)}`;
}

export function serviceBaseUrl(repo: TargetRepo, port: number): string {
  return `http://${repo}:${port}`;
}

export function pointsAtLocalMongo(uri: string): boolean {
  if (SRV_SCHEME.test(uri)) return false;
  const authority = uri.replace(PLAIN_SCHEME, "").replace(CREDENTIALS, "").split(/[/?]/)[0] ?? "";
  const hosts = authority
    .split(",")
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  if (hosts.length === 0) return false;
  return hosts.every((host) => host === MONGO_ALIAS || host === `${MONGO_ALIAS}:${MONGO_PORT}`);
}

export function foreignMongoUris(value: string): string[] {
  return [...value.matchAll(MONGO_URI)].map((match) => match[0]).filter((uri) => !pointsAtLocalMongo(uri));
}

export function credentialKeys(env: Readonly<Record<string, string>>): string[] {
  return Object.keys(env)
    .filter((key) => CREDENTIAL_KEY.test(key) && (env[key] ?? "").length > 0)
    .sort();
}

export function assertLocalMongoOnly(env: Readonly<Record<string, string>>, source: string): void {
  for (const [key, value] of Object.entries(env)) {
    const foreign = foreignMongoUris(value);
    if (foreign.length === 0) continue;
    throw new Error(
      `${source} points ${key} at ${foreign[0]}, a database outside the throwaway compose environment — ` +
        `feature verify only composes an environment whose every mongo URI is the local \`${MONGO_ALIAS}\` container. ` +
        `Point it at mongodb://${MONGO_ALIAS}:${MONGO_PORT}, or drop the key.`,
    );
  }
}

export interface ComposeEnvService {
  port: number;
  env: Readonly<Record<string, string>>;
}

export interface ComposeEnvInput {
  repo: TargetRepo;
  sandboxEnv: Readonly<Record<string, string>>;
  feature: string;
  services: Readonly<Record<TargetRepo, ComposeEnvService>>;
  source: string;
}

/** Expands {{port}}, {{mongoUri}}, {{mongoDb}} and {{url:<repo>}} in a service's configured env. */
export function expandPlaceholders(value: string, input: ComposeEnvInput): string {
  return value.replace(ENV_PLACEHOLDER,(match, name: string, arg: string | undefined) => {
    if (name === "port") return String(serviceOf(input, input.repo).port);
    if (name === "mongoUri") return localMongoUri(input.feature);
    if (name === "mongoDb") return verifyDatabaseName(input.feature);
    if (name === "url" && arg) return serviceBaseUrl(arg, serviceOf(input, arg).port);
    throw new Error(`${input.source}: unknown placeholder ${match} in the verify env for ${input.repo}`);
  });
}

function serviceOf(input: ComposeEnvInput, repo: TargetRepo): ComposeEnvService {
  const service = input.services[repo];
  if (!service) throw new Error(`the verify env for ${input.repo} references "${repo}", which has no compose service`);
  return service;
}

function overridesFor(input: ComposeEnvInput): Record<string, string> {
  const overrides: Record<string, string> = { NODE_ENV: "development", PORT: String(serviceOf(input, input.repo).port) };
  for (const [key, value] of Object.entries(serviceOf(input, input.repo).env)) overrides[key] = expandPlaceholders(value, input);
  return overrides;
}

export function composeServiceEnv(input: ComposeEnvInput): Record<string, string> {
  const env = { ...input.sandboxEnv, ...overridesFor(input) };
  assertLocalMongoOnly(env, input.source);
  return env;
}
