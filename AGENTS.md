# AGENTS.md

This repository contains the RRCC / AESA certificate and renewal workflow: a Vite front end plus serverless API endpoints that connect to Google Sheets/Drive and the public certificate sources.

## Quick commands

- Install dependencies: `npm install`
- Run business-rule tests: `npm test`
- Local app + API: `npm run build && node dev-server.js`
- Hot-reload front-end: `npm run dev`

See [README.md](README.md) and [package.json](package.json) for the authoritative setup and environment details.

## Architecture at a glance

- [src/](src/): browser UI, DOM wiring, and front-end logic.
- [api/](api/): Vercel serverless endpoints and Google/Drive integration.
- [shared/](shared/): pure business rules reused by both browser and Node; keep logic here when it must run in both contexts.
- [tests/](tests/): Node test suite for the underlying business logic.
- [apps-script/Code.gs](apps-script/Code.gs): alternate backend that can be used instead of the Google service account flow.
- [scripts/](scripts/): maintenance scripts, including Excel migration helpers.
- [escritorio/](escritorio/): older Python desktop scripts.

## Repo-specific conventions

- Do not change the `BD AESA` sheet layout or rewrite the header order. The app assumes the header is in row 3 and data begins in row 4; several references are positional.
- Keep compatible with the current Drive folder structure (`RRCC`, `DATA`, `FOTOS`) and current sheet names. The app also appends a few metadata columns at the end of the sheet; do not move or rename the original columns.
- Prefer extending the existing modules in [src/lib/](src/lib/) and [api/_lib/](api/_lib/) instead of creating ad hoc one-off integrations.
- Maintain parity between browser and Node logic when code belongs in [shared/](shared/). This project intentionally keeps a shared rules layer to avoid divergence.
- Handle the Google configuration as optional. The app is expected to keep working for certificate extraction even when the full Google/Drive setup is missing.

## High-signal files

- [README.md](README.md): full product overview, environment variables, and setup instructions.
- [shared/rrcc.js](shared/rrcc.js): RRCC catalog and core business logic.
- [shared/estados.js](shared/estados.js): date and authorization-state logic.
- [src/main.js](src/main.js): entry point and main front-end orchestration.
- [src/lib/renovacion.js](src/lib/renovacion.js): renewal workflow.
- [api/sheets.js](api/sheets.js): main Google Sheets API bridge.

## Validation

- Prefer running `npm test` after logic changes affecting business rules.
- For local app verification, use `npm run build && node dev-server.js` before reporting a UI or API change as complete.
- If a change affects the spreadsheet contract or Drive behavior, double-check the assumptions documented in [README.md](README.md) because they are intentionally strict.
