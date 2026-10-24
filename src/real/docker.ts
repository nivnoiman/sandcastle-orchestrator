import { join } from "node:path";
import type { CommandRunner, StartRequest } from "./commandRunner.js";
import type { FileSystemPort } from "./fileSystem.js";
import { toDockerPath } from "./paths.js";
import { activeProject } from "../project/projectConfig.js";
import { messageOf } from "../messageOf.js";

export interface Mount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

export interface VolumeMount {
  volume: string;
  containerPath: string;
}

export interface ContainerSpec {
  name: string;
  image: string;
  workdir?: string;
  mounts: readonly Mount[];
  envFile?: string;
  network?: string;
  networkAlias?: string;
  volumes?: readonly VolumeMount[];
  anonymousVolumes?: readonly string[];
  command?: readonly string[];
}

export const SANDBOX_WORKDIR = "/home/agent/workspace";
export const SMOKE_CONTAINER_PREFIX = "scsmoke-";
export const IMAGE_ENTRYPOINT: readonly string[] = [];
export const SLEEP_FOREVER: readonly string[] = ["sleep", "infinity"];

/** Every docker object is namespaced by project (a kebab name, so regex-safe) so two projects' garbage collectors never touch each other. */
export function containerPrefix(): string {
  return `sc-${activeProject().name}-`;
}

export function networkPrefix(): string {
  return `${containerPrefix()}net-`;
}

export function volumePrefix(): string {
  return `${containerPrefix()}vol-`;
}

export function stageContainerName(stage: string, itemNumber: number, stamp: string): string {
  const name = `${containerPrefix()}${stage}-${itemNumber}-${stamp}`;
  if (!isOrchestratorContainer(name)) {
    throw new Error(`container name "${name}" falls outside the garbage-collected sandcastle naming scheme`);
  }
  return name;
}

export function featureNetworkName(parentNumber: number, stamp: string): string {
  const name = `${networkPrefix()}${parentNumber}-${stamp}`;
  if (!isOrchestratorNetwork(name)) {
    throw new Error(`network name "${name}" falls outside the garbage-collected sandcastle naming scheme`);
  }
  return name;
}

export function featureVolumeName(parentNumber: number, stamp: string): string {
  const name = `${volumePrefix()}${parentNumber}-${stamp}`;
  if (!isOrchestratorVolume(name)) {
    throw new Error(`volume name "${name}" falls outside the garbage-collected sandcastle naming scheme`);
  }
  return name;
}

export function isOrchestratorContainer(name: string): boolean {
  return new RegExp(`^${containerPrefix()}[a-z][a-z0-9-]*-\\d+-[0-9a-z]+$`).test(name);
}

export function isOrchestratorNetwork(name: string): boolean {
  return new RegExp(`^${networkPrefix()}\\d+-[0-9a-z]+$`).test(name);
}

export function isOrchestratorVolume(name: string): boolean {
  return new RegExp(`^${volumePrefix()}\\d+-[0-9a-z]+$`).test(name);
}

function mountArgs(mounts: readonly Mount[]): string[] {
  return mounts.flatMap((mount) => [
    "-v",
    `${toDockerPath(mount.hostPath)}:${mount.containerPath}${mount.readonly ? ":ro" : ""}`,
  ]);
}

export function renderEnvFile(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([key, value]) => {
      if (/[\r\n]/.test(value)) throw new Error(`refusing to pass ${key} to a container: env values cannot contain newlines`);
      return `${key}=${value}`;
    })
    .join("\n");
}

export function withContainerEnvFile<T>(
  fs: FileSystemPort,
  env: Readonly<Record<string, string>>,
  use: (envFile: string) => T,
): T {
  const directory = fs.makeTempDirectory("sandcastle-env-");
  const envFile = join(directory, "container.env");
  fs.writePrivateText(envFile, renderEnvFile(env));
  try {
    return use(envFile);
  } finally {
    fs.removeDirectory(directory);
  }
}

