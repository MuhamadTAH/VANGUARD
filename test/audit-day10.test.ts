import * as fs from 'fs/promises';
import * as path from 'path';

// Mock vscode module explicitly
const mockConfig: Record<string, any> = { 'optOut': false };
const vscodeMock = {
    workspace: {
        workspaceFolders: [{ uri: { fsPath: __dirname } }],
        getConfiguration: () => ({ get: (key: string, def: any) => mockConfig[key] ?? def })
    }
};
const mockModule = require('module');
const originalRequire = mockModule.prototype.require;
mockModule.prototype.require = function(mod: string) {
    if (mod === 'vscode') return vscodeMock;
    return originalRequire.apply(this, [mod]);
};

// Now import the targeted module safely
import { TripletCapturer } from '../src/services/telemetry';

async function verifyAudit() {
    console.log("VANGUARD DAY 10 AUDIT");
    const testFile = path.join(__dirname, 'mock_file.tsx');
    const vanguardDir = path.join(__dirname, '.vanguard');
    const tripletsPath = path.join(vanguardDir, 'triplets.jsonl');
    let capturer = new TripletCapturer();

    // Reset log
    await fs.rm(vanguardDir, { force: true, recursive: true });

    // Task 1: Full Loop
    capturer.markMutation(testFile, "fix this", "BAD_OUTPUT");
    await capturer.captureFromManualEdit(testFile, "FIXED_CODE_WITH_MANUAL_EDIT");
    
    let content = await fs.readFile(tripletsPath, 'utf8');
    let lines = content.trim().split('\n');
    let latest = JSON.parse(lines[lines.length - 1]);
    if (latest.badOutput === 'BAD_OUTPUT' && latest.fixedCode === "FIXED_CODE_WITH_MANUAL_EDIT" && latest.userCorrection) {
        console.log("✅ Task 1: The 'Full Loop' Capture passed.");
    } else {
        console.error("❌ Task 1 Failed.");
    }

    // Task 2: PII Stripping
    const dirtyApi = "Let me use this token sk_live_51Mh39xabc... oh and contact test@gmail.com";
    capturer.markMutation(testFile, "add contact token", "BAD");
    await capturer.captureFromManualEdit(testFile, dirtyApi);
    content = await fs.readFile(tripletsPath, 'utf8');
    lines = content.trim().split('\n');
    latest = JSON.parse(lines[lines.length - 1]);
    if (latest.fixedCode.includes('[REDACTED_EMAIL]') && latest.fixedCode.includes('[REDACTED_SECRET]') && !latest.fixedCode.includes('sk_live') && !latest.fixedCode.includes('test@gmail.com')) {
        console.log("✅ Task 2: PII Stripper passed.");
    } else {
        console.error("❌ Task 2 Failed. PII was left unstripped:", latest.fixedCode);
    }

    // Task 3: Opt-Out
    mockConfig['optOut'] = true;
    const initialLineLength = lines.length;
    capturer.markMutation(testFile, "kill switch", "BAD");
    await capturer.captureFromManualEdit(testFile, "NEW_FIX");
    content = await fs.readFile(tripletsPath, 'utf8');
    lines = content.trim().split('\n');
    if (lines.length === initialLineLength) {
        console.log("✅ Task 3: 'Kill-Switch' passed. Zero new data recorded.");
    } else {
        console.error("❌ Task 3 Failed. New data was written to file.");
    }

    // Task 4: Time-Out Test
    mockConfig['optOut'] = false; // reset
    const beforeTimeoutLines = lines.length;
    capturer.markMutation(testFile, "wait around", "BAD_OUTPUT_WAIT");
    
    // forcefully mock the timestamp stored
    (capturer as any).recentMutations.get(testFile).timestamp = Date.now() - (6 * 60 * 1000); // 6 mins ago
    
    await capturer.captureFromManualEdit(testFile, "LATE_MANUAL_FIX");
    content = await fs.readFile(tripletsPath, 'utf8');
    lines = content.trim().split('\n');
    if (lines.length === beforeTimeoutLines) {
        console.log("✅ Task 4: 'Time-Out' Test passed. Edit correctly ignored.");
    } else {
        console.error("❌ Task 4 Failed. Time window unrespected.");
    }

    // Cleanup
    await fs.rm(vanguardDir, { force: true, recursive: true });
}

verifyAudit().catch(console.error);
