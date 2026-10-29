// Stable installation-root tools accompany every Windows package. Versioned
// application/recovery files are published separately; mutable data never is.
export const windowsRootTools = ['start-app.bat', 'recover-app.bat', 'start-windows.ps1', 'recover-windows.ps1', 'windows-common.ps1', 'windows-snapshot.ps1', 'windows-package-lock.ps1', 'windows-package.ps1', 'windows-standalone-common.ps1'];
export const windowsPackageRootFiles = ['start.command', 'recover.command', ...windowsRootTools, 'README.md', 'LICENSE'];
