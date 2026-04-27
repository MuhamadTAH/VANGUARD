import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";

export class VanguardServer {
  private readonly extensionPath: string;
  private server: http.Server | null = null;
  private port: number | null = null;

  public constructor(extensionPath: string) {
    this.extensionPath = extensionPath;
  }

  public async start(): Promise<void> {
    if (this.server && this.port) {
      return;
    }

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handle(req, res);
      } catch {
        this.applySecurityHeaders(res);
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Vanguard runtime server error");
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("Unable to bind Vanguard runtime server."));
          return;
        }
        this.port = address.port;
        resolve();
      });
    });
  }

  public getUrl(): string {
    if (!this.port) {
      throw new Error("Vanguard runtime server not started.");
    }
    return `http://127.0.0.1:${this.port}`;
  }

  public dispose(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      this.port = null;
    }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const reqUrl = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = reqUrl.pathname;

    if (pathname === "/") {
      this.applySecurityHeaders(res);
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(this.renderRuntimeHtml());
      return;
    }

    if (pathname.startsWith("/media/")) {
      const relative = pathname.slice("/media/".length);
      await this.sendFile(
        path.join(this.extensionPath, "media"),
        relative,
        res
      );
      return;
    }

    if (pathname.startsWith("/webcontainer/")) {
      const relative = pathname.slice("/webcontainer/".length);
      await this.sendFile(
        path.join(this.extensionPath, "node_modules", "@webcontainer", "api", "dist"),
        relative,
        res
      );
      return;
    }

    this.applySecurityHeaders(res);
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
    return;
  }

  private async sendFile(root: string, relativePath: string, res: http.ServerResponse): Promise<void> {
    const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
    const fullPath = path.join(root, normalized);
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(fullPath);

    if (!resolvedFile.startsWith(resolvedRoot)) {
      this.applySecurityHeaders(res);
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden");
      return;
    }

    const data = await fs.readFile(resolvedFile);
    this.applySecurityHeaders(res);
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(resolvedFile));
    res.end(data);
  }

  private applySecurityHeaders(res: http.ServerResponse): void {
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");
  }

  private renderRuntimeHtml(): string {
    const bootConfig = JSON.stringify({
      webContainerModuleUri: `${this.getUrl()}/webcontainer/index.js`
    });
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Cross-Origin-Opener-Policy" content="same-origin" />
  <meta http-equiv="Cross-Origin-Embedder-Policy" content="require-corp" />
  <meta http-equiv="Cross-Origin-Resource-Policy" content="cross-origin" />
  <meta
    http-equiv="Content-Security-Policy"
    content="
      default-src 'self';
      style-src 'self' 'unsafe-inline';
      script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;
      frame-src 'self' http://127.0.0.1:* http://localhost:*;
      connect-src 'self' http://127.0.0.1:* http://localhost:* blob:;
      img-src 'self' data: blob: http://127.0.0.1:* http://localhost:*;
    "
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Vanguard Runtime</title>
  <link rel="stylesheet" href="/media/preview.css" />
</head>
<body>
  <header class="topbar">
    <div class="title">VANGUARD PREVIEW</div>
    <div id="status" class="status">Idle</div>
  </header>
  <main class="layout">
    <aside class="events">
      <h2>Telemetry</h2>
      <div id="events" class="event-list"></div>
    </aside>
    <section class="canvas">
      <iframe id="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
    </section>
  </main>
  <script>window.__VANGUARD_BOOT_CONFIG__ = ${bootConfig};</script>
  <script src="/media/preview.js"></script>
</body>
</html>`;
  }
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
