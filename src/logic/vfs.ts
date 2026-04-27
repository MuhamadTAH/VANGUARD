import { Volume } from "memfs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export type VfsEventType = "UPDATE_FILE" | "CREATE_FILE" | "DELETE_FILE";

export interface VfsEvent {
  type: VfsEventType;
  filePath: string;
  content?: string;
}

export class VirtualFileSystem {
  private readonly vol = new Volume();
  private readonly events: VfsEvent[] = [];

  /**
   * Buffers an AI output string into the VFS without touching the physical disk.
   */
  public bufferUpdate(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    this.vol.mkdirSync(dir, { recursive: true });
    
    const exists = this.vol.existsSync(filePath) || fs.existsSync(filePath);
    this.vol.writeFileSync(filePath, content, { encoding: "utf-8" });

    this.events.push({
      type: exists ? "UPDATE_FILE" : "CREATE_FILE",
      filePath,
      content
    });
  }

  public bufferCreate(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    this.vol.mkdirSync(dir, { recursive: true });
    this.vol.writeFileSync(filePath, content, { encoding: "utf-8" });
    this.events.push({ type: "CREATE_FILE", filePath, content });
  }

  public bufferDelete(filePath: string): void {
    if (this.vol.existsSync(filePath)) {
      this.vol.unlinkSync(filePath);
    }
    this.events.push({ type: "DELETE_FILE", filePath });
  }

  public readBuffer(filePath: string): string | null {
    if (this.vol.existsSync(filePath)) {
      return this.vol.readFileSync(filePath, "utf-8") as string;
    }
    return null;
  }

  public clearBuffer(): void {
    this.vol.reset();
    this.events.length = 0;
  }

  /**
   * Flushes all buffered events to the physical disk.
   * Only called AFTER Meriyah validation gives a "Green" status.
   */
  public async flushToDisk(): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    for (const event of this.events) {
      const uri = vscode.Uri.file(event.filePath);
      if (event.type === "CREATE_FILE" && event.content !== undefined) {
        edit.createFile(uri, { overwrite: true, contents: Buffer.from(event.content, "utf-8") });
      } else if (event.type === "UPDATE_FILE" && event.content !== undefined) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const fullRange = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        edit.replace(uri, fullRange, event.content);
      } else if (event.type === "DELETE_FILE") {
        edit.deleteFile(uri);
      }
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VFS: Failed to flush workspace edit to physical disk.");
    }

    // Save physical files
    for (const event of this.events) {
       if (event.type !== "DELETE_FILE") {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(event.filePath));
          await doc.save();
       }
    }
    this.clearBuffer();
  }
}

export const vfs = new VirtualFileSystem();
