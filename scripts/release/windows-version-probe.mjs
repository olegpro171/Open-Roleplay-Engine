// Embedded in the external launcher so a verified older package can be checked
// before its installer changes the live selection. Run with the candidate's Node.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [installation, application, schemaText] = process.argv.slice(2);
const moduleUrl = name => pathToFileURL(join(application, 'scripts/release', name)).href;
const { resolveDatabase } = await import(moduleUrl('database-location.mjs'));
const { inspectDatabase } = await import(moduleUrl('check-database.mjs'));
const { verifyStartup } = await import(moduleUrl('startup-smoke.mjs'));

try {
  const schema = Number(schemaText);
  if (!Number.isSafeInteger(schema) || schema < 1) throw new Error('Invalid candidate database schema.');
  const database = resolveDatabase(installation, process.env, false);
  if (existsSync(database.path)) inspectDatabase(application, database.path, schema, true);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
await verifyStartup(application, process.execPath, join(installation, 'cache'));
