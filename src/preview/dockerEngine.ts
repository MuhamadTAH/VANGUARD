import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";
import type { Readable } from "node:stream";

export type DockerLogLevel = "info" | "warn" | "error";

export interface DockerLogEvent {
  readonly line: string;
  readonly level: DockerLogLevel;
}

interface DockerEngineOptions {
  readonly projectRoot: string;
  readonly onLog: (event: DockerLogEvent) => void;
}

export class DockerEngine {
  private readonly projectRoot: string;
  private readonly onLog: (event: DockerLogEvent) => void;
  private readonly dockerfilePath: string;
  private imageTag = "";
  private containerId = "";
  private mappedPort = 0;
  private logFollower: { kill: () => void; killed?: boolean } | null = null;

  public constructor(options: DockerEngineOptions) {
    this.projectRoot = path.resolve(options.projectRoot);
    this.onLog = options.onLog;
    this.dockerfilePath = path.join(this.projectRoot, "Dockerfile.vanguard");
  }

  public async start(): Promise<string> {
    this.imageTag = `vanguard-demo:${Date.now()}`;
    await this.verifyBuildInputs();
    await this.writeDockerfile();
    await this.buildImage();
    await this.runContainer();
    this.startLogStreaming();
    return `http://localhost:${this.mappedPort}`;
  }

  public async stop(): Promise<void> {
    if (this.logFollower && !this.logFollower.killed) {
      this.logFollower.kill();
    }
    this.logFollower = null;

    if (!this.containerId) {
      return;
    }

    await this.runDockerCommandCapture(["rm", "-f", this.containerId]).catch(() => undefined);
    this.containerId = "";
    this.mappedPort = 0;
  }

  private async writeDockerfile(): Promise<void> {
    const contents = [
      "FROM node:20-alpine",
      "WORKDIR /app",
      "COPY package.json ./",
      "COPY package-lock.json* ./",
      "RUN npm install",
      "COPY . .",
      "CMD [\"npm\", \"run\", \"dev\", \"--\", \"--hostname\", \"0.0.0.0\", \"--port\", \"3000\"]"
    ].join("\n");

    await fs.writeFile(this.dockerfilePath, `${contents}\n`, "utf8");
    this.onLog({ line: `[Docker] Wrote ${this.dockerfilePath}`, level: "info" });
  }

  private async buildImage(): Promise<void> {
    const contextPath = path.resolve(this.projectRoot);
    this.onLog({ line: `[Docker] Building image ${this.imageTag}...`, level: "info" });
    this.onLog({ line: `[Docker] Build context: ${contextPath}`, level: "info" });
    await this.runDockerCommand(
      ["build", "-f", this.dockerfilePath, "-t", this.imageTag, contextPath],
      (line, isErr) => {
        this.onLog({ line: `[docker build] ${line}`, level: isErr ? "warn" : "info" });
      }
    );
  }

  private async runContainer(): Promise<void> {
    const containerIdRaw = await this.runDockerCommandCapture([
      "run",
      "-d",
      "-p",
      "127.0.0.1::3000",
      this.imageTag
    ]);

    this.containerId = containerIdRaw.trim();
    if (!this.containerId) {
      throw new Error("docker run did not return a container id.");
    }

    const portRaw = await this.runDockerCommandCapture(["port", this.containerId, "3000/tcp"]);
    this.mappedPort = this.parseMappedPort(portRaw);
    this.onLog({
      line: `[Docker] Container ${this.containerId.slice(0, 12)} mapped to localhost:${this.mappedPort}`,
      level: "info"
    });
  }

