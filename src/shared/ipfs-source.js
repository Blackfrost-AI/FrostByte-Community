import { CID } from 'multiformats/cid';

/** Immutable IPFS paths only. DNSLink/IPNS and arbitrary gateway URLs are not destinations. */
export function parseIpfsSource(input) {
  if (typeof input !== 'string' || input.length > 4096 || /[\x00-\x20\x7f?#\\]/.test(input)) throw new Error('Enter an IPFS CID or ipfs:// link.');
  let value = input.replace(/^ipfs:\/\//i, '').replace(/^\/ipfs\//, '');
  const parts = value.split('/');
  let cid;
  try { cid = CID.parse(parts.shift()); } catch { throw new Error('That IPFS content identifier is invalid.'); }
  if (![0x70, 0x55].includes(cid.code) || cid.multihash.code !== 0x12 || cid.multihash.size !== 32) throw new Error('This release supports SHA-256 UnixFS and raw IPFS content.');
  while (parts.at(-1) === '') parts.pop();
  const names = parts.map(part => {
    let name; try { name = decodeURIComponent(part); } catch { throw new Error('Invalid IPFS path encoding.'); }
    if (!name || ['.', '..'].includes(name) || /[\x00-\x1f\x7f/\\]/.test(name) || name.length > 255) throw new Error('Invalid IPFS file path.');
    return name;
  });
  const root = cid.toV1().toString();
  return { cid: root, path: names.join('/'), source: `ipfs://${root}${names.length ? '/' + names.map(encodeURIComponent).join('/') : ''}`, argument: `/ipfs/${root}${names.length ? '/' + names.join('/') : ''}` };
}

export function looksLikeIpfsSource(input) {
  return typeof input === 'string' && /^(?:ipfs:\/\/|\/ipfs\/|Qm[1-9A-HJ-NP-Za-km-z]{44}(?:\/|$)|bafy[a-z2-7]+(?:\/|$)|bafk[a-z2-7]+(?:\/|$))/i.test(input.trim());
}
