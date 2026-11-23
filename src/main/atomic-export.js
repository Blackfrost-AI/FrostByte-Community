import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function atomicExport(target, data) {
  const temporary = path.join(path.dirname(target), '.' + path.basename(target) + '.' + randomUUID() + '.tmp');
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600); fs.writeFileSync(fd, data); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temporary, target);
    // Node cannot flush a directory handle on Windows (EPERM). The file above
    // is still flushed before atomic replacement on every platform. Do not
    // report a successfully saved export as failed by flushing a Win32 folder.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(target), 'r'); try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
  } finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
