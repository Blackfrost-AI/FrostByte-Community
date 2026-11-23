import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function advisoryId(value) {
  if (!value || typeof value !== 'object') return null;
  const match = /^https:\/\/github\.com\/advisories\/(GHSA-[0-9a-z-]+)$/i.exec(value.url || '');
  return match?.[1].toUpperCase() || null;
}

function idsFor(name, vulnerabilities, stack = new Set()) {
  if (stack.has(name)) throw new Error(`npm audit contains a cyclic vulnerability graph at ${name}.`);
  const record = vulnerabilities[name];
  if (!record || !Array.isArray(record.via)) throw new Error(`npm audit contains an unresolved vulnerability reference: ${name}.`);
  const next = new Set(stack).add(name);
  const ids = new Set();
  for (const via of record.via) {
    if (typeof via === 'string') {
      for (const id of idsFor(via, vulnerabilities, next)) ids.add(id);
    } else {
      const id = advisoryId(via);
      if (!id) throw new Error(`npm audit returned an advisory without a canonical GitHub advisory URL for ${name}.`);
      ids.add(id);
    }
  }
  if (!ids.size) throw new Error(`npm audit did not identify the advisory behind ${name}.`);
  return ids;
}

function packageNameFromLockPath(lockPath) {
  const marker = 'node_modules/';
  const at = lockPath.lastIndexOf(marker);
  return at < 0 ? null : lockPath.slice(at + marker.length);
}

function lockedAuditNodes(name, record, lock) {
  if (!Array.isArray(record.nodes) || !record.nodes.length || record.nodes.some(node => typeof node !== 'string' || !node)) {
    throw new Error(`npm audit did not identify the locked dependency paths for ${name}.`);
  }
  const nodes = [];
  for (const node of new Set(record.nodes)) {
    const metadata = lock?.packages?.[node];
    if (!metadata || packageNameFromLockPath(node) !== name || typeof metadata.version !== 'string') {
      throw new Error(`npm audit referenced an unknown locked dependency path for ${name}: ${node}.`);
    }
    nodes.push({ path: node, version: metadata.version });
  }
  return nodes;
}

export function validateAudit(report, policy, lock, today = new Date().toISOString().slice(0, 10)) {
  if (report?.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    throw new Error(`npm audit did not return a version 2 advisory report${report?.error?.detail ? `: ${report.error.detail}` : '.'}`);
  }
  if (policy?.schemaVersion !== 1 || !Array.isArray(policy.exceptions)) throw new Error('Unsupported npm audit policy schema.');
  const allowed = new Map();
  for (const exception of policy.exceptions) {
    if (!/^GHSA-[0-9a-z-]+$/i.test(exception.advisory || '') || allowed.has(exception.advisory.toUpperCase())) {
      throw new Error('Every audit exception must have a unique GHSA identifier.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.reviewExpires || '') || today > exception.reviewExpires) {
      throw new Error(`Audit exception ${exception.advisory} expired on ${exception.reviewExpires || 'an invalid date'}.`);
    }
    if (!exception.owner?.trim() || !exception.reason?.trim()) throw new Error(`Audit exception ${exception.advisory} needs an owner and reason.`);
    if (typeof exception.package !== 'string' || !exception.package || typeof exception.version !== 'string'
      || !Array.isArray(exception.nodes) || !exception.nodes.length) {
      throw new Error(`Audit exception ${exception.advisory} needs a package, version, and locked nodes.`);
    }
    const nodeIds = new Set();
    for (const node of exception.nodes) {
      const locked = lock?.packages?.[node?.path];
      if (!node || typeof node.path !== 'string' || typeof node.version !== 'string'
        || packageNameFromLockPath(node.path) !== exception.package || node.version !== exception.version
        || !locked || locked.version !== node.version) {
        throw new Error(`Audit exception ${exception.advisory} has an unreviewed or missing locked node.`);
      }
      const identity = `${node.path}\0${node.version}`;
      if (nodeIds.has(identity)) throw new Error(`Audit exception ${exception.advisory} repeats a locked node.`);
      nodeIds.add(identity);
    }
    allowed.set(exception.advisory.toUpperCase(), { ...exception, nodeIds });
  }

  const affected = new Map();
  for (const name of Object.keys(report.vulnerabilities)) {
    const nodes = lockedAuditNodes(name, report.vulnerabilities[name], lock);
    for (const id of idsFor(name, report.vulnerabilities)) {
      if (!allowed.has(id)) throw new Error(`Unexpected production dependency advisory: ${id} (${name}).`);
      if (!affected.has(id)) affected.set(id, new Set());
      affected.get(id).add(name);
      const exception = allowed.get(id);
      if (name === exception.package) {
        const actualNodeIds = new Set(nodes.map(node => `${node.path}\0${node.version}`));
        if (actualNodeIds.size !== exception.nodeIds.size || [...actualNodeIds].some(node => !exception.nodeIds.has(node))) {
          throw new Error(`Audit exception ${id} reached an unreviewed ${name} node or version.`);
        }
      }
    }
  }

  for (const [id, names] of affected) {
    const exception = allowed.get(id);
    const actual = [...names].sort();
    const expected = [...exception.affectedPackages].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`Audit exception ${id} reached a different package chain: ${actual.join(', ') || 'none'}.`);
    }
    const direct = report.vulnerabilities[exception.package]?.via?.find(via => advisoryId(via) === id);
    if (!direct || direct.severity !== exception.severity) {
      throw new Error(`Audit exception ${id} changed severity or advisory ownership.`);
    }
  }
  return [...affected.keys()];
}

export function npmAuditInvocation({ nodePath = process.execPath, npmExecPath = process.env.npm_execpath } = {}) {
  if (typeof npmExecPath !== 'string' || !path.isAbsolute(npmExecPath)) {
    throw new Error('Run the production audit through `npm run audit:production` so npm can provide its JavaScript CLI path.');
  }
  const cliPath = fs.realpathSync(npmExecPath);
  const packageRoot = path.dirname(path.dirname(cliPath));
  const metadata = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  const declaredCli = typeof metadata.bin === 'object' && typeof metadata.bin?.npm === 'string'
    ? path.resolve(packageRoot, metadata.bin.npm)
    : null;
  if (metadata.name !== 'npm' || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(metadata.version || '')
    || path.basename(cliPath) !== 'npm-cli.js' || declaredCli !== cliPath) {
    throw new Error('npm_execpath does not identify the declared JavaScript CLI of an npm package.');
  }
  return { command: nodePath, args: [cliPath, 'audit', '--omit=dev', '--json'] };
}

function main() {
  // Node does not portably spawn Windows .cmd wrappers without a shell. Execute
  // npm's own declared JavaScript entry point with the current Node instead.
  const invocation = npmAuditInvocation();
  const result = spawnSync(invocation.command, invocation.args, { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`npm audit returned invalid JSON: ${(result.stderr || result.stdout).trim()}`); }
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'security/npm-audit-policy.json')));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  const accepted = validateAudit(report, policy, lock);
  if (result.status !== 0 && result.status !== 1) throw new Error(`npm audit exited unexpectedly with status ${result.status}.`);
  if (accepted.length) console.warn(`Accepted reviewed production advisory exception(s): ${accepted.join(', ')}.`);
  else console.log('No production dependency advisories found.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
