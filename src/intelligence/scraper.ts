import * as fs from 'fs/promises';
import * as path from 'path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = typeof _traverse === 'function' ? _traverse : (_traverse as any).default;

export interface ScraperOptions {
    maxTokens?: number;
    workspaceRoot?: string;
}

const TOKENS_PER_CHAR = 0.25;

export class DependencyScraper {
    private visited = new Set<string>();
    private filesByDepth: Map<number, { path: string; code: string }[]> = new Map();

    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    public async buildContextPacket(targetFilePath: string, options: ScraperOptions = {}): Promise<string> {
        this.visited.clear();
        this.filesByDepth.clear();
        
        await this.scrapeRecursive(targetFilePath, 0);

        // Assemble phase
        const maxTokens = options.maxTokens || 10000;
        const maxChars = maxTokens * 4;
        let totalChars = 0;
        let packet = '';
        
        // Target file (Depth 0)
        const depth0Files = this.filesByDepth.get(0) || [];
        if (depth0Files.length > 0) {
            const target = depth0Files[0];
            const header = `### TARGET FILE: ${target.path}\n`;
            const content = `${target.code}\n\n`;
            packet += header + content;
            totalChars += header.length + content.length;
        }

        // Depth 1
        const depth1Files = this.filesByDepth.get(1) || [];
        let depth1Packet = '';
        for (const file of depth1Files) {
            const header = `### DEPENDENCY (Depth 1): ${file.path}\n`;
            const content = `${file.code}\n\n`;
            depth1Packet += header + content;
        }

        // Depth 2
        const depth2Files = this.filesByDepth.get(2) || [];
        let depth2Packet = '';
        for (const file of depth2Files) {
            const header = `### DEPENDENCY (Depth 2): ${file.path}\n`;
            const content = `${file.code}\n\n`;
            depth2Packet += header + content;
        }

        // Token Guard
        // If the total packet exceeds 10,000 tokens, prioritize the target file and direct (Depth 1) dependencies only.
        if (totalChars + depth1Packet.length + depth2Packet.length > maxChars) {
            packet += depth1Packet;
        } else {
            packet += depth1Packet + depth2Packet;
        }

        return packet.trim();
    }

    private async scrapeRecursive(filePath: string, depth: number): Promise<void> {
        // Depth Guard (CRITICAL): Depth-2 cap. Do not go to Depth 3+
        if (depth > 2) return;
        
        const absolutePath = await this.resolvePath(filePath);
        if (!absolutePath) return;

        if (this.visited.has(absolutePath)) return;
        this.visited.add(absolutePath);

        // Safety Constraints: Never traverse into node_modules
        if (absolutePath.includes('node_modules') || absolutePath.includes('.next')) return;
        
        // Asset Exclusion: Ignore images, SVGs, and CSS files.
        // We only care about .ts, .tsx, .js, and .jsx logic.
        if (!absolutePath.match(/\.(ts|tsx|js|jsx)$/i)) return;

        let code = '';
        try {
            code = await fs.readFile(absolutePath, 'utf-8');
        } catch (e) {
            return;
        }

        const list = this.filesByDepth.get(depth) || [];
        list.push({ path: absolutePath, code });
        this.filesByDepth.set(depth, list);

        if (depth < 2) {
            const imports = this.extractImports(code);
            const scrapePromises = imports.map(importPath => {
                let resolvedTarget = '';
                
                if (importPath.startsWith('@/')) {
                    resolvedTarget = path.join(this.workspaceRoot, importPath.substring(2));
                } else if (importPath.startsWith('./') || importPath.startsWith('../')) {
                    resolvedTarget = path.join(path.dirname(absolutePath), importPath);
                } else {
                    // Ignore non-local imports (e.g., react, react-dom)
                    return Promise.resolve();
                }

                return this.scrapeRecursive(resolvedTarget, depth + 1);
            });
            await Promise.all(scrapePromises);
        }
    }

    private extractImports(code: string): string[] {
        const imports: string[] = [];
        try {
            const ast = parse(code, {
                sourceType: 'module',
                plugins: ['typescript', 'jsx']
            });

            traverse(ast, {
                ImportDeclaration(p: any) {
                    if (p.node && p.node.source && p.node.source.value) {
                        imports.push(p.node.source.value);
                    }
                }
            });
        } catch (e) {
            // Return any successfully parsed imports or empty
        }
        return imports;
    }

    private async resolvePath(basePath: string): Promise<string | null> {
        if (await this.fileExists(basePath)) {
            const stat = await fs.stat(basePath);
            if (stat.isFile()) return basePath;
        }

        const exts = ['.tsx', '.ts', '.jsx', '.js'];
        for (const ext of exts) {
            const withExt = basePath + ext;
            if (await this.fileExists(withExt)) {
                return withExt;
            }
        }

        for (const ext of exts) {
            const indexFile = path.join(basePath, 'index' + ext);
            if (await this.fileExists(indexFile)) {
                return indexFile;
            }
        }

        return null;
    }

    private async fileExists(p: string): Promise<boolean> {
        try {
            await fs.access(p);
            return true;
        } catch {
            return false;
        }
    }
}
