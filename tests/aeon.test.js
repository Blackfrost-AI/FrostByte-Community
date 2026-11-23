import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyDevice } from '../src/shared/device-models.js';
import { aeonCapabilities, deviceAeonTools } from '../src/shared/aeon.js';
import { aeonDeviceUrl } from '../src/main/aeon-device.js';
import { sanitizeSparkStatus } from '../src/main/spark-schema.js';

const hardware = identifyDevice({ platform: 'linux', architecture: 'arm64', reportedModel: 'Raspberry Pi 5 Model B Rev 1.0', cpuCores: 4 });
const image = { schema: 1, image: 'aeon-magick-orb', version: 'v116', port: 443, tools: ['models', 'devices', 'view'] };
test('AEON features require the image, Pi hardware and this device being connected', () => {
  assert.equal(hardware.kind, 'pi'); assert.equal(hardware.artwork, 'raspberry-pi');
  assert.deepEqual(aeonCapabilities(hardware, image), image);
  const mac = identifyDevice({ platform: 'darwin', modelIdentifier: 'Mac16,10' });
  assert.equal(aeonCapabilities(mac, image), null);
  assert.equal(aeonCapabilities(hardware, { ...image, image: 'other-image' }), null);
  assert.equal(deviceAeonTools({ connected: false, status: { hardware, aeon: image } }), null);
  assert.equal(deviceAeonTools({ connected: true, name: 'Raspberry Pi', status: { hardware: mac, aeon: image } }), null);
  const status = sanitizeSparkStatus({ hardware, aeon: image, capabilities: { ipfs: true } });
  assert.equal(deviceAeonTools({ connected: true, status }).version, 'v116');
});
test('AEON console links are fixed device-local tools with a saved address', () => {
  const device = { connected: true, status: { hardware, aeon: image } };
  assert.equal(aeonDeviceUrl(device, { host: 'orb.local' }, 'models'), 'https://orb.local/model-share');
  assert.equal(aeonDeviceUrl(device, { host: 'user@orb.local' }, 'devices'), 'https://orb.local/agent');
  assert.throws(() => aeonDeviceUrl(device, { host: 'orb.local' }, 'unrecognized'));
  assert.throws(() => aeonDeviceUrl({ ...device, connected: false }, { host: 'orb.local' }, 'models'));
  assert.throws(() => aeonDeviceUrl(device, { host: 'https://example.com' }, 'models'));
});
