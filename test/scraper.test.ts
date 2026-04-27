import * as fs from 'fs/promises';
import * as path from 'path';
import { DependencyScraper } from '../src/intelligence/scraper';

const TEST_DIR = path.join(__dirname, 'test-workspace');
const SRC_DIR = path.join(TEST_DIR, 'src');

async function setupTestFiles() {
    await fs.rm(TEST_DIR, { recursive: true, force: true });
    await fs.mkdir(path.join(SRC_DIR, 'utils'), { recursive: true });
    await fs.mkdir(path.join(SRC_DIR, 'components'), { recursive: true });
    await fs.mkdir(path.join(SRC_DIR, 'app'), { recursive: true });
    await fs.mkdir(path.join(SRC_DIR, 'hooks'), { recursive: true });

    // Test 1: The "Grandchild" Trace
    await fs.writeFile(path.join(SRC_DIR, 'utils', 'math.ts'), `export function calculateVanguardAlpha(x: number, y: number) { return x + y; }`);
    await fs.writeFile(path.join(SRC_DIR, 'components', 'LogicWrapper.tsx'), `import { calculateVanguardAlpha } from '@/utils/math';\nexport function LogicWrapper() { return <div>{calculateVanguardAlpha(1, 2)}</div>; }`);
    await fs.writeFile(path.join(SRC_DIR, 'app', 'page.tsx'), `import { LogicWrapper } from '@/components/LogicWrapper';\nexport default function Page() { return <LogicWrapper />; }`);

    // Test 2: The "API Signature" Duel
    await fs.writeFile(path.join(SRC_DIR, 'hooks', 'useVanguardTheme.ts'), `export function useVanguardTheme(color: 'blue' | 'red') {}`);
    await fs.writeFile(path.join(SRC_DIR, 'app', 'theme.tsx'), `import { useVanguardTheme } from '@/hooks/useVanguardTheme';\nexport function AppTheme() { useVanguardTheme('blue'); }`);

    // Test 3: The "Token Firewall"
    const largeContent = '// A very large payload\n' + 'x'.repeat(3000) + '\n';
    let imports = '';
    for (let i = 0; i < 15; i++) {
        await fs.writeFile(path.join(SRC_DIR, 'components', `LargeChild${i}.tsx`), `import { something } from './Grandchild${i}';\n${largeContent}`);
        await fs.writeFile(path.join(SRC_DIR, 'components', `Grandchild${i}.tsx`), `export const something = "wow";\n${largeContent}`);
        imports += `import { LargeChild${i} } from './LargeChild${i}';\n`;
    }
    await fs.writeFile(path.join(SRC_DIR, 'components', 'BigComponent.tsx'), imports + `\nexport function BigComponent() {}`);

    // Test 4: The "Black Hole" Test
    await fs.writeFile(path.join(SRC_DIR, 'app', 'framer.tsx'), `import { motion } from 'framer-motion';\nimport { Home } from 'lucide-react';\nimport { AppTheme } from './theme';\nexport default function Animated() { return <motion.div><Home/></motion.div>; }`);
}

async function runTests() {
    await setupTestFiles();
    console.log("Setup complete.\n");

    const scraper = new DependencyScraper(SRC_DIR);

    console.log("--- Test 1: The 'Grandchild' Trace (Depth-2 Verification) ---");
    const test1Packet = await scraper.buildContextPacket(path.join(SRC_DIR, 'app', 'page.tsx'));
    if (test1Packet.includes('### DEPENDENCY (Depth 1)') && test1Packet.includes('### DEPENDENCY (Depth 2)') && test1Packet.includes('calculateVanguardAlpha')) {
        console.log("✅ Passed Test 1. Grandchild LogicWrapper -> math.ts found.");
    } else {
        console.error("❌ Failed Test 1:\n", test1Packet);
    }

    console.log("\n--- Test 2: The 'API Signature' Duel ---");
    const test2Packet = await scraper.buildContextPacket(path.join(SRC_DIR, 'app', 'theme.tsx'));
    if (test2Packet.includes("color: 'blue' | 'red'")) {
        console.log("✅ Passed Test 2. useVanguardTheme signature correctly mapped.");
    } else {
        console.error("❌ Failed Test 2.");
    }

    console.log("\n--- Test 3: The 'Token Firewall' (Stress Test) ---");
    const test3Packet = await scraper.buildContextPacket(path.join(SRC_DIR, 'components', 'BigComponent.tsx'));
    if (!test3Packet.includes('### DEPENDENCY (Depth 2)')) {
        console.log("✅ Passed Test 3. Depth-2 correctly dropped because payload exceeded max tokens!");
    } else {
        console.error("❌ Failed Test 3. Token firewall did not prune Depth-2.");
    }

    console.log("\n--- Test 4: The 'Black Hole' Test (Exclusion Check) ---");
    const test4Packet = await scraper.buildContextPacket(path.join(SRC_DIR, 'app', 'framer.tsx'));
    if (!test4Packet.includes('### DEPENDENCY (Depth 1): framer-motion') && !test4Packet.includes('### DEPENDENCY (Depth 1): lucide-react')) {
        console.log("✅ Passed Test 4. Black Hole excluded framer-motion and lucide-react sources.");
    } else {
        console.error("❌ Failed Test 4.", test4Packet);
    }

    // Cleanup
    await fs.rm(TEST_DIR, { recursive: true, force: true });
}

runTests().catch(console.error);
