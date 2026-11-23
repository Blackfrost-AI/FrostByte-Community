# Device product photos

The PNG/JPEG files are manufacturer stock product images used to identify
hardware in FrostByte's private beta. Apple, ASUS, Dell, and NVIDIA/PNY retain
their respective copyrights. These images are not original FrostByte artwork
or an endorsement by their owners.

`sources.json` records each source page, original image URL, credit, retrieval
date, dimensions and SHA-256. The image bytes are unchanged. The renderer fits
transparent margins through a CSS view box on a white panel. Apple pictures
represent enclosure families; Windows laptop/desktop pictures are representative
Dell products, not a claim that every connected Windows computer is a Dell.

`src/shared/device-photos.js` is the bundled display catalog. Asset checks verify
the source hashes and packaged copies. No network lookup occurs when a card is
shown. SVG files are earlier original FrostByte placeholders, retained for
unknown hardware and compatible saved choices.