export function assertDockerReady(runner: CommandRunner, image: string): void {
  try {
    runner.run({ command: "docker", args: ["info", "--format", "{{.ServerVersion}}"] });
  } catch (cause) {
    throw new Error(
      `docker daemon is not reachable (${messageOf(cause)}) — start Docker Desktop before running sandcastle`,
    );
  }
  const { stdout } = runner.run({ command: "docker", args: ["images", "-q", image] });
  if (stdout.trim().length === 0) {
    throw new Error(`docker image "${image}" is missing — build it with: npm run build-image`);
  }
}

export function containerRunArgs(spec: ContainerSpec): string[] {
  const args = ["run", "-d", "--name", spec.name];
  if (spec.workdir) args.push("-w", spec.workdir);
  args.push(...mountArgs(spec.mounts));
  for (const volume of spec.volumes ?? []) args.push("-v", `${volume.volume}:${volume.containerPath}`);
  for (const path of spec.anonymousVolumes ?? []) args.push("-v", path);
  if (spec.network) args.push("--network", spec.network);
  if (spec.networkAlias) args.push("--network-alias", spec.networkAlias);
  if (spec.envFile) args.push("--env-file", toDockerPath(spec.envFile));
  args.push(spec.image, ...(spec.command ?? SLEEP_FOREVER));
  return args;
}

export function startContainer(runner: CommandRunner, spec: ContainerSpec): void {
  runner.run({ command: "docker", args: containerRunArgs(spec) });
}

export function removeContainer(runner: CommandRunner, name: string): void {
  runner.run({ command: "docker", args: ["rm", "-f", "-v", name] });
}

export function execAsRoot(runner: CommandRunner, containerName: string, shellCommand: string): void {
  runner.run({ command: "docker", args: ["exec", "-u", "root", containerName, "bash", "-lc", shellCommand] });
}

export function createNetwork(runner: CommandRunner, name: string): void {
  runner.run({ command: "docker", args: ["network", "create", name] });
}

export function removeNetwork(runner: CommandRunner, name: string): void {
  runner.run({ command: "docker", args: ["network", "rm", name] });
}

export function createVolume(runner: CommandRunner, name: string): void {
  runner.run({ command: "docker", args: ["volume", "create", name] });
}

export function removeVolume(runner: CommandRunner, name: string): void {
  runner.run({ command: "docker", args: ["volume", "rm", "-f", name] });
}

function nonEmptyLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function listContainersByName(runner: CommandRunner, prefix: string): string[] {
  const { stdout } = runner.run({
    command: "docker",
    args: ["ps", "-a", "--filter", `name=${prefix}`, "--format", "{{.Names}}"],
  });
  return nonEmptyLines(stdout);
}

export function listNetworksByPrefix(runner: CommandRunner, prefix: string): string[] {
  const { stdout } = runner.run({
    command: "docker",
    args: ["network", "ls", "--filter", `name=^${prefix}`, "--format", "{{.Name}}"],
  });
  return nonEmptyLines(stdout);
}

export function listVolumesByPrefix(runner: CommandRunner, prefix: string): string[] {
  const { stdout } = runner.run({
    command: "docker",
    args: ["volume", "ls", "--filter", `name=^${prefix}`, "--format", "{{.Name}}"],
  });
  return nonEmptyLines(stdout);
}

export function execRequest(
  containerName: string,
  shellCommand: string,
  options: { input?: string; onOutput?: (chunk: string) => void } = {},
): StartRequest {
  const args = options.input === undefined
    ? ["exec", containerName, "bash", "-lc", shellCommand]
    : ["exec", "-i", containerName, "bash", "-lc", shellCommand];
  const request: StartRequest = { command: "docker", args };
  if (options.input !== undefined) request.input = options.input;
  if (options.onOutput) request.onOutput = options.onOutput;
  return request;
}

export function execDetached(runner: CommandRunner, containerName: string, shellCommand: string, logFile: string): void {
  runner.run({
    command: "docker",
    args: ["exec", "-d", containerName, "bash", "-lc", `${shellCommand} > ${logFile} 2>&1`],
  });
}
