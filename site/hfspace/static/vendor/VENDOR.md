# Vendored third-party files (no CDN at runtime)

| Name | Version | License | File | sha256 |
|---|---|---|---|---|
| three.js (three.module.min.js, standalone build) | 0.160.0 (r160) | MIT | vendor/three.module.min.js | 3e690ac7d180b0aadf0891bea39eec643e29e2d3e75c99b18689518665f69ba6 |

Source: https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js (npm package `three`, fetched with curl, header checked: "@license Copyright 2010-2023 Three.js Authors, SPDX-License-Identifier: MIT").

Fonts (self-hosted woff2, fetched from Google Fonts with curl, files in /fonts, @font-face in css/fonts.css), all SIL Open Font License 1.1:

| Family | Subset | Version path | File | sha256 |
|---|---|---|---|---|
| Inter (variable 400-800) | latin | gstatic inter/v20 | fonts/inter-latin.woff2 | 3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62 |
| Inter (variable 400-800) | latin-ext | gstatic inter/v20 | fonts/inter-latin-ext.woff2 | 34b9c504cab7a73e37b746343a449132e56cf7b5481af2cb81dc74dcff25c956 |
| Space Grotesk (variable 500-700) | latin | gstatic | fonts/space-grotesk-latin.woff2 | 0640890476fc1198ab4de571fb658de443c4d85b66466ec09534a8737ab1ce9d |
| Noto Sans Devanagari (variable 400-700) | devanagari | gstatic | fonts/noto-sans-devanagari-devanagari.woff2 | 6c354352c14e6c5507f8c0fc8985134407d09f12c1577f5706ca58e62fb4cd2f |

To verify: `sha256sum static/vendor/three.module.min.js static/fonts/*.woff2`.
