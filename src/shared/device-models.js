/** Hardware IDs only: never infer a chassis from RAM, CPU, hostname, or a serial number. */
const apple = {
  mini: 'https://support.apple.com/en-us/102852',
  studio: 'https://support.apple.com/en-us/102231',
  pro: 'https://support.apple.com/en-us/108052',
  air: 'https://support.apple.com/en-us/102869',
  tower: 'https://support.apple.com/en-us/102887',
};
const models = new Map();
function add(ids, name, artwork, source) {
  for (const id of ids.split(' ')) models.set(id, Object.freeze({ name, artwork, source }));
}
add('Mac16,10 Mac16,11', 'Mac mini (2024)', 'mac-mini-2024', apple.mini);
add('Mac14,3 Mac14,12', 'Mac mini (2023)', 'mac-mini-unibody', apple.mini);
add('Macmini9,1', 'Mac mini (M1, 2020)', 'mac-mini-unibody', apple.mini);
add('Macmini8,1', 'Mac mini (2018)', 'mac-mini-2018', apple.mini);
add('Macmini7,1', 'Mac mini (Late 2014)', 'mac-mini-unibody', apple.mini);
add('Macmini6,1 Macmini6,2', 'Mac mini (Late 2012)', 'mac-mini-unibody', apple.mini);
add('Mac16,9 Mac15,14', 'Mac Studio (2025)', 'mac-studio', apple.studio);
add('Mac14,13 Mac14,14', 'Mac Studio (2023)', 'mac-studio', apple.studio);
add('Mac13,1 Mac13,2', 'Mac Studio (2022)', 'mac-studio', apple.studio);
// Tower and rack share an identifier; the stock tower photo is representative.
add('Mac14,8', 'Mac Pro (2023)', 'mac-pro-tower', apple.tower);
add('MacPro7,1', 'Mac Pro (2019)', 'mac-pro-tower', apple.tower);
add('MacPro6,1', 'Mac Pro (Late 2013)', 'mac-pro-2013', apple.tower);
add('MacPro5,1', 'Mac Pro (2010–2012)', 'mac-pro-classic', apple.tower);
add('Mac17,7 Mac17,9', 'MacBook Pro (14-inch, 2026)', 'macbook-pro-14', apple.pro);
add('Mac17,6 Mac17,8', 'MacBook Pro (16-inch, 2026)', 'macbook-pro-16', apple.pro);
add('Mac17,2', 'MacBook Pro (14-inch, M5, 2025)', 'macbook-pro-14', apple.pro);
add('Mac16,1 Mac16,6 Mac16,8', 'MacBook Pro (14-inch, 2024)', 'macbook-pro-14', apple.pro);
add('Mac16,7 Mac16,5', 'MacBook Pro (16-inch, 2024)', 'macbook-pro-16', apple.pro);
add('Mac15,3 Mac15,6 Mac15,8 Mac15,10', 'MacBook Pro (14-inch, Nov 2023)', 'macbook-pro-14', apple.pro);

add('Mac15,7 Mac15,9 Mac15,11', 'MacBook Pro (16-inch, Nov 2023)', 'macbook-pro-16', apple.pro);
add('Mac14,5 Mac14,9', 'MacBook Pro (14-inch, 2023)', 'macbook-pro-14', apple.pro);
add('Mac14,6 Mac14,10', 'MacBook Pro (16-inch, 2023)', 'macbook-pro-16', apple.pro);
add('MacBookPro18,3 MacBookPro18,4', 'MacBook Pro (14-inch, 2021)', 'macbook-pro-14', apple.pro);
add('MacBookPro18,1 MacBookPro18,2', 'MacBook Pro (16-inch, 2021)', 'macbook-pro-16', apple.pro);
add('Mac17,3', 'MacBook Air (13-inch, M5, 2026)', 'macbook-air', apple.air);
add('Mac17,4', 'MacBook Air (15-inch, M5, 2026)', 'macbook-air-15', apple.air);
add('Mac16,12', 'MacBook Air (13-inch, M4, 2025)', 'macbook-air', apple.air);
add('Mac16,13', 'MacBook Air (15-inch, M4, 2025)', 'macbook-air-15', apple.air);
add('Mac15,12', 'MacBook Air (13-inch, M3, 2024)', 'macbook-air', apple.air);
add('Mac15,13', 'MacBook Air (15-inch, M3, 2024)', 'macbook-air-15', apple.air);
add('Mac14,2', 'MacBook Air (M2, 2022)', 'macbook-air', apple.air);
add('Mac14,15', 'MacBook Air (15-inch, M2, 2023)', 'macbook-air-15', apple.air);
add('MacBookAir10,1', 'MacBook Air (M1, 2020)', 'macbook-air-wedge', apple.air);
add('MacBookAir9,1', 'MacBook Air (Retina, 13-inch, 2020)', 'macbook-air-wedge', apple.air);
add('Mac16,3', 'iMac (24-inch, 2024, four ports)', 'imac-24', 'https://support.apple.com/en-us/108054');
add('Mac16,2', 'iMac (24-inch, 2024, two ports)', 'imac-24', 'https://support.apple.com/en-us/108054');
add('Mac15,5', 'iMac (24-inch, 2023, four ports)', 'imac-24', 'https://support.apple.com/en-us/108054');

export const DEVICE_ARTWORK = Object.freeze(['computer', 'raspberry-pi', 'pc-laptop', 'pc-desktop', 'mac-mini-2024', 'mac-mini-unibody', 'mac-mini-2018', 'mac-studio', 'mac-pro-tower', 'mac-pro-rack', 'mac-pro-2013', 'mac-pro-classic', 'macbook-pro-14', 'macbook-pro-16', 'macbook-air', 'macbook-air-15', 'macbook-air-wedge', 'imac-24', 'dgx-spark', 'asus-gx10', 'dell-gb10', 'dgx-station', 'rack-server']);
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 160) : '';
const normalized = value => clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');

