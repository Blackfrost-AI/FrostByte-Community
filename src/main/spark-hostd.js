import fs from 'node:fs';

// The same bounded adapter runs for native SSH and inside new managed-key bridges.
// Credentials are read only on Spark and never travel back to the desktop.
export const SPARK_HOSTD_SOURCE = fs.readFileSync(new URL('../hostd/spark_bridge.py', import.meta.url), 'utf8');
const revision = /^BRIDGE_REVISION = (\d+)$/m.exec(SPARK_HOSTD_SOURCE);
if (!revision) throw new Error('spark_bridge.py must declare BRIDGE_REVISION.');
/** Revision of the bridge bundled with this build; older paired helpers need "Update companion". */
export const SPARK_BRIDGE_REVISION = Number(revision[1]);
const standalone = SPARK_HOSTD_SOURCE + `
import sys
try:
 raw=sys.stdin.buffer.read(8193)
 if len(raw)>8192: raise ValueError('Device-management request is too large.')
 data=spark_hostd_request(json.loads(raw))
 print(json.dumps({'ok':True,'data':data},allow_nan=False))
except Exception as error:
 print(json.dumps({'ok':False,'error':str(error) if isinstance(error,ValueError) else 'Device management could not be verified.'}))
`;
export const SPARK_HOSTD_COMMAND = `python3 -c 'import base64;exec(base64.b64decode("${Buffer.from(standalone).toString('base64')}"))'`;
