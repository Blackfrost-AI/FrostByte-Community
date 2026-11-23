import net from 'node:net';
import path from 'node:path';
const socket = net.connect(path.join(process.env.FROSTBYTE_AGENT_HOME || '/state', 'control.sock'));
socket.setTimeout(process.argv.includes('--wait-for-sharing') ? 30 * 60 * 1000 : 30000, () => socket.destroy(new Error('Spark request timed out.')));
socket.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.stdin.pipe(socket, { end: false }); socket.pipe(process.stdout);
