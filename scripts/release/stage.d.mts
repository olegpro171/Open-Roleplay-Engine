export function inventory(root: string, directory?: string): Array<{path: string; sha256: string; bytes: number} | {path: string; link: string}>;
