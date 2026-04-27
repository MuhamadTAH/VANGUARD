import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Project compatibility validator.
 * Ensures Vanguard is running in a Next.js 16+ project.
 */
export class ProjectValidator {
  private context: vscode.ExtensionContext;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Check if project is compatible (Next.js 16+)
   */
  async validateProjectStructure(): Promise<{ compatible: boolean; reason?: string }> {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return { compatible: false, reason: "No workspace folder open" };
    }

    const projectRoot = workspaceFolder.uri.fsPath;

    // Check for next.config.js/ts
    if (!this.hasNextConfig(projectRoot)) {
      return { compatible: false, reason: "next.config.js/ts not found" };
    }

    // Check for package.json with Next.js dependency
    const packageJsonPath = path.join(projectRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      return { compatible: false, reason: "package.json not found" };
    }

    try {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
      const nextVersion = packageJson.dependencies?.next || packageJson.devDependencies?.next;

      if (!nextVersion) {
        return { compatible: false, reason: "Next.js not found in dependencies" };
      }

      // Check version is 16+
      const majorVersion = this.extractMajorVersion(nextVersion);
      if (majorVersion < 16) {
        return {
          compatible: false,
          reason: `Next.js ${majorVersion} detected. Vanguard requires Next.js 16 or higher.`,
        };
      }
    } catch (error) {
      return { compatible: false, reason: "Failed to parse package.json" };
    }

    // Check for app directory (Next.js 13+ feature)
    const appDir = path.join(projectRoot, "app");
    if (!fs.existsSync(appDir)) {
      return { compatible: false, reason: "app/ directory not found (Next.js 13+ required)" };
    }

    // Check for React/TypeScript configuration
    if (!this.hasReactFiles(projectRoot)) {
      return { compatible: false, reason: "No React component files found (*.tsx/*.jsx required)" };
    }

    return { compatible: true };
  }

  /**
   * Show incompatibility message to user
   */
  async showIncompatibilityMessage(reason: string): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      `⚠️ Next.js 16 Required\n\nVanguard works with Next.js 16+ projects.\n\n${reason}`,
      "Learn More",
      "Dismiss"
    );

    if (choice === "Learn More") {
      await vscode.env.openExternal(vscode.Uri.parse("https://vanguard.dev/docs/requirements"));
    }
  }

  /**
   * Show compatibility requirements when first opening
   */
  async validateOnStartup(): Promise<boolean> {
    const { compatible, reason } = await this.validateProjectStructure();

    if (!compatible) {
      await this.showIncompatibilityMessage(
        reason || "This project is not compatible with Vanguard.\n\nRequirements:\n• Next.js 16 or higher\n• React 19+\n• TypeScript or JSX"
      );
      return false;
    }

    return true;
  }

  /**
   * Check if next.config.js/ts exists
   */
  private hasNextConfig(projectRoot: string): boolean {
    return (
      fs.existsSync(path.join(projectRoot, "next.config.js")) ||
      fs.existsSync(path.join(projectRoot, "next.config.ts")) ||
      fs.existsSync(path.join(projectRoot, "next.config.mjs"))
    );
  }

  /**
   * Check if project has React files
   */
  private hasReactFiles(projectRoot: string): boolean {
    const dirs = ["app", "src", "components", "pages"];
    for (const dir of dirs) {
      const fullPath = path.join(projectRoot, dir);
      if (fs.existsSync(fullPath)) {
        const files = this.findFilesRecursive(fullPath, [".tsx", ".jsx"], 3);
        if (files.length > 0) {
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Recursively find files with specific extensions up to maxDepth
   */
  private findFilesRecursive(dir: string, extensions: string[], maxDepth: number, depth = 0): string[] {
    if (depth >= maxDepth || !fs.existsSync(dir)) {
      return [];
    }

    const results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip node_modules and hidden directories
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }

      const fullPath = path.join(dir, entry.name);

      if (entry.isFile()) {
        if (extensions.some((ext) => entry.name.endsWith(ext))) {
          results.push(fullPath);
        }
      } else if (entry.isDirectory()) {
        results.push(...this.findFilesRecursive(fullPath, extensions, maxDepth, depth + 1));
      }
    }

    return results;
  }

  /**
   * Extract major version from version string
   */
  private extractMajorVersion(versionString: string): number {
    const match = versionString.trim().match(/(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
  }
}

let projectValidator: ProjectValidator | null = null;

export function initializeProjectValidator(context: vscode.ExtensionContext): ProjectValidator {
  projectValidator = new ProjectValidator(context);
  return projectValidator;
}

export function getProjectValidator(): ProjectValidator {
  if (!projectValidator) {
    throw new Error("Project validator not initialized");
  }
  return projectValidator;
}
