export const launcherVersion: number;
export const minimumLauncherVersion: number;
export function isLauncherVersion(value: unknown): value is number;
export function readLauncherVersion(batch: string): number;
