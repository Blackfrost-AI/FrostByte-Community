#!/usr/bin/env python3
"""Collect notices from checksum-matched Go modules; never execute their code.

Usage: python3 scripts/collect-ipfs-notices.py <verified-kubo-binary> [...]
Go reads build metadata only. Archives are checked against the h1 checksums
embedded in the reviewed binary, streamed to temporary storage, then removed.
"""
import base64
import concurrent.futures
import hashlib
import json
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'licenses/ipfs/modules'
NOTICE = re.compile(r'^(licen[sc]e|copying|notice|copyright)([._-]|$)', re.I)


def escaped(value):
    return ''.join('!' + c.lower() if c.isupper() else c for c in value)


def collect(module):
    name, version, expected = module
    url = 'https://proxy.golang.org/' + escaped(name) + '/@v/' + escaped(version) + '.zip'
    with tempfile.TemporaryFile() as archive:
        with urllib.request.urlopen(url, timeout=60) as response:
            size = 0
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > 128 * 1024 * 1024:
                    raise ValueError('Module archive exceeds limit: ' + name)
                archive.write(chunk)
        archive.seek(0)
        with zipfile.ZipFile(archive) as files:
            entries = sorted(files.namelist())
            if len(set(entries)) != len(entries) or sum(f.file_size for f in files.infolist()) > 512 * 1024 * 1024:
                raise ValueError('Invalid module archive: ' + name)
            # Go's Hash1: SHA-256 of the sorted "file-hash  filename\n" list.
            sums = hashlib.sha256()
            prefix = name + '@' + version + '/'
            notices = []
            for entry in entries:
                if not entry.startswith(prefix) or '\n' in entry:
                    raise ValueError('Invalid module filename: ' + name)
                relative = pathlib.PurePosixPath(entry[len(prefix):])
                if '..' in relative.parts or relative.is_absolute():
                    raise ValueError('Invalid module path: ' + name)
                digest = hashlib.sha256()
                with files.open(entry) as source:
                    while chunk := source.read(1024 * 1024):
                        digest.update(chunk)
                sums.update((digest.hexdigest() + '  ' + entry + '\n').encode())
                if NOTICE.match(relative.name) and not {'test', 'tests', 'testdata', '.git'} & set(relative.parts):
                    if files.getinfo(entry).file_size > 2 * 1024 * 1024:
                        raise ValueError('Notice exceeds limit: ' + entry)
                    notices.append((relative, files.read(entry)))
            actual = 'h1:' + base64.b64encode(sums.digest()).decode()
            if actual != expected:
                raise ValueError('Go module checksum mismatch: ' + name)
            if not notices:
                headers = []
                for entry in entries:
                    if not entry.endswith('.go') or entry.endswith('_test.go'):
                        continue
                    lines = files.read(entry).decode('utf-8').splitlines()
                    comment = []
                    for line in lines:
                        if not line.startswith('//'):
                            break
                        comment.append(line)
                    text = '\n'.join(comment)
                    if 'copyright' in text.lower() and 'license' in text.lower():
                        headers.append(entry + '\n\n' + text)
                if headers:
                    notices.append((pathlib.PurePosixPath('COPYRIGHT-source-headers.txt'), ('\n\n'.join(headers) + '\n').encode()))
            folder = name.replace('/', '__') + '@' + version
            for relative, data in notices:
                target = OUTPUT / folder / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            return {'module': name, 'version': version, 'sum': expected, 'source': url,
                    'notices': [str(pathlib.PurePosixPath('modules') / folder / item[0]) for item in notices]}


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    modules, binaries = {}, []
    for binary in sys.argv[1:]:
        file = pathlib.Path(binary).resolve()
        receipt = json.loads((file.parent / 'runtime.json').read_text())
        digest = hashlib.sha256(file.read_bytes()).hexdigest()
        if digest != receipt['binarySha256'] or receipt['version'] != '0.43.0':
            raise ValueError('Build a pinned, verified Kubo runtime first.')
        metadata = subprocess.check_output(['go', 'version', '-m', str(file)], text=True)
        if '\tmod\tgithub.com/ipfs/kubo\tv0.43.0\t' not in metadata or '\t=>\t' in metadata:
            raise ValueError('Unexpected Kubo module identity or replacements.')
        for line in metadata.splitlines():
            parts = line.split()
            if parts and parts[0] in ('mod', 'dep'):
                if len(parts) != 4 or not parts[3].startswith('h1:'):
                    raise ValueError('Missing embedded module checksum.')
                key = (parts[1], parts[2])
                if key in modules and modules[key] != parts[3]:
                    raise ValueError('Inconsistent module checksums.')
                modules[key] = parts[3]
        binaries.append({'platform': file.parent.name, 'binarySha256': digest})
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
        rows = list(workers.map(collect, [(name, version, checksum) for (name, version), checksum in sorted(modules.items())]))
    missing = [row['module'] for row in rows if not row['notices']]
    (ROOT / 'licenses/ipfs/go-inventory.json').write_text(json.dumps({'kuboVersion': '0.43.0', 'binaries': binaries, 'modules': rows}, indent=2) + '\n')
    print('Collected verified notice files for', len(rows), 'Go modules.')
    if missing:
        raise SystemExit('Upstream notice review required: ' + ', '.join(missing))


if __name__ == '__main__':
    main()
