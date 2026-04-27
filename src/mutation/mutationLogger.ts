import * as vscode from "vscode";

let outputChannel: vscode.OutputChannel | null = null;

export function setMutationOutputChannel(channel: vscode.OutputChannel): void {
  outputChannel = channel;
}

export function logMutation(message: string): void {
  if (outputChannel) {
    outputChannel.appendLine(`[mutation] ${message}`);
    return;
  }
  console.log(`[mutation] ${message}`);
}

