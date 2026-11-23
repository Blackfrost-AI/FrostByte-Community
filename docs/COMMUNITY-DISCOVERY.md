# Community model discovery

The proposed service is **Frost-Net**. See the [Frost-Net plan](FROST-NET-PLAN.md)
for the website/API scope, hosting assessment, publication flow, and test milestones.

Current scope: build a reliable community of people hosting and sharing model
files. FrostByte opens torrents and magnets, searches HuggingFace in its own tab,
and searches recorded downloads locally in Transfers. There is no public torrent
search service in this release.

The next phase is a searchable website directory for legally redistributed open
models. Treat publishing a listing as a separate, explicit action from turning
Sharing on. A local inventory or private device connection should never silently
become public.

Proposed listing data: model name, upstream repository and pinned revision,
format/quantization, selected files and sizes, content hashes, magnet link,
redistribution license and required attribution. Verification should connect a
listing to the upstream release and its allowed redistribution terms. Gated or
private repositories should not be auto-published.

Begin with reviewed community submissions and clear source/provenance pages.
Keep search filters focused on model/task, size, format and license. Availability
signals should distinguish a recent observation from a guarantee that a peer is
online. Include reporting, correction and removal tools before opening submissions.

This document records the product direction. Frost-Net's index, explicit
publication queue, and community search API remain planned; they are not enabled
by this documentation update.
