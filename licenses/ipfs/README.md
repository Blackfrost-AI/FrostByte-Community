# Kubo runtime notices

FrostByte bundles the official Kubo 0.43.0 release binary. Archive digests are
pinned in `build/ipfs-runtime.json`. macOS packaging adds a code signature to
the helper without changing its source code.

Kubo's original `LICENSE`, `LICENSE-MIT`, and `LICENSE-APACHE` are retained.
Read the original transition notice: older contributions retain their MIT
terms. The FrostByte private-beta license does not replace these terms.

`go-inventory.json` records the Go modules embedded in the reviewed macOS
ARM64/x64, Linux ARM64/x64 and Windows x64 binaries. `modules/` contains their
original notices. The collector verifies module archives against the Go `h1`
checksums embedded in those binaries before copying notices. It does not run
the modules or retain downloaded source archives.

The Go runtime's BSD license is retained as `GO-LICENSE`, from
https://github.com/golang/go/blob/go1.26.5/LICENSE.

`github.com/alexbrainman/goissue34681` at
`v0.0.0-20191006012335-3fc7a47baff5` omits the standalone LICENSE referenced by
its source. Its original Go Authors copyright and BSD-style license headers
are preserved in `COPYRIGHT-source-headers.txt`; the Go license is also
included above. This records the omission without inventing a different
license declaration or copyright holder.

To refresh after a deliberate Kubo update, stage all five reviewed binaries
and run `scripts/collect-ipfs-notices.py` with their paths. Review missing
notices before packaging, then run `npm run build:licenses`. The complete
notices are included in the desktop and companion distributions.

Sources:

- https://github.com/ipfs/kubo/tree/v0.43.0
- https://go.dev/ref/mod#authenticating
- https://github.com/alexbrainman/goissue34681/tree/3fc7a47baff5
