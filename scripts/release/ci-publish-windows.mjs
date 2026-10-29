import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWindowsRelease, releaseRepository, validateCommit, windowsReleaseAssets } from './ci-release-files.mjs';

function githubClient(repository) {
  function gh(args, input) {
    const result = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const error = new Error(result.stderr || `GitHub CLI failed (${result.status}).`);
      error.notFound = /\(HTTP 404\)/u.test(result.stderr);
      throw error;
    }
    return result.stdout;
  }
  return {
    async request(path, method = 'GET', body) {
      const args = ['api', `repos/${repository}/${path}`, '--method', method, '-H', 'Accept: application/vnd.github+json'];
      if (body !== undefined) args.push('--input', '-');
      return JSON.parse(gh(args, body === undefined ? undefined : JSON.stringify(body)));
    },
    async upload(tag, path) { gh(['release', 'upload', tag, path, '--clobber', '--repo', repository]); },
    async descriptor(tag) { return JSON.parse(gh(['release', 'download', tag, '--pattern', 'ORE-windows-x64.json', '--output', '-', '--repo', repository])); },
  };
}
async function optional(client, path) {
  try { return await client.request(path); }
  catch (error) { if (error.notFound === true) return null; throw error; }
}
function requireAssets(release, directory) {
  if (!Array.isArray(release.assets)) throw new Error('Release asset list is missing.');
  for (const name of windowsReleaseAssets) {
    if (release.assets.filter(asset => asset.name === name && asset.state === 'uploaded' && Number.isSafeInteger(asset.size) && asset.size > 0).length !== 1) throw new Error(`Release asset is missing or incomplete: ${name}`);
    if (directory && release.assets.find(asset => asset.name === name).size !== statSync(join(directory, name)).size) throw new Error(`Uploaded release asset has the wrong size: ${name}`);
  }
}

// The workflow serializes this entire operation. Compare ancestry as well as
// serializing: GitHub concurrency groups do not promise FIFO execution order.
export async function publishWindowsRelease(directory, commit, client) {
  const descriptor = readWindowsRelease(directory, commit);
  const tag = `build-${commit}`;
  const main = await client.request('commits/main');
  validateCommit(main.sha);
  const ancestry = await client.request(`compare/${commit}...${main.sha}?per_page=1`);
  if (!['ahead', 'identical'].includes(ancestry.status) || ancestry.base_commit?.sha !== commit || ancestry.merge_base_commit?.sha !== commit) throw new Error('Release commit is not on current main history.');
  let reference = await optional(client, `git/ref/tags/${tag}`);
  if (!reference) reference = await client.request('git/refs', 'POST', { ref: `refs/tags/${tag}`, sha: commit });
  if (reference.object?.type !== 'commit' || reference.object.sha !== commit) throw new Error('Release tag points to another commit; it was preserved.');
  let release = await optional(client, `releases/tags/${tag}`);
  if (release && release.draft === false) {
    requireAssets(release);
    const published = await client.descriptor(tag);
    if (published.commit !== commit || published.launcherProtocol !== descriptor.launcherProtocol || published.formatVersion !== descriptor.formatVersion) throw new Error('Published release identity is incompatible; it was preserved.');
    return { tag, published: true, reused: true };
  }
  if (!release) {
    release = await client.request('releases', 'POST', {
      tag_name: tag, target_commitish: commit, name: `ORE · ${commit.slice(0, 12)}`, draft: true, prerelease: false,
      body: `Download **ORE-launcher.bat**, place it in the folder where you want ORE installed, and double-click it. The launcher downloads the prepared Windows x64 package and preserves saved data on updates.\n\nCommit: ${commit}\n\nWindows x64 is the only automated package in this release.`,
    });
  }
  if (!Number.isSafeInteger(release.id) || release.draft !== true || release.tag_name !== tag) throw new Error('Invalid draft release.');
  for (const name of windowsReleaseAssets) await client.upload(tag, join(directory, name));
  release = await client.request(`releases/${release.id}`);
  if (release.draft !== true || release.tag_name !== tag) throw new Error('Draft changed during upload; publication stopped.');
  requireAssets(release, directory);
  for (const asset of release.assets) if (!windowsReleaseAssets.includes(asset.name)) throw new Error('Unexpected draft asset; publication stopped.');
  const uploaded = await client.descriptor(tag);
  if (JSON.stringify(uploaded) !== JSON.stringify(descriptor)) throw new Error('Uploaded descriptor differs; publication stopped.');
  const committedReference = await client.request(`git/ref/tags/${tag}`);
  if (committedReference.object?.type !== 'commit' || committedReference.object.sha !== commit) throw new Error('Release tag changed during upload; draft retained.');
  let latest = true;
  const previous = await optional(client, 'releases/latest');
  if (previous && /^build-[0-9a-f]{40}$/u.test(previous.tag_name)) {
    const previousCommit = previous.tag_name.slice(6);
    const order = await client.request(`compare/${previousCommit}...${commit}?per_page=1`);
    if (order.status === 'behind') latest = false;
    else if (!['ahead', 'identical'].includes(order.status) || order.base_commit?.sha !== previousCommit || order.merge_base_commit?.sha !== previousCommit) throw new Error('Latest release is not a proven ancestor; draft retained.');
  }
  await client.request(`releases/${release.id}`, 'PATCH', { draft: false, make_latest: latest ? 'true' : 'false' });
  return { tag, published: true, latest, reused: false };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [directory, commit] = process.argv.slice(2);
  if (!directory || process.env.GITHUB_REPOSITORY !== releaseRepository || !process.env.GH_TOKEN) throw new Error('Publishing requires the release repository, GH_TOKEN, release directory and commit.');
  console.log(await publishWindowsRelease(resolve(directory), commit, githubClient(releaseRepository)));
}