export function identifyDevice(input = {}) {
  const platform = ['darwin', 'linux', 'win32'].includes(input.platform) ? input.platform : 'unknown';
  const modelIdentifier = clean(input.modelIdentifier), vendor = clean(input.vendor);
  const reportedModel = clean(input.reportedModel);
  const found = platform === 'darwin' ? models.get(modelIdentifier) : undefined;
  let name = found?.name || reportedModel || modelIdentifier || (platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows PC' : 'Computer');
  let artwork = found?.artwork || 'computer', match = found ? 'exact' : 'unknown', kind = platform === 'darwin' ? 'mac' : 'computer', source = found?.source || '';
  if (platform === 'win32') artwork = input.formFactor === 'laptop' ? 'pc-laptop' : 'pc-desktop';
  // OEM GB10 systems must keep their reported make/model. The same chip does
  // not make an ASUS, Dell, or HP enclosure an NVIDIA DGX Spark.
  if (platform === 'linux' && /^nvidia(?: corporation)?$/.test(normalized(vendor))) {
    const model = normalized(reportedModel || modelIdentifier).replace(/^nvidia /, '');
    if (model === 'dgx spark') { name = 'NVIDIA DGX Spark'; artwork = 'dgx-spark'; match = 'exact'; kind = 'dgx'; source = 'https://docs.nvidia.com/dgx/dgx-spark/hardware.html'; }
    else if (/^dgx\b/.test(model)) { kind = 'dgx'; artwork = model.includes('station') ? 'dgx-station' : 'rack-server'; match = 'family'; }
  }
  const model = normalized(reportedModel || modelIdentifier);
  if (platform === 'linux' && /^raspberry pi (?:4|5)(?: model b)?(?: rev [0-9.]+)?$/.test(model)) {
    name = reportedModel || modelIdentifier; artwork = 'raspberry-pi'; match = 'family'; kind = 'pi'; source = 'https://www.raspberrypi.com/products/';
  }
  if (platform === 'linux' && /^(?:asus|asustek computer(?: inc\.?)?)$/.test(normalized(vendor)) && /^(?:asus )?(?:ascent )?gx10(?:[ .-].*)?$/.test(model)) {
    name = 'ASUS Ascent GX10'; artwork = 'asus-gx10'; match = 'exact'; kind = 'dgx'; source = 'https://www.asus.com/networking-iot-servers/desktop-ai-supercomputer/ultra-small-ai-supercomputers/asus-ascent-gx10/';
  }
  if (platform === 'linux' && /^dell(?: inc\.?)?$/.test(normalized(vendor)) && /^(?:dell )?(?:pro max (?:with )?gb10(?: fcm1253)?|pro max fcm1253|fcm1253)$/.test(model)) {
    name = 'Dell Pro Max with GB10'; artwork = 'dell-gb10'; match = 'exact'; kind = 'dgx'; source = 'https://www.dell.com/support/product-details/en-us/product/dell-pro-max-fcm1253-micro/overview';
  }
  const memoryBytes = Number.isSafeInteger(input.memoryBytes) && input.memoryBytes > 0 ? input.memoryBytes : 0;
  let cpuCores = Number.isInteger(input.cpuCores) && input.cpuCores > 0 && input.cpuCores < 65536 ? input.cpuCores : 0;
  const logicalCpuCount = Number.isInteger(input.logicalCpuCount) && input.logicalCpuCount > 0 && input.logicalCpuCount < 65536 ? input.logicalCpuCount : 0;
  const reportedChip = clean(input.chip);
  // Linux currently reports this SoC as "unknown" through os.cpus(). The
  // exact NVIDIA model identifier has a documented GB10, unlike OEM GB10 boxes.
  const gb10 = ['dgx-spark', 'asus-gx10', 'dell-gb10'].includes(artwork);
  if (!cpuCores && gb10) cpuCores = 20;
  const chip = gb10 && (!reportedChip || /^unknown$/i.test(reportedChip)) ? 'NVIDIA GB10 Grace' : reportedChip;
  const gpus = (Array.isArray(input.gpus) ? input.gpus : []).slice(0, 16).map(gpu => ({
    name: clean(gpu?.name), cores: Number.isInteger(gpu?.cores) && gpu.cores > 0 && gpu.cores < 65536 ? gpu.cores : 0,
    source: gpu?.source === 'model' ? 'model' : 'system',
  })).filter(gpu => gpu.name && !/^(?:unknown|not supported|n\/a)$/i.test(gpu.name));
  if (!gpus.length && gb10) gpus.push({ name: 'NVIDIA GB10 Blackwell', cores: 0, source: 'model' });
  const formFactor = platform === 'darwin' ? (/^MacBook/.test(name) ? 'laptop' : 'desktop') : input.formFactor === 'laptop' ? 'laptop' : 'desktop';
  return { schemaVersion: 2, platform, architecture: clean(input.architecture), vendor: platform === 'darwin' ? 'Apple' : vendor,
    modelIdentifier, name, kind, chip, memoryBytes, cpuCores, logicalCpuCount, gpus, formFactor, osVersion: clean(input.osVersion), artwork, artworkMatch: match, source };
}

export function deviceArtwork(hardware, selected) {
  return DEVICE_ARTWORK.includes(selected) ? selected : DEVICE_ARTWORK.includes(hardware?.artwork) ? hardware.artwork : 'computer';
}
