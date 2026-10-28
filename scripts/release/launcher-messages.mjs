import catalog from './launcher-messages.json' with { type: 'json' };

export function launcherMessage(id, language = 'en', parameters = {}) {
  const entry = catalog[id];
  if (!entry) throw new Error(`Unknown launcher message: ${id}`);
  return (entry[language] || entry.en).replace(/\{([A-Za-z]+)\}/gu, (match, name) => {
    if (!Object.hasOwn(parameters, name)) throw new Error(`Missing launcher parameter: ${name}`);
    return String(parameters[name]);
  });
}

// Only this finite protocol is accepted from build tools. Their stdout/stderr
// are diagnostics, never instructions to the presenter.
export function launcherEvent(id) {
  if (!['checkingVersion', 'activatingVersion'].includes(id)) throw new Error('Invalid build event.');
  if (process.platform === 'win32' && process.env.ORE_WINDOWS_BUILD_EVENTS) {
    // npm never receives this private channel. Windows does not inherit fd 3
    // through PowerShell/CreateProcess in the same way as the Bash controller.
    return import('node:fs').then(({ appendFileSync }) => appendFileSync(process.env.ORE_WINDOWS_BUILD_EVENTS, `${id}\n`, { encoding: 'utf8' }));
  }
  if (process.env.ORE_LAUNCH_EVENTS === '1') {
    return import('node:fs').then(({ writeSync }) => writeSync(3, `${id}\n`));
  }
}
