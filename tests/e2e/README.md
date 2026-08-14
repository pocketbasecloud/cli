# CLI End-to-End Smoke Tests

Live smoke tests that run `deno run -A main.ts` against the real PocketBase Cloud
platform. These catch what unit tests can't: silently-required fields, discarded
error messages, and stuck provisioning.

## Prerequisites

1. A PocketBase Cloud account with a valid auth token
2. Deno installed

## Quick Start

```bash
# Get a token: either login in a browser, or copy one from the portal
export PB_TOKEN="<your-token>"

# Run all smoke tests (against PROD)
deno task test:e2e

# Run against QA — these override the CLI's hardcoded production hosts
export PB_BACKEND_URL="https://qa-backend.pocketbasecloud.com"
export PB_EXT_URL="https://qa-ext.pocketbasecloud.com"
export PB_PORTAL_URL="https://qa-portal.pocketbasecloud.com/login"
deno task test:e2e

# Run a single file
deno test -A tests/e2e/smoke/auth.test.ts
```

## Test Structure

- `smoke/auth.test.ts` — login state, token validation, error messages
- `smoke/deploy-pb.test.ts` — PocketBase deploy (create, redeploy, edge cases)
- `smoke/deploy-fe.test.ts` — Frontend deploy (static site, auto-detect, edge cases)
- `smoke/deploy-be.test.ts` — Backend deploy (Pro only: deploy, validation errors)

## Plan Requirements

| Test suite | Minimum plan |
|-----------|-------------|
| auth | Any (free/starter/pro) |
| deploy-pb | Free (1 PocketBase slot) |
| deploy-fe | Free (5 frontend slots) |
| deploy-be | Pro |

Tests check the plan at startup and skip themselves when the plan doesn't
support the operation.

## Cleanup

Every test cleans up resources it creates. If a run crashes, resources may
leak. Run `pb cloud <kind> ls --json` to check and delete manually.
