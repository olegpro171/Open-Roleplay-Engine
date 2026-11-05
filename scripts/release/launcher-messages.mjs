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