  private startLogStreaming(): void {
    const child = spawn("docker", ["logs", "-f", this.containerId], {
      cwd: this.projectRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.logFollower = child;
    this.attachProcessLogs(child, (line, isErr) => {
      this.onLog({ line: `[docker logs] ${line}`, level: isErr ? "warn" : this.detectSeverity(line) });
    });
  }

  private parseMappedPort(raw: string): number {
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      const match = line.match(/:(\d+)\s*$/);
      if (match) {
        return Number(match[1]);
      }
    }
    throw new Error(`Unable to parse mapped port from: ${raw}`);
  }

  private attachProcessLogs(
    process: { stdout: Readable; stderr: Readable },
    onLine: (line: string, isErr: boolean) => void
  ): void {
    const stdout = readline.createInterface({ input: process.stdout });
    const stderr = readline.createInterface({ input: process.stderr });
    stdout.on("line", (line) => onLine(line, false));
    stderr.on("line", (line) => onLine(line, true));
  }

  private detectSeverity(line: string): DockerLogLevel {
    const lower = line.toLowerCase();
    if (
      lower.includes("error") ||
      lower.includes("err!") ||
      lower.includes("failed") ||
      lower.includes("exception")
    ) {
      return "error";
    }
    if (
      lower.includes("warn") ||
      lower.includes("deprecated") ||
      lower.includes("unable") ||
      lower.includes("could not")
    ) {
      return "warn";
    }
    return "info";
  }

  private async verifyBuildInputs(): Promise<void> {
    const packageJsonPath = path.join(this.projectRoot, "package.json");
    this.onLog({ line: `[Docker] Project path: ${this.projectRoot}`, level: "info" });
    this.onLog({ line: `[Docker] Checking package.json at: ${packageJsonPath}`, level: "info" });

    try {
      await fs.access(packageJsonPath);
    } catch {
      throw new Error(`package.json not found at ${packageJsonPath}`);
    }

    await this.verifyDockerIgnore();
  }

  private async verifyDockerIgnore(): Promise<void> {
    const dockerIgnorePath = path.join(this.projectRoot, ".dockerignore");
    let contents = "";
    try {
      contents = await fs.readFile(dockerIgnorePath, "utf8");
    } catch {
      this.onLog({ line: `[Docker] .dockerignore not found at ${dockerIgnorePath}`, level: "info" });
      return;
    }

    this.onLog({ line: `[Docker] Found .dockerignore at ${dockerIgnorePath}`, level: "info" });
    const patterns = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    let packageJsonIgnored = false;
    for (const entry of patterns) {
      const negated = entry.startsWith("!");
      const pattern = negated ? entry.slice(1).trim() : entry;
      if (!this.matchesPackageJsonPattern(pattern)) {
        continue;
      }
      packageJsonIgnored = !negated;
    }

    if (packageJsonIgnored) {
      throw new Error(".dockerignore excludes package.json from Docker build context.");
    }

    this.onLog({ line: "[Docker] .dockerignore check passed for package.json.", level: "info" });
  }

  private matchesPackageJsonPattern(pattern: string): boolean {
    const normalized = pattern.replace(/\\/g, "/");
    if (
      normalized === "package.json" ||
      normalized === "/package.json" ||
      normalized === "**/package.json" ||
      normalized === "*/package.json" ||
      normalized === "package*.json" ||
      normalized === "/package*.json"
    ) {
      return true;
    }

    if (normalized === "*" || normalized === "**" || normalized === "*.*") {
      return true;
    }

    if (normalized.includes("package.json") || normalized.includes("package*.json")) {
      return true;
    }

    return false;
  }

  private async runDockerCommand(
    args: string[],
    onLine: (line: string, isErr: boolean) => void
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.attachProcessLogs(child, onLine);
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`docker ${args.join(" ")} exited with code ${String(code)}.`));
      });
    });
  }

  private async runDockerCommandCapture(args: string[]): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const child = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"]
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
      });
      child.stderr.on("data", (chunk) => {
        err += String(chunk);
      });
      child.on("error", (error) => reject(error));
      child.on("close", (code) => {
        if (code === 0) {
          resolve(out);
          return;
        }
        reject(new Error(`docker ${args.join(" ")} failed: ${err || out}`));
      });
    });
  }
}
