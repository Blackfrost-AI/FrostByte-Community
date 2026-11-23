import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedHfRequestReview, catalogImportReview, clipboardWriteReview, deviceAccessRemovalReview, exactReviewText, externalUrlReview, hfCredentialChangeReview, hfDownloadReview, hfTokenValidationReview, localTorrentFileReview, pairedPeerEndpointsReview, pirateFaceBrowseReview, pirateFaceTermsReview, privacyAcceptanceReview, remoteHfCredentialReview, remoteHfDownloadReview, sensitiveSettingsReview, torrentDiscoveryReview } from '../src/main/native-review.js';

test('exact review text preserves leading and trailing spaces in approved values', () => {
  const reviewedPath = ' /Users/person/Models/model.gguf ';
  assert.equal(exactReviewText(reviewedPath, '(none)'), JSON.stringify(reviewedPath));
  assert.equal(exactReviewText('   ', '(none)'), JSON.stringify('(none)'));
});

test('outbound native reviews cancel by default and display exact destinations', () => {
  const url = `https://catalog.example/models.json?state=${'x'.repeat(300)}`;
  const catalog = catalogImportReview(url);
  assert.equal(catalog.defaultId, 0); assert.equal(catalog.cancelId, 0);
  assert.ok(catalog.detail.includes(JSON.stringify(url)));
  assert.match(catalog.detail, /Redirects are rejected.*final HTTPS address.*review/i);

  const device = 'Studio device @ 192.0.2.40';
  const remote = remoteHfCredentialReview({ device, repoId: 'owner/gated-model', action: 'resume' });
  assert.equal(remote.defaultId, 0); assert.equal(remote.cancelId, 0);
  assert.ok(remote.detail.includes(JSON.stringify(device)));
  assert.ok(remote.detail.includes(JSON.stringify('owner/gated-model')));
  assert.match(remote.detail, /grant access to other repositories/);

  const settings = sensitiveSettingsReview({ openAtLogin: true, upnpEnabled: true });
  assert.equal(settings.defaultId, 0); assert.equal(settings.cancelId, 0);
  assert.match(settings.detail, /sign in/); assert.match(settings.detail, /UPnP/);

  const clipboardValue = 'magnet:?xt=urn:btih:' + 'a'.repeat(40);
  const clipboard = clipboardWriteReview(clipboardValue);
  assert.equal(clipboard.defaultId, 0); assert.equal(clipboard.cancelId, 0);
  assert.equal(clipboard.detail, JSON.stringify(clipboardValue));

  const torrent = torrentDiscoveryReview({ infoHash: 'b'.repeat(40), action: 'inspect' });
  assert.equal(torrent.defaultId, 0); assert.equal(torrent.cancelId, 0);
  assert.ok(torrent.detail.includes(JSON.stringify('b'.repeat(40))));
  assert.match(torrent.detail, /public trackers and\/or DHT/);
  assert.match(torrent.detail, /upload received pieces/);

  const peers = ['192.168.50.20:6881', '[fd00::20]:6881'];
  const paired = pairedPeerEndpointsReview({ device, identity: { repoId: 'owner/model', filePath: 'weights/model.gguf', revision: 'c'.repeat(40) },
    planDigest: 'd'.repeat(64), infoHash: 'e'.repeat(40), peers });
  assert.equal(paired.defaultId, 0); assert.equal(paired.cancelId, 0);
  assert.ok(paired.detail.includes(JSON.stringify(peers)));
  assert.ok(paired.detail.includes(JSON.stringify('d'.repeat(64))));
  assert.match(paired.detail, /private network/);

  const removal = deviceAccessRemovalReview({ device: 'Workshop Spark', host: 'spark.local' });
  assert.equal(removal.defaultId, 0); assert.equal(removal.cancelId, 0);
  assert.ok(removal.detail.includes(JSON.stringify('Workshop Spark')));
  assert.ok(removal.detail.includes(JSON.stringify('spark.local')));

  const credential = hfCredentialChangeReview({ action: 'set', currentUser: 'old-user', currentRole: 'read', nextUser: 'new-user', nextRole: 'write' });
  assert.equal(credential.defaultId, 0); assert.equal(credential.cancelId, 0);
  for (const value of ['old-user', 'new-user']) assert.ok(credential.detail.includes(JSON.stringify(value)));

  const fingerprint = 'f'.repeat(64), generation = `sha256:${fingerprint}`;
  const validation = hfTokenValidationReview({ endpoint: 'https://huggingface.co/api/whoami-v2', byteLength: 37, fingerprint });
  assert.equal(validation.defaultId, 0); assert.equal(validation.cancelId, 0);
  assert.match(validation.detail, /37 UTF-8 bytes/);
  assert.ok(validation.detail.includes(JSON.stringify(fingerprint)));
  assert.doesNotMatch(validation.detail, /hf_secret/);

  const authenticated = authenticatedHfRequestReview({ action: 'model', endpoint: 'https://huggingface.co/api/models/owner/model/revision/main?blobs=true',
    repoId: 'owner/model', revision: 'main', user: 'saved-user', tokenGeneration: generation });
  assert.equal(authenticated.defaultId, 0); assert.equal(authenticated.cancelId, 0);
  for (const value of ['owner/model', 'main', generation]) assert.ok(authenticated.detail.includes(JSON.stringify(value)));


  const download = hfDownloadReview({ repoId: 'owner/model', revision: 'a'.repeat(40), root: '/Users/person/Models',
    fileCount: 2, totalBytes: 1234, manifestDigest: 'b'.repeat(64), tokenGeneration: generation, user: 'saved-user' });
  assert.equal(download.defaultId, 0); assert.equal(download.cancelId, 0);
  for (const value of ['owner/model', 'a'.repeat(40), '/Users/person/Models', 'b'.repeat(64), generation]) {
    assert.ok(download.detail.includes(JSON.stringify(value)));
  }
  const remoteDownload = remoteHfDownloadReview({ device: 'Workshop Spark', repoId: 'owner/model',
    revision: 'a'.repeat(40), destination: '/srv/models', fileCount: 2, totalBytes: 1234,
    manifestDigest: 'b'.repeat(64), tokenGeneration: 'none', savedCredentialPresent: true, usesCredential: false });
  assert.equal(remoteDownload.defaultId, 0); assert.equal(remoteDownload.cancelId, 0);
  for (const value of ['Workshop Spark', 'owner/model', 'a'.repeat(40), '/srv/models', 'b'.repeat(64), 'none']) {
    assert.ok(remoteDownload.detail.includes(JSON.stringify(value)));
  }
  assert.match(remoteDownload.detail, /Saved credential present: YES/);
  assert.match(remoteDownload.detail, /Credential sent to device: NO/);
  const remoteResume = remoteHfDownloadReview({ device: 'Workshop Spark', repoId: 'owner/model',
    revision: 'a'.repeat(40), destination: '/srv/models', fileCount: 1, totalBytes: 1234,
    manifestDigest: 'c'.repeat(64), tokenGeneration: generation, savedCredentialPresent: true,
    usesCredential: true, action: 'resume', status: 'paused', downloadedBytes: 321 });
  assert.equal(remoteResume.buttons[1], 'Resume on device');
  assert.equal(remoteResume.message, 'Resume on this device?');
  assert.ok(remoteResume.detail.includes(JSON.stringify('paused')));
  assert.match(remoteResume.detail, /Already downloaded bytes: 321/);

  const outbound = externalUrlReview('https://huggingface.co/owner/model');
  assert.equal(outbound.defaultId, 0); assert.equal(outbound.cancelId, 0);
  assert.ok(outbound.detail.includes(JSON.stringify('https://huggingface.co/owner/model')));

  const consent = privacyAcceptanceReview({ termsVersion: 'terms-v1', privacyVersion: 'privacy-v1' });
  assert.equal(consent.defaultId, 0); assert.equal(consent.cancelId, 0);
  for (const value of ['terms-v1', 'privacy-v1']) assert.ok(consent.detail.includes(JSON.stringify(value)));
  assert.equal(consent.message, 'Accept the FrostByte 1.0 terms and privacy notice?');
  assert.match(consent.detail, /No analytics/);
  assert.match(consent.detail, /GitHub/);
  assert.throws(() => privacyAcceptanceReview({ termsVersion: 'terms-v1', privacyVersion: 'privacy-v1', diagnosticsEnabled: true }), /does not support automatic diagnostics/);
  const localTorrent = localTorrentFileReview('/Users/person/private/catalog.torrent');
  assert.equal(localTorrent.defaultId, 0); assert.equal(localTorrent.cancelId, 0);
  assert.ok(localTorrent.detail.includes(JSON.stringify('/Users/person/private/catalog.torrent')));

  const pfBrowse = pirateFaceBrowseReview({ endpoint: 'https://pirateface.co/s/qwen3', target: 'qwen3' });
  assert.equal(pfBrowse.defaultId, 0); assert.equal(pfBrowse.cancelId, 0);
  assert.ok(pfBrowse.detail.includes('https://pirateface.co/s/qwen3'));
  assert.ok(pfBrowse.summary.includes('qwen3'));

  const pfTerms = pirateFaceTermsReview({
    repoId: 'meta-llama/Llama-3.3-70B-Instruct',
    endpoint: 'https://pirateface.co/api/torrents?repo=meta-llama%2FLlama-3.3-70B-Instruct&accept_terms=llama3.3',
    termsId: 'llama3.3',
    termsName: 'Llama 3.3 Community License',
    termsUrl: 'https://llama.meta.com/llama3_3/license/',
    policyUrl: 'javascript:alert(1)',
  });
  assert.equal(pfTerms.defaultId, 0); assert.equal(pfTerms.cancelId, 0);
  assert.equal(pfTerms.remember, undefined);
  assert.ok(pfTerms.detail.includes('meta-llama/Llama-3.3-70B-Instruct'));
  assert.ok(pfTerms.detail.includes('accept_terms=llama3.3'));
  assert.ok(pfTerms.detail.includes('https://llama.meta.com/llama3_3/license/'));
  assert.ok(!pfTerms.detail.includes('javascript:'));
});
