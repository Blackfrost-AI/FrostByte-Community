# LimeWire Research Dossier

*Why we are studying it, what made it iconic, and what we deliberately keep vs. throw away.*

---

## 1. The Short History

| When | What happened |
|---|---|
| May 29, 2000 | LimeWire 1.0 released. Written in **Java**, GPL-licensed. Started as a "post-Napster clone," became *the* Gnutella client. |
| Feb 2002 | v2.2.0 beta — toggleable columns, hover metadata, native macOS menu bar, a splash screen deliberately aimed at a younger audience. |
| 2002–2009 | **v4.x — the "classic" era.** The interface almost everyone remembers. Connection quality meter, file-type button matrix, search progress bar, skins, tabbed searches, Direct Connect, freeloader cut-off, adult content filter, "What's New." |
| 2009 | **v5** — the Web 2.0 redesign. Two search bars, two sidebars, rounded square buttons. Kept a toggle back to the "Classic" spreadsheet view because users revolted. |
| Sep 30, 2010 | Final stable release, v5.5.16. |
| Oct 26, 2010 | Judge Kimba Wood issues a **permanent injunction** — disable searching, downloading, uploading, file trading, distribution. |
| May 2011 | **$105M settlement** to 13 record companies. |

At peak: **50M+ monthly users**, and 58% of all P2P music downloads in 2009 (NPD Group).

**The case:** *Arista Records LLC et al v. Lime Group et al*, SDNY No. 06-05936, filed 2006. In May 2010 Judge Wood held LimeWire, Lime Group, and founder **Mark Gorton** liable for copyright infringement, unfair competition, and **inducement**. The injunction followed *MGM v. Grokster* (2005), which held that distributing a tool designed to be used for infringement creates liability.

**The fork lineage — directly relevant to our name:**
- **FrostWire** (Sept 2004) forked LimeWire after LimeWire's distributor floated adding "blocking" code under RIAA pressure. Initially Gnutella, **dropped Gnutella entirely in v5.0 (2011)** and became BitTorrent-only, eventually on **libtorrent** via the jLibtorrent Java wrapper. Still alive today (Java, GPL-3.0, Windows/macOS/Linux/Android).
- **WireShare** forked the old FrostWire/LimeWire source in 2010 to keep Gnutella alive.
- **LimeWire Pirate Edition 5.6.2** kept both "Classic view" and a browser-like "List view."

> ⚠️ **Trademark flag:** *FrostWire* is an active, maintained, GPL-licensed project whose name is one word away from ours. Before launch we need a real trademark search on **"Frost/Byte"** and **"Frostbyte"** in classes 9 (software) and 42 (SaaS), and a decision on whether the homage is healthy lineage or a likelihood-of-confusion problem. See `07-legal-security-governance.md`.

---

## 2. Anatomy of the Classic UI (v4.x)

This is the part we are actually rebuilding. Decomposed into its load-bearing pieces:

### 2.1 Primary layout
```
┌──────────────────────────────────────────────────────────────┐
│  Menu bar: File  View  Tools  Help                           │
├──────────────────────────────────────────────────────────────┤
│  ┌─ Tabs ────────────────────────────────────────────────┐   │
│  │ [Search] [Downloads] [Library] [Uploads] [+]          │   │
│  ├───────────────────────────────────────────────────────┤   │
│  │  Keyword:  [____________________]  (search bar)        │   │
│  │  Type button matrix: [Audio][Video][Image][Doc][Prog]  │   │
│  │  ━━━━━━━━━━ search progress bar ━━━━━━━━━━             │   │
│  ├───────────────────────────────────────────────────────┤   │
│  │  RESULTS GRID  (the iconic spreadsheet)                │   │
│  │  Name │ Size │ Type │ Artist │ Album │ Quality │ Hosts │
│  │  ─────┼──────┼──────┼────────┼───────┼─────────┼────── │
│  │  sortable columns, one row per remote file             │   │
│  │  quality cell tinted green→yellow→red                  │   │
│  ├───────────────────────────────────────────────────────┤   │
│  │  status line: "42 results in 1.8s · 0.4 KB/s down"     │   │
│  └───────────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────────┤
│  Connection quality meter ▓▓▓▓▓░░░  Ultrapeer: yes           │
└──────────────────────────────────────────────────────────────┘
```

### 2.2 The elements that carried the product
1. **The results grid.** A dense, sortable, spreadsheet-style table. One row per remote file. This is *the* LimeWire memory — the feeling of watching hundreds of rows pour in and sorting by "Quality" to find the good host.
2. **The quality/connection meter.** A five-bar signal indicator per result *and* one for your own connection. Made an abstract network state legible as a physical object.
3. **The file-type button matrix.** A grid of large icon buttons to zero in on one media type. Faster than a dropdown, more fun than a filter.
4. **Tabbed searches.** Run several searches at once and keep them open. Users ran many in parallel and tabbed between them.
5. **Transfers pane.** Per-file rows: progress bar, rate, ETA, sources count, and the peer list.
6. **Skins.** Only recolored things (blue → orange → black) and users *still* loved them, which tells us the demand was for personalization of the dark/metallic chrome, not for radical layout change. Notably users complained the skins *didn't* go far enough.
7. **"What's New."** A live feed of what's newly available on the network. A discovery surface with no search box — pure browse.
8. **Direct Connect.** Enter an IP and connect to a specific host. Our analogue: connect to a specific peer/seedbox by ID.
9. **The freeloader cut-off.** A fairness control in the UI itself — cut off users who don't share. This is a first-class product primitive we inherit, not an afterthought.

