import { appendFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubClient, publishWindowsRelease } from './ci-publish-windows.mjs';
import { readWindowsRelease, releaseRepository, validateCommit } from './ci-release-files.mjs';

const workflowPath = '.github/workflows/windows-qualify.yml';
function positiveId(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid qualification identity.');
  return value;
}

// Inspect GitHub's run/immutable artifact records, never a moving branch name
// or a caller-supplied "tests passed" file. A squash/merge commit needs its own run.
export async function requireQualification(commit, client, runId, artifactId) {
  validateCommit(commit);
  positiveId(runId);
  const workflow = await client.request('actions/workflows/windows-qualify.yml');
  positiveId(workflow.id);
  const run = await client.request(`actions/runs/${runId}`);
  if (workflow.path !== workflowPath || run.workflow_id !== workflow.id || run.path !== workflowPath ||
      run.id !== runId || run.head_sha !== commit || run.head_branch !== 'staging' ||
      !['push', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed' || run.conclusion !== 'success' ||
      run.repository?.full_name !== releaseRepository || run.head_repository?.full_name !== releaseRepository) {
    throw new Error('This exact commit has no successful trusted staging qualification.');
  }
  const listing = await client.request(`actions/runs/${runId}/artifacts?per_page=100`);
  if (!Array.isArray(listing.artifacts) || listing.total_count > 100) throw new Error('Invalid qualification artifact list.');
  const matches = listing.artifacts.filter(artifact => artifact.name === `windows-x64-${commit}`);
  if (matches.length !== 1) throw new Error('Qualified release files are missing or ambiguous; requalify staging.');
  const artifact = matches[0];
  positiveId(artifact.id);
  if (artifact.expired !== false || !Number.isFinite(Date.parse(artifact.expires_at)) || Date.parse(artifact.expires_at) <= Date.now() ||
      !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 ||
      !/^sha256:[a-f0-9]{64}$/u.test(artifact.digest) ||
      artifact.workflow_run?.id !== runId || artifact.workflow_run?.head_sha !== commit ||
      artifact.workflow_run?.head_branch !== 'staging' || (artifactId !== undefined && artifact.id !== positiveId(artifactId))) {
    throw new Error('Qualified release artifact is expired or incompatible; requalify staging.');
  }
  return { runId, artifactId: artifact.id };
}

export async function selectQualification(commit, client) {
  validateCommit(commit);
  const listing = await client.request(`actions/workflows/windows-qualify.yml/runs?branch=staging&head_sha=${commit}&per_page=100`);
  if (!Array.isArray(listing.workflow_runs) || !listing.workflow_runs.length) {
    throw new Error('No staging qualification exists for this exact commit; qualify it before promoting main.');
  }
  // The newest run must succeed. Do not hide a failed/in-progress requalification
  // behind an older green result for the same source commit.
  return requireQualification(commit, client, listing.workflow_runs[0].id);
}

export async function requireFastForward(before, commit, client) {
  validateCommit(commit);
  validateCommit(before);
  if (/^0{40}$/u.test(before)) throw new Error('Release promotion requires an existing main branch.');
  const comparison = await client.request(`compare/${before}...${commit}?per_page=1`);
  if (!['ahead', 'identical'].includes(comparison.status) || comparison.base_commit?.sha !== before || comparison.merge_base_commit?.sha !== before) {
    throw new Error('Main promotion must fast-forward; existing release history was preserved.');
  }
}

export function verifyPromotedFiles(directory, commit, launcher) {
  readWindowsRelease(directory, commit);
  if (!readFileSync(join(directory, 'ORE-launcher.bat')).equals(readFileSync(launcher))) {
    throw new Error('Qualified launcher differs from the promoted commit.');
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [action, commit, directory] = process.argv.slice(2);
  if (!['select', 'publish'].includes(action) || process.env.GITHUB_REPOSITORY !== releaseRepository ||
      process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_SHA !== commit || !process.env.GH_TOKEN) {
    throw new Error('Promotion requires the exact main workflow commit and repository token.');
  }
  const client = githubClient(releaseRepository);
  if (process.env.GITHUB_EVENT_NAME === 'push') {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
    await requireFastForward(event.before, commit, client);
  } else if (process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
    throw new Error('Unsupported release promotion event.');
  }
  if (action === 'select') {
    if (!process.env.GITHUB_OUTPUT) throw new Error('Missing workflow output file.');
    const qualification = await selectQualification(commit, client);
    appendFileSync(process.env.GITHUB_OUTPUT, `run-id=${qualification.runId}\nartifact-id=${qualification.artifactId}\n`);
    console.log(`Qualified staging run ${qualification.runId}; immutable artifact ${qualification.artifactId}.`);
  } else {
    if (!directory) throw new Error('Missing qualified release directory.');
    await requireQualification(commit, client, Number(process.env.ORE_QUALIFIED_RUN), Number(process.env.ORE_QUALIFIED_ARTIFACT));
    verifyPromotedFiles(resolve(directory), commit, resolve('ORE-launcher.bat'));
    console.log(await publishWindowsRelease(resolve(directory), commit, client));
  }
}
