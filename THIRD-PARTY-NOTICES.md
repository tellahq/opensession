# Third-party notices

Open Session distributions include third-party software. The generated
`THIRD-PARTY-PACKAGES.txt` and `SBOM.spdx.json` in each release archive list
the Bun packages resolved for that release. License texts for components with
redistribution obligations are in `THIRD-PARTY-LICENSES/`.

## sharp and libvips

Open Session binary releases include sharp and a prebuilt libvips sidecar.

- sharp is Copyright Lovell Fuller and contributors, licensed under the Apache
  License 2.0. See `THIRD-PARTY-LICENSES/Apache-2.0.txt`.
- The `@img/sharp-libvips-*` packages, including libvips and their bundled
  libraries, declare LGPL-3.0-or-later. See
  `THIRD-PARTY-LICENSES/LGPL-3.0.txt`. Corresponding source and build scripts
  are available from <https://github.com/lovell/sharp-libvips> at the version
  recorded in `SBOM.spdx.json`.

## Inter

The Open Session website uses Inter. Copyright 2016 The Inter Project Authors.
Inter is licensed under the SIL Open Font License 1.1. See
`THIRD-PARTY-LICENSES/OFL-1.1.txt`.

## BusyBox

Open Session's Firecracker root filesystem builder downloads BusyBox 1.35.0
from busybox.net as a pinned, checksum-verified static binary. BusyBox is
Copyright its contributors and licensed under GPL-2.0-only. See
`THIRD-PARTY-LICENSES/GPL-2.0.txt`.

The builder also downloads, verifies, and places the complete corresponding
`busybox-1.35.0.tar.bz2` source archive in the generated image at
`/usr/share/opensession/source/`. This source archive is the upstream source
for the unmodified BusyBox binary installed at `/opt/bks/busybox`.

## noVNC

The web frontend draws Mac VM desktops with the noVNC core library.
Copyright (C) 2022 The noVNC authors. noVNC's core library is licensed under
the Mozilla Public License 2.0, used unmodified from the npm package. See
`THIRD-PARTY-LICENSES/MPL-2.0.txt`.
