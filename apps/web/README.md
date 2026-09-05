# OneMotion web

Next.js 16 frontend for recording or uploading a basketball shot and reviewing
the Curry v3 comparison.

## Development

```bash
npm ci
npm run dev
```

The browser API URL defaults to `http://localhost:8000`. Override it with
`NEXT_PUBLIC_API_BASE` at build time. Server-rendered requests use
`ONEMOTION_API_BASE` at runtime.

## Checks

```bash
npm run lint
npm run typecheck
npx playwright install chromium
npm test
npm run build
```

Production deployment uses Next.js standalone output through the repository's
Docker Compose stack. See the root `README.md` for artifact and startup details.

Browser regressions use synthetic fixtures and isolated ports 3109/8129.
