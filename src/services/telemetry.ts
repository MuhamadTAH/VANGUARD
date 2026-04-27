import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

export class TripletCapturer {
    private workspacePath: string | null = null;
    
    // In-memory cache for recent mutations to detect user corrections
    private recentMutations: Map<string, { prompt: string; badOutput: string; timestamp: number }> = new Map();

    constructor() {
        // Will evaluate dynamically during actual execution to fetch latest workspace
    }

    private getWorkspacePath(): string | null {
        if (process.env.VSCODE_WORKSPACE_FOLDER) {
            return process.env.VSCODE_WORKSPACE_FOLDER;
        }
        const folders = vscode.workspace.workspaceFolders;
        if (folders && folders.length > 0) {
            return folders[0].uri.fsPath;
        }
        return null;
    }

    public isOptedOut(): boolean {
        // Default State: Opt-in (false) for individual developers.
        const config = vscode.workspace.getConfiguration('vanguard.dataPrivacy');
        return config.get<boolean>('optOut', false);
    }

    public markMutation(filePath: string, prompt: string, badOutput: string): void {
        this.recentMutations.set(filePath, { prompt, badOutput, timestamp: Date.now() });
    }

    public async captureFromManualEdit(filePath: string, fixedCode: string): Promise<void> {
        const recent = this.recentMutations.get(filePath);
        if (!recent) return;

        // Ensure timeframe (e.g. 5 minutes)
        if (Date.now() - recent.timestamp > 5 * 60 * 1000) {
            this.recentMutations.delete(filePath);
            return;
        }

        // The user manually saved the file after it was mutated by AI.
        // If the code is different, we capture it as a Triplet
        if (fixedCode !== recent.badOutput) {
            await this.capture(recent.badOutput, "Manual Edit / Undo Correction", fixedCode);
            // Clear to prevent duplicate triggers
            this.recentMutations.delete(filePath);
        }
    }

    public async capture(badOutput: string, userCorrection: string, fixedCode: string): Promise<void> {
        // If opted out, immediately return and record nothing
        if (this.isOptedOut()) {
            return;
        }

        const workspacePath = this.getWorkspacePath();
        if (!workspacePath) return;

        // Data Pruning: Triplet PII Stripper
        const strippedBad = this.stripPII(badOutput);
        const strippedCorrection = this.stripPII(userCorrection);
        const strippedFixed = this.stripPII(fixedCode);

        const triplet = {
            timestamp: new Date().toISOString(),
            badOutput: strippedBad,
            userCorrection: strippedCorrection,
            fixedCode: strippedFixed
        };

        const vanguardDir = path.join(workspacePath, '.vanguard');
        const filePath = path.join(vanguardDir, 'triplets.jsonl');

        try {
            await fs.mkdir(vanguardDir, { recursive: true });
            await fs.appendFile(filePath, JSON.stringify(triplet) + '\n', 'utf-8');
        } catch (e) {
            console.error("Vanguard Telemetry failed to write triplet", e);
        }
    }

    private stripPII(text: string): string {
        if (!text) return text;
        let clean = text;
        
        // Remove standard email format
        clean = clean.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]');
        // Potential passwords / secrets
        clean = clean.replace(/(password|secret|token|api_key|apikey)["'\s:=]+[^\s"']+/gi, '$1=[REDACTED_SECRET]');
        clean = clean.replace(/Bearer\s+[A-Za-z0-9\-\._~+\/]+=*/gi, 'Bearer [REDACTED_TOKEN]');

        return clean;
    }
}

export const telemetryService = new TripletCapturer();

export async function initializeTelemetry(context: vscode.ExtensionContext): Promise<void> {
    const hasSeenToS = context.globalState.get<boolean>('vanguard.hasSeenTelemetryToS');
    if (!hasSeenToS) {
        // Show one-time info message
        vscode.window.showInformationMessage(
            "Vanguard uses anonymized edit triplets to improve its accuracy. You can opt-out in settings.",
            "Open Settings"
        ).then(choice => {
            if (choice === "Open Settings") {
                vscode.commands.executeCommand('workbench.action.openSettings', 'vanguard.dataPrivacy.optOut');
            }
        });
        await context.globalState.update('vanguard.hasSeenTelemetryToS', true);
    }

    // Register file save listener to capture manual corrections directly
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(async (doc) => {
            if (doc.uri.scheme === 'file') {
                await telemetryService.captureFromManualEdit(doc.uri.fsPath, doc.getText());
            }
        })
    );
}
