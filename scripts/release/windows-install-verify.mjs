import { verifyApplication } from './application-assets.mjs';
const info = verifyApplication(process.argv[2]);
if (info.kind !== 'release') throw new Error('Standalone startup requires a release identity.');
console.log(`Verified installed ${info.commit}; runtime ${info.node}; schema ${info.schema}`);
