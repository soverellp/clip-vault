# REQUIREMENTS-HISTORY

> **TL;DR** What the user asked for, in order, paraphrased. All on 2026-11-17 (the exact clock order inside the day is only approximate; see [CHANGELOG.md](CHANGELOG.md) for commit times).

| # | Date | Request (paraphrased) | Led to |
|---|---|---|---|
| 1 | 2026-11-17 | Friends should be able to view and download my clips from a link | clip vault idea |
| 2 | 2026-11-17 | Hosting must be free | HF Space/dataset (D1, D6) |
| 3 | 2026-11-17 | No encrypted clips; a common account for friends | D2 reject, D4 later superseded |
| 4 | 2026-11-17 | Store clips on Hugging Face | D1 |
| 5 | 2026-11-17 | Login with Google; first one allowed email, then admins manage users (saved option since D23) | D5, D7, D11, D12, D27 |
| 6 | 2026-11-17 | Did not want Google Cloud billing worries (then said an OAuth client already exists and preferred Google) | D8 then D11 |
| 7 | 2026-11-17 | Delete clips from the UI, with a confirmation | D13, D14 |
| 8 | 2026-11-17 | Full CRUD on clips; show file details | admin flows, DATA-MODEL |
| 9 | 2026-11-17 | Show times in the viewer's local timezone | D15 |
| 10 | 2026-11-17 | A modern, "crazy" UI | D16 |
| 11 | 2026-11-17 | Everything documented in migration-setup | `migration-setup/CLIP-VAULT.md` |
| 12 | 2026-11-17 | Security is a huge concern | D9, D10, D14, SECURITY |
| 13 | 2026-11-17 | Later, import the code to GitHub | D20 |
| 14 | 2026-11-17 | Use subagents for the work | process note |
| 15 | 2026-11-17 | Keep decisions and flow notes in a dedicated folder | this folder |
| 16 | 2026-11-17 | Keep runtime secrets as Space secrets | D22 |
| 17 | 2026-11-17 | Allow the credential-wrapper route; keep the old HF token for now | D17, D19 |
| 18 | 2026-11-17 | Chose STATIC ONLY, NO SERVER after learning Docker/Gradio Spaces need a paid plan | D23, D25 |
| 19 | 2026-11-17 | Wants a short human password for the gate and accepted the risk | D26 |
| 20 | 2026-11-17 | Keep the server design saved and the Google config kept for later | D27, D28 |
| 21 | 2026-11-17 | Keep all vault documentation updated in the clipper repo | lesson `vault-docs-always-updated` |
| 22 | 2026-11-17 | No Opus agents without approval; security review only when asked | D30 |

Ground rules always in force: no key in chat, files or commits; ADHD-friendly answers (next action first, numbered steps, time estimates).
