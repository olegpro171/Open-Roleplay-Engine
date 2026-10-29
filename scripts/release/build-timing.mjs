// Private build reports use stable phase identifiers, never child output, as
// diagnostics. These timings do not participate in the launcher event protocol.
export async function buildPhase(name, action) {
  const started = performance.now();
  let completed = false;
  console.log(`[Build phase] ${name}`);
  try {
    const result = await action();
    completed = true;
    return result;
  } finally {
    console.log(`[Timing] ${name}: ${Math.round(performance.now() - started)} ms; ${completed ? 'completed' : 'failed'}`);
  }
}
