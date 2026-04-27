import { parse } from "@babel/parser";
import type { File } from "@babel/types";

export function parseTsxOrJsx(source: string, filePath: string): File {
  return parse(source, {
    sourceType: "module",
    sourceFilename: filePath,
    errorRecovery: false,
    plugins: [
      "jsx",
      "typescript"
    ]
  });
}
