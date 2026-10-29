import { afterEach, expect, it, vi } from 'vitest';
import { localLanHostname } from '../src/server/lan-hostname.js';

const { execute, systemHostname } = vi.hoisted(() => ({ execute: vi.fn(), systemHostname: vi.fn() }));
vi.mock('node:child_process', () => ({
  execFile: Object.assign(() => {}, { [Symbol.for('nodejs.util.promisify.custom')]: execute }),
}));
vi.mock('node:os', () => ({ hostname: systemHostname }));
afterEach(() => vi.resetAllMocks());

function result(value: string) {
  execute.mockResolvedValue({ stdout: value });
  systemHostname.mockReturnValue(value);
}
function failure(error: Error) {
  execute.mockRejectedValue(error);
  systemHostname.mockImplementation(() => { throw error; });
}

it('uses bounded system discovery and normalizes the admitted local hostname', async () => {
  result('ORE-Computer\n');
  expect(await localLanHostname()).toBe('ore-computer.local');
  if (process.platform === 'darwin') {
    expect(execute).toHaveBeenCalledWith('/usr/sbin/scutil', ['--get', 'LocalHostName'], { timeout: 1000, maxBuffer: 4096 });
    expect(systemHostname).not.toHaveBeenCalled();
  } else {
    expect(systemHostname).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  }
});

it.each([
  Object.assign(new Error('System command failed'), { code: 1 }),
  Object.assign(new Error('System command unavailable'), { code: 'ENOENT' }),
  Object.assign(new Error('OS hostname lookup failed'), { code: 'ERR_SYSTEM_ERROR' }),
  Object.assign(new Error('Discovery timed out'), { killed: true }),
])('reports expected system discovery failure as localized hostname metadata', async error => {
  failure(error);
  await expect(localLanHostname()).rejects.toMatchObject({ code: 'lan_hostname_unavailable', localized: { key: 'errors.the_computer_s_local_hostname_could_not_be' } });
});

it.each([undefined, 'ERR_INVALID_ARG_TYPE'])('preserves unexpected discovery errors with code %j as failures', async code => {
  const defect = Object.assign(new TypeError('Unexpected discovery defect'), { code });
  failure(defect);
  await expect(localLanHostname()).rejects.toBe(defect);
});

it.each(['', 'ore.local.attacker.example'])('rejects invalid discovered hostname %j with a localized diagnostic', async value => {
  result(value);
  await expect(localLanHostname()).rejects.toMatchObject({ code: 'lan_hostname_invalid', localized: { key: 'errors.the_computer_needs_a_valid_local_hostname_before' } });
});
