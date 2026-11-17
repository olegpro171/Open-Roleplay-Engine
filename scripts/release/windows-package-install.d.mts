export function verifyWindowsPackage(directory: string, commit: string): {id: string; runtime: string};
export function installWindowsPackage(directory: string, home: string, commit: string): {id: string; runtime: string};
export function prepareWindowsPackage(directory: string, home: string, commit: string): {id: string; runtime: string};
export function activatePreparedWindowsPackage(home: string, expected: {id: string; runtime: string}): {id: string; runtime: string};
