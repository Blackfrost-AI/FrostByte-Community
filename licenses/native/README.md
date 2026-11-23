# Native networking notices and source availability

FrostByte does not modify the following upstream components. The source for the
MPL-covered components below is available under MPL-2.0 at the fixed links.
These components retain their independent license rights even when distributed
inside the proprietary FrostByte beta. License texts are copied unchanged into
this directory.

| Component | Source version | Source location | License |
| --- | --- | --- | --- |
| node-datachannel | 0.32.3 | https://github.com/murat-dogan/node-datachannel/tree/v0.32.3 | MPL-2.0 |
| libdatachannel | v0.24.2 | https://github.com/paullouisageneau/libdatachannel/tree/v0.24.2 | MPL-2.0 |
| libjuice | 5948a4162d37bc213d6051b67ee2876ccc5a99a6 | https://github.com/paullouisageneau/libjuice/tree/5948a4162d37bc213d6051b67ee2876ccc5a99a6 | MPL-2.0 |
| libSRTP | ee1a77c9f9dc02c42bda9901038c500c5efe4cfa | https://github.com/cisco/libsrtp/tree/ee1a77c9f9dc02c42bda9901038c500c5efe4cfa | BSD-3-Clause |
| plog | 94899e0b926ac1b0f4750bfbd495167b4a6ae9ef | https://github.com/SergiusTheBest/plog/tree/94899e0b926ac1b0f4750bfbd495167b4a6ae9ef | MIT |
| usrsctp | fec583d54493f879d2ae44a743423bf8a04371ab | https://github.com/paullouisageneau/usrsctp/tree/fec583d54493f879d2ae44a743423bf8a04371ab | BSD licenses in upstream source |
| nlohmann/json | 55f93686c01528224f448c19128836e7df245f72 | https://github.com/nlohmann/json/tree/55f93686c01528224f448c19128836e7df245f72 | MIT |
| OpenSSL | 3.6.2 in the supplied macOS node-datachannel prebuild | https://github.com/openssl/openssl/tree/openssl-3.6.2 | Apache-2.0 |
| libutp | bundled by utp-native 2.5.3 | https://github.com/mafintosh/utp-native/tree/v2.5.3/deps/libutp | MIT |

The libdatachannel commit references come from its v0.24.2 submodule tree,
selected by node-datachannel 0.32.3's CMakeLists.txt. A recursive checkout of that
tag supplies its referenced dependencies. The npm node-datachannel package also
includes its TypeScript/C++ binding source. Source requests or reports of an
unavailable upstream source link can be sent to support@blackfrostai.com.

Electron's separately supplied Chromium notices identify its additional native
components and license/source notices. Spark's base Node/Debian image retains
its own operating-system package copyright files under /usr/share/doc.