### 2.3 Visual identity
| Token | Value | Notes |
|---|---|---|
| Primary | `#22D511` "Malachite" | The lime. Still their brand green today. |
| Secondary | `#00934B` "Green Haze" | Deeper green for depth/pressed states |
| Contrast | `#FFFFFF` | |
| Source | [Brandfetch — limewire.com](https://brandfetch.com/limewire.com) | Marked "unclaimed," verify before use |

The classic-era chrome was a **dark metallic/steel frame** wrapped around the bright green accent — plus platform-native widgets because it was Java Swing with a custom look-and-feel. Screenshots from the era were criticized for rendering inconsistently across platforms: orange XP-style tabs vs. squared Java buttons, non-native fonts (Tahoma/Trebuchet), and lighter dialog backgrounds than shipped. **Lesson: pick one canvas and render it identically everywhere.**

---

## 3. What We Keep, What We Burn

### Keep — the soul
| LimeWire primitive | Frost/Byte translation |
|---|---|
| Spreadsheet results grid | **Swarm map** — **one row per model on a remote rig**. Structurally identical to LimeWire's one-row-per-remote-file: Params, Quant, Size, Rig, HW, Link, tok/s, Trust, Access |
| Connection quality bars | **Link indicator** — LAN vs. RTT, plus measured tok/s on that hardware |
| Hosts column | **Rig + hardware + engine + uptime** — knowing *whose* machine it is matters more now, not less |
| File-type button matrix | **Model-type matrix** + `On LAN only` and `Runs on my rig` filters |
| Tabbed searches | **Tabbed swarm views** — multiple live views in parallel |
| Transfers pane | Same, but **per-source with link speed** — watching a LAN peer outrun a WAN peer 20:1 |
| Freeloader cut-off | **Access policy** — who can pull, who can infer. Off by default |
| What's New | **Fresh on the Wire** — models loaded right now |
| Direct Connect | **Direct peer connect** — by peer ID. Huge for rig owners: connect straight to a Spark over 200 Gbps |
| Status bar | Live swarm stats — link speed, peers, port, serving count, ratio |

### Burn — the sins
1. **Java Swing chrome.** Inconsistent across platforms, heavier than needed, and a notorious source of the "Java app" aesthetic people mocked. We use an **Electron shell** (bundled Chromium) so it renders identically on macOS, Windows, and Linux.
2. **Bundled adware.** FrostWire shipped an Ask.com toolbar and later a WebDiscover browser hijacker. **Absolutely never.** No ads, no toolbars, no "recommended" nonsense, no telemetry-by-default. This is a stated pillar, not a preference.
3. **Ambiguity about what the network is for.** LimeWire could not say "we are for legal content" without lying. In Frost/Byte **every offer carries a license tag**, sharing is **opt-in and default-closed**, and restricted licenses are not publicly discoverable at all.
4. **Central points of failure.** LimeWire lost at the injunction stage. We decentralize discovery so nothing can be switched off in one order.
5. **No provenance layer.** LimeWire could not tell you whether a file was what it claimed. We ship cryptographic model signing from day one.

---

## 4. The Honest Lesson From the Shutdown

LimeWire did not die because P2P is illegal. It died under the *inducement* doctrine: a business model that depended on infringement, marketing aimed at infringers, and no mechanism to distinguish legitimate from illegitimate use.

**Our legal posture is therefore designed in, not bolted on.** As of the *Cox Communications v. Sony Music* decision, U.S. contributory liability was narrowed to two categories — **affirmative inducement** and **service tailoring** (`07-legal-security-governance.md` covers this in depth). Both are avoidable by design:

- We never market Frost/Byte as a way to get around licensing. We market it as the way to keep open models alive.
- Every offer carries **license metadata as a required field**, and models whose license restricts redistribution are **never publicly discoverable** — they can only be shared inside private groups.
- We ship a real DMCA process, a repeat-infringer policy, and a takedown path on day one, not after a lawsuit.

A product that is *capable* of substantial non-infringing use and is *not tuned toward* infringement sits in the *Sony* safe zone. That is where we intend to live.

---

## Sources

- [CNET/Download.com review of LimeWire 4.18 (archived 2008)](https://web.archive.org/web/20081004183101/http://www.download.com/LimeWire/3000-2166_4-10051892.html)
- [Gnutella Forums — user comparison of LimeWire screenshots vs. shipped UI (2004)](https://www.gnutellaforums.com/109715-post3.html)
- [Brandfetch — LimeWire brand colors](https://brandfetch.com/limewire.com)
- Gnutella Forums release notes for LimeWire 2.2.0 beta (Feb 2002)
- Spanish Wikipedia, *LimeWire* (history, licensing, shutdown)
- *Arista Records LLC v. Lime Group LLC*, SDNY 06-05936; May 2010 liability ruling; Oct 26, 2010 permanent injunction
- *MGM Studios, Inc. v. Grokster, Ltd.*, 545 U.S. 913 (2005)
- *Cox Communications, Inc. v. Sony Music Entertainment* (contributory liability narrowed to inducement/tailoring)
