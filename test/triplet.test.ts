import * as fs from 'fs/promises';
import * as path from 'path';
import { telemetryService } from '../src/services/telemetry';

async function runTripletsTest() {
    process.env.VSCODE_WORKSPACE_FOLDER = __dirname;
    const testFile = path.join(__dirname, 'test-component.tsx');
    
    // Simulate initial mutation
    const badCode = `export function Test() { return <div v-id="test_id" className="wrong-color-AI">Hello</div> }`;
    const prompt = "Make the text color red";
    telemetryService.markMutation(testFile, prompt, badCode);

    // Simulate "Undo" -> file reverts to old state, then user types manual fix and hits save.
    const fixedCode = `export function Test() { return <div v-id="test_id" className="text-red-500">Hello</div> }`;
    
    // Trigger the save capturing mechanism
    await telemetryService.captureFromManualEdit(testFile, fixedCode);

    // Verify .vanguard/triplets.jsonl
    const vanguardDir = path.join(__dirname, '.vanguard');
    const tripletsPath = path.join(vanguardDir, 'triplets.jsonl');
    
    const content = await fs.readFile(tripletsPath, 'utf8');
    const lines = content.trim().split('\n');
    const latest = JSON.parse(lines[lines.length - 1]);

    if (latest.badOutput === badCode && latest.fixedCode === fixedCode && latest.userCorrection) {
        console.log("✅ Success! Triplet captured correctly:", JSON.stringify(latest, null, 2));
    } else {
        console.error("❌ Failed to capture triplet properly.");
    }
}

runTripletsTest().catch(console.error);
