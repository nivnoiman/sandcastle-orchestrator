import { describe, expect, it } from "vitest";
import {
  assertLocalMongoOnly,
  composeServiceEnv,
  credentialKeys,
  foreignMongoUris,
  localMongoUri,
  verifyDatabaseName,
} from "../../../src/real/featureVerify/composeEnv.js";

const SERVICES = {
  api: { port: 5000, env: { MONGO_URI: "{{mongoUri}}", MONGO_DB: "{{mongoDb}}", BASE_URL: "{{url:api}}" } },
  web: { port: 4173, env: { VITE_ENV: "development", VITE_API_BASE_URL: "{{url:api}}" } },
};

function envFor(sandboxEnv: Record<string, string>): Record<string, string> {
  return composeServiceEnv({ repo: "api", sandboxEnv, feature: "toy-demo", services: SERVICES, source: "the test env" });
}

describe("mongo reachability", () => {
  it("accepts the local mongo container by alias, with or without the port", () => {
    expect(foreignMongoUris(localMongoUri("toy-demo"))).toEqual([]);
    expect(foreignMongoUris("mongodb://mongo/sandcastle")).toEqual([]);
  });

  it("rejects any hosted cluster, whatever the brand", () => {
    expect(foreignMongoUris("mongodb+srv://u:p@cluster0.abc.mongodb.net/prod")).toHaveLength(1);
    expect(foreignMongoUris("mongodb://u:p@db.someprovider.io:27017/prod")).toHaveLength(1);
  });

  it("rejects a local-looking host that is not the compose mongo", () => {
    expect(foreignMongoUris("mongodb://localhost:27017/dev")).toHaveLength(1);
    expect(foreignMongoUris("mongodb://127.0.0.1:27017/dev")).toHaveLength(1);
  });

  it("rejects a replica set that smuggles one foreign host in", () => {
    expect(foreignMongoUris("mongodb://mongo:27017,shard.example.com:27017/db")).toHaveLength(1);
  });

  it("catches a mongo uri in any key, not just MONGO_URI", () => {
    expect(() => assertLocalMongoOnly({ ANALYTICS_DSN: "mongodb://analytics.example.com/db" }, "the sandbox env")).toThrow(
      /outside the throwaway compose environment/,
    );
  });

  it("catches a mongo uri buried inside a longer value", () => {
    expect(() =>
      assertLocalMongoOnly({ EXTRA_ARGS: "--uri mongodb+srv://u:p@cluster0.abc.mongodb.net/prod --quiet" }, "the sandbox env"),
    ).toThrow(/mongodb\+srv/);
  });

  it("refuses to compose an env that can still reach a foreign database", () => {
    expect(() => envFor({ MONGO_ANALYTICS_URI: "mongodb+srv://u:p@cluster0.abc.mongodb.net/prod" })).toThrow(
      /feature verify only composes/,
    );
  });

  it("still overrides MONGO_URI onto the throwaway container", () => {
    expect(envFor({ MONGO_URI: "" })["MONGO_URI"]).toBe(localMongoUri("toy-demo"));
  });

  it("overrides MONGO_DB too, because the api prefers it over the uri's database", () => {
    const env = envFor({ MONGO_URI: "", MONGO_DB: "sandcastle_dev" });
    expect(env["MONGO_DB"]).toBe(verifyDatabaseName("toy-demo"));
    expect(localMongoUri("toy-demo")).toContain(env["MONGO_DB"] as string);
  });
});

describe("credential visibility", () => {
  it("names the credential-shaped keys that survive into the compose env", () => {
    expect(credentialKeys({ JWT_SECRET: "dev", META_TOKEN: "x", API_KEY: "y", PASSWORD: "z", PORT: "5000" })).toEqual([
      "API_KEY",
      "JWT_SECRET",
      "META_TOKEN",
      "PASSWORD",
    ]);
  });

  it("says nothing about a key whose value is empty", () => {
    expect(credentialKeys({ META_TOKEN: "" })).toEqual([]);
  });
});
