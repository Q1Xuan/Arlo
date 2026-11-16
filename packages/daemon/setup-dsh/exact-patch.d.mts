export interface ExactHunk { before: string[]; after: string[]; beforeNoNewline: boolean; afterNoNewline: boolean }
export function sha256(bytes: string | Buffer): string;
export function fileSha256(file: string): string;
export function readExactPatch(bytes: string | Buffer): Array<{ file: string; hunks: ExactHunk[] }>;
export function applyExactHunks(bytes: string | Buffer, hunks: ExactHunk[], inverse?: boolean): Buffer;
export function packageInventory(directory: string): Record<string, string>;
export function replaceOwnedFile(file: string, bytes: string | Buffer, expected: string): void;
