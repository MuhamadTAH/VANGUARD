import * as fs from "node:fs";
import * as path from "node:path";
import git from "isomorphic-git";
import * as vscode from "vscode";

export interface VanguardHistoryEntry {
  oid: string;
  message: string;
  timestamp: number;
}

export interface MutationCommitInput {
  readonly filePath: string;
  readonly vId: string;
  readonly prompt: string;
}

function getVanguardGitDir(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder found for Vanguard Git Time Machine.");
  }
  return path.join(workspaceFolders[0].uri.fsPath, ".vanguard", "git");
}

function getWorkspaceRoot(): string {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error("No workspace folder found.");
  }
  return workspaceFolders[0].uri.fsPath;
}

/**
 * Initialize a hidden .vanguard/git internal repository on extension activation.
 */
export async function initializeTimeMachine(): Promise<void> {
  const dir = getVanguardGitDir();
  if (!fs.existsSync(dir)) {
    const root = getWorkspaceRoot();
    fs.mkdirSync(dir, { recursive: true });
    // IMPORTANT: Define explicit gitdir and dir so a nested .git is not created
    await git.init({ fs, dir: root, gitdir: dir });
  }
}

/**
 * Programmatically create a commit with the user's prompt as the commit message.
 */
export async function commitMutationToHistory(input: MutationCommitInput): Promise<string | null> {
  const gitDir = getVanguardGitDir();
  const rootDir = getWorkspaceRoot();
  
  const relativeFile = path.relative(rootDir, input.filePath).replace(/\\/g, "/");
  
  // To allow isomorphic-git to run decoupled from the standard .git, we use `dir=rootDir`
  // and `gitdir=gitDir` to isolate Vanguard's time machine.
  await git.add({ fs, dir: rootDir, gitdir: gitDir, filepath: relativeFile });
  try {
    const oid = await git.commit({
      fs,
      dir: rootDir,
      gitdir: gitDir,
      message: buildMessage(input),
      author: {
        name: process.env.VANGUARD_GIT_AUTHOR_NAME ?? "Vanguard AI",
        email: process.env.VANGUARD_GIT_AUTHOR_EMAIL ?? "vanguard@local",
        timestamp: Math.floor(Date.now() / 1000)
      }
    });
    return oid;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("no changes")) {
      return null;
    }
    throw error;
  }
}

/**
 * Retrieve the last 10 successful mutations from the time machine.
 */
export async function getMutationHistory(limit = 10): Promise<VanguardHistoryEntry[]> {
  try {
    const gitDir = getVanguardGitDir();
    const rootDir = getWorkspaceRoot();
    if (!fs.existsSync(gitDir)) {
      return [];
    }

    const commits = await git.log({ fs, dir: rootDir, gitdir: gitDir, depth: limit });
    return commits.map(c => ({
      oid: c.oid,
      message: c.commit.message,
      timestamp: c.commit.author.timestamp * 1000
    }));
  } catch (err) {
    return [];
  }
}

/**
 * Performs a git checkout to that specific commit, restoring the workspace state in under 500ms.
 */
export async function restoreMutation(oid: string): Promise<void> {
  const gitDir = getVanguardGitDir();
  const rootDir = getWorkspaceRoot();
  
  // isomorphic-git checkout requires we use force or standard checkout rules.
  // We restore the state.
  await git.checkout({
    fs,
    dir: rootDir,
    gitdir: gitDir,
    ref: oid,
    force: true // Instantly drop all intermediate Vanguard changes to restore exactly to that point
  });
}

function buildMessage(input: MutationCommitInput): string {
  const clipped = input.prompt.length > 80 ? `${input.prompt.slice(0, 80)}...` : input.prompt;
  return `vanguard: mutate ${input.vId}\n\nprompt: ${clipped}`;
}
