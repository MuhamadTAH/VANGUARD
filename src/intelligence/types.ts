export type IssueKind =
  | "missing-v-id"
  | "duplicate-v-id"
  | "invalid-v-id"
  | "drifted-v-id";

export interface SourcePoint {
  readonly line: number;
  readonly column: number;
}

export interface SourceRange {
  readonly start: SourcePoint;
  readonly end: SourcePoint;
}

export interface FingerprintIssue {
  readonly kind: IssueKind;
  readonly message: string;
  readonly range: SourceRange;
  readonly filePath: string;
  readonly key?: string;
  readonly vId?: string;
}

export interface VIdMapEntry {
  readonly vId: string;
  readonly filePath: string;
  readonly elementName: string;
  readonly key: string;
  readonly attributeRange: SourceRange;
}

export interface ValidationResult {
  readonly filePath: string;
  readonly issues: FingerprintIssue[];
  readonly map: VIdMapEntry[];
  readonly isValid: boolean;
}

export type BaselineByFile = Record<string, Record<string, string>>;
