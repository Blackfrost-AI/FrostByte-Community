/** Read a small allowlist of hardware facts. No serials, UUIDs, MAC addresses, or cloud lookup. */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { identifyDevice } from '../shared/device-models.js';

const execute = promisify(execFile);
function cpuList(value) {
  const ids = new Set();
  for (const part of value.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) return [];
    const first = Number(match[1]), last = Number(match[2] ?? match[1]);
    if (last < first || last > 4095) return [];
    for (let id = first; id <= last; id++) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}
async function linuxCoreCount(text) {
  const cpus = cpuList(await text('/sys/devices/system/cpu/online'));
  const cores = new Set();
  // core IDs can repeat across ARM clusters. Kernel sibling membership identifies
  // the actual physical core on both SMT x86 and heterogeneous ARM machines.
  for (let offset = 0; offset < cpus.length; offset += 32) {
    const rows = await Promise.all(cpus.slice(offset, offset + 32).map(async id => {
      const dir = `/sys/devices/system/cpu/cpu${id}/topology/`;
      const siblings = cpuList(await text(dir + 'core_cpus_list') || await text(dir + 'thread_siblings_list'));
      return siblings.includes(id) ? siblings.join(',') : '';
    }));
    if (rows.some(row => !row)) return 0;
    rows.forEach(row => cores.add(row));
  }
  return cores.size;
}
export async function readDeviceInfo({ platform = process.platform, architecture = os.arch(), memoryBytes = os.totalmem(), cpuCores = 0, logicalCpuCount = os.cpus().length, run = execute, read = fs.readFile, env = process.env } = {}) {
  const command = async (file, args) => { try { return String((await run(file, args, { timeout: 4000, maxBuffer: 64 * 1024, windowsHide: true })).stdout || '').trim(); } catch { return ''; } };
  const text = async path => { try { return String(await read(path, 'utf8')).replace(/\0/g, '').trim().slice(0, 160); } catch { return ''; } };
  const info = { platform, architecture, memoryBytes, cpuCores, logicalCpuCount };
  if (platform === 'darwin') {
    const [modelIdentifier, chip, osVersion, graphics, physicalCores] = await Promise.all([
      command('/usr/sbin/sysctl', ['-n', 'hw.model']), command('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']), command('/usr/bin/sw_vers', ['-productVersion']),
      // Apple's mini detail level excludes personal information. Only GPU facts
      // below survive parsing; connected-display details are never retained.
      command('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-detailLevel', 'mini', '-json', '-timeout', '3']),
      command('/usr/sbin/sysctl', ['-n', 'hw.physicalcpu']),
    ]);
    let displays = []; try { displays = JSON.parse(graphics).SPDisplaysDataType || []; } catch {}
    const gpus = Array.isArray(displays) ? displays.slice(0, 16).map(gpu => ({ name: gpu.sppci_model || gpu._name, cores: Number(gpu.sppci_cores), source: 'system' })) : [];
    Object.assign(info, { modelIdentifier, chip, osVersion, gpus, cpuCores: Number(physicalCores) || cpuCores });
  } else if (platform === 'linux') {
    const [vendor, modelIdentifier, deviceTree, release, physicalCores] = await Promise.all([
      text('/sys/class/dmi/id/sys_vendor'), text('/sys/class/dmi/id/product_name'), text('/proc/device-tree/model'), text('/etc/os-release'),
      linuxCoreCount(text),
    ]);
    // Docker's /etc/os-release describes its base image, not the user's host.
    // The managed Linux installer supplies only the host's public OS label.
    const osVersion = env.FROSTBYTE_HOST_OS || release.match(/^PRETTY_NAME="?([^"\r\n]+)/m)?.[1] || os.release();
    // Managed Docker companions receive only names from the host's GPU query;
    // this does not grant the container GPU access or require NVIDIA drivers in it.
    let gpus = []; try { gpus = JSON.parse(env.FROSTBYTE_HOST_GPUS || '[]'); } catch {}
    if (!Array.isArray(gpus) || !gpus.length) {
      // Absolute system paths only — same bare-name planting defense as the
      // Windows PowerShell launch below. First installed location wins.
      let names = '';
      for (const bin of ['/usr/bin/nvidia-smi', '/usr/local/bin/nvidia-smi', '/opt/bin/nvidia-smi']) {
        try { names = await command(bin, ['--query-gpu=name', '--format=csv,noheader']); break; } catch {}
      }
      gpus = names.split('\n').filter(Boolean).slice(0, 16).map(name => ({ name, source: 'system' }));
    }
    Object.assign(info, { vendor, modelIdentifier, reportedModel: env.FROSTBYTE_HOST_MODEL || modelIdentifier || deviceTree, chip: os.cpus()[0]?.model || '', osVersion, gpus, cpuCores: physicalCores || cpuCores });
  } else if (platform === 'win32') {
    // Explicit properties keep serial numbers and hardware UUIDs out of the process output.
    // Security fix (external report #5): launch PowerShell by absolute system
    // path, never by bare name — a bare-name lookup searches the app/CWD
    // first on Windows and can execute a planted powershell.exe.
    const systemRoot = env.SystemRoot || 'C:\\Windows';
    const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const output = await command(powershell, ['-NoProfile', '-NonInteractive', '-Command', "$c=Get-CimInstance Win32_ComputerSystem -Property Manufacturer,Model,SystemFamily,PCSystemType; $e=Get-CimInstance Win32_SystemEnclosure -Property ChassisTypes; $p=@(Get-CimInstance Win32_Processor -Property Name,NumberOfCores); $g=@(Get-CimInstance Win32_VideoController -Property Name | ForEach-Object { @{name=$_.Name;source='system'} }); @{vendor=$c.Manufacturer;model=$c.Model;family=$c.SystemFamily;systemType=$c.PCSystemType;chassis=@($e.ChassisTypes);gpus=$g;chip=(($p | ForEach-Object {$_.Name}) -join ' + ');cpuCores=($p | Measure-Object -Property NumberOfCores -Sum).Sum}|ConvertTo-Json -Depth 4 -Compress"]);
    let hardware = {}; try { hardware = JSON.parse(output); } catch {}
    const portable = hardware.systemType === 2 || (Array.isArray(hardware.chassis) && hardware.chassis.some(type => [8, 9, 10, 11, 14, 30, 31, 32].includes(type)));
    const family = typeof hardware.family === 'string' && !/^(?:default string|to be filled by o\.e\.m\.|system family)$/i.test(hardware.family.trim()) ? hardware.family.trim() : '';
    const gpus = Array.isArray(hardware.gpus) ? hardware.gpus.filter(gpu => !/USB.*Graphic|DisplayLink|Remote Display|Indirect Display|Virtual Display/i.test(gpu?.name || '')) : [];
    Object.assign(info, { vendor: hardware.vendor, modelIdentifier: hardware.model, reportedModel: family ? [hardware.vendor, family].filter(Boolean).join(' ') : hardware.model, chip: hardware.chip || os.cpus()[0]?.model || '', cpuCores: Number(hardware.cpuCores) || cpuCores, osVersion: os.release(), formFactor: portable ? 'laptop' : 'desktop', gpus });
  }
  return identifyDevice(info);
}

let cached;
export function fallbackDeviceInfo() {
  return identifyDevice({
    platform: process.platform,
    architecture: os.arch(),
    memoryBytes: os.totalmem(),
    logicalCpuCount: os.cpus().length,
    chip: os.cpus()[0]?.model || '',
    osVersion: os.release(),
  });
}

export function boundedDeviceInfo({ probe = readDeviceInfo, fallback = fallbackDeviceInfo, timeoutMs = 6000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // This deadline is part of the returned promise's progress guarantee. Keep
    // it referenced so a quiet process cannot exit while a caller awaits it.
    const timer = setTimeout(() => finish(fallback()), timeoutMs);
    Promise.resolve().then(probe).then(finish, () => finish(fallback()));
  });
}

export function getDeviceInfo() { return cached ||= boundedDeviceInfo(); }
