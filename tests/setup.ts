import { parseProjectConfig, setActiveProject } from "../src/project/projectConfig.js";

export const TEST_PROJECT = parseProjectConfig(
  {
    name: "demo",
    hubRepo: "example-org/hub",
    memoryProject: "demo-project",
    imageTag: "sandcastle:demo",
    repos: {
      api: {
        github: "example-org/api",
        path: "../api",
        bootstrap: "npm ci",
        checks: "npx tsc -p tsconfig.ci.json --noEmit && npx jest --ci --forceExit",
      },
      web: { github: "example-org/web", path: "../web", bootstrap: "npm ci", checks: "npx tsc -b && npm run build" },
    },
    verify: {
      strategy: "compose",
      mongo: "mongo:7",
      externalProviders: ["Payments Co", "SMS Gateway"],
      services: {
        api: {
          build: "npm ci && npm run build",
          seed: "npm run migrations:run",
          serve: "npm start",
          port: 5000,
          healthPath: "/api/health",
          env: { MONGO_URI: "{{mongoUri}}", MONGO_DB: "{{mongoDb}}", BASE_URL: "{{url:api}}" },
        },
        web: {
          build: "npm ci && npm run build",
          serve: "npx vite preview --host 0.0.0.0 --port 4173",
          port: 4173,
          healthPath: "/",
          env: { VITE_ENV: "development", VITE_API_BASE_URL: "{{url:api}}" },
        },
      },
    },
  },
  "/projects/hub/.sandcastle/config.json",
);

setActiveProject(TEST_PROJECT);
