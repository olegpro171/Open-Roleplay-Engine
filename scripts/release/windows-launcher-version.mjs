export const launcherVersion = 4;
export const minimumLauncherVersion = 1;

export function isLauncherVersion(value) {
  return Number.isInteger(value) && value >= 0 && value <= 2_147_483_647;
}

export function readLauncherVersion(batch) {
  const versions = [...batch.matchAll(/^\$LauncherVersion = ([1-9][0-9]*)$/gmu)];
  const version = Number(versions[0]?.[1]);
  if (versions.length !== 1 || !isLauncherVersion(version)) throw new Error('Invalid Windows batch launcher version.');
  return version;
}
