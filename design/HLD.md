# HLD — High-Level Design: Node.js Version Upgrade (14 → 22 LTS)

## 1. Overview

This enhancement upgrades the legacy shop app from Node.js 14 (EOL since April 2023) to Node.js 22 LTS (supported through April 2027). The upgrade includes migrating the AWS SDK from the deprecated v2 monolith to the modular v3 SDK, patching all outdated dependencies with known CVEs, and removing the redundant `body-parser` package in favor of Express built-ins. The application's behavior, intentional workshop vulnerabilities, and infrastructure remain entirely unchanged — this is a runtime and dependency modernization only.

---

## 2. Goals & Non-Goals

**Goals**
- Upgrade Node.js runtime: `14` → `22 LTS`
- Migrate `aws-sdk` v2 → `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` v3
- Upgrade `jsonwebtoken` 8.5.1 → 9.x (resolves CVE-2022-23529, CVE-2022-23540, CVE-2022-23541)
- Upgrade `uuid` 3.4.0 → 9.x and fix deprecated deep-path import syntax
- Remove `body-parser`; replace with `express.json()` / `express.urlencoded()` built-ins
- Patch `express`, `ejs`, `morgan`, `cookie-parser`, `dotenv` to latest stable versions

**Non-Goals**
- Fixing intentional workshop security vulnerabilities (plain-text passwords, IDOR, XSS, JWT alg confusion, etc.)
- Migrating from CommonJS (`require`) to ESM (`import`)
- Upgrading Express 4 → Express 5
- Adding new application features, endpoints, or routes
- Changing Docker infrastructure or DynamoDB configuration
- Adding tests

---

## 3. Architecture Overview

The upgrade is contained entirely within the Node.js application layer. No infrastructure changes.

```
┌─────────────────────────────────────────────────────────────┐
│                     APPLICATION LAYER                        │
│                                                              │
│  Node.js 14 (EOL)           →      Node.js 22 LTS           │
│                                                              │
│  aws-sdk v2 (monolith)      →      @aws-sdk/client-dynamodb │
│                                    @aws-sdk/lib-dynamodb     │
│                                                              │
│  uuid 3.x (deep imports)    →      uuid 9.x (named exports) │
│  jsonwebtoken 8.x (CVEs)    →      jsonwebtoken 9.x         │
│  body-parser (redundant)    →      express built-ins        │
│                                                              │
└───────────────────────────┬─────────────────────────────────┘
                            │ (unchanged)
┌───────────────────────────▼─────────────────────────────────┐
│              INFRASTRUCTURE (no changes)                     │
│   DynamoDB Local :8010    │    DynamoDB Admin UI :8011       │
└─────────────────────────────────────────────────────────────┘
```

**Files changed vs. unchanged:**

| Category | Files | Changed? |
|---|---|---|
| Runtime config | `.nvmrc`, `package.json` | Yes |
| DB client setup | `config/db.js` | Yes — full rewrite |
| Data models | `models/user.js`, `models/order.js` | Yes — SDK + uuid |
| Scripts | `scripts/init-tables.js`, `scripts/seed.js`, `scripts/view-data.js` | Yes — SDK calls |
| App bootstrap | `app.js` | Yes — remove body-parser |
| Server, routes, controllers, middleware, views | All others | No change |

---

## 4. Key Design Decisions

**Node 22 over Node 20**
Node 20 enters maintenance mode October 2025 and EOLs April 2026. Node 22 provides a longer runway for the same one-time upgrade effort.

**Preserve exported names in `config/db.js`**
`dynamodb` and `docClient` are consumed by five downstream files. By keeping the same export names while switching to v3 internals, zero import lines in models or scripts need updating.

**aws-sdk v3 native migration over compatibility shim**
AWS offers a v2-compatibility shim, but it is itself being deprecated. Adopting the v3 `send(new XxxCommand(...))` pattern directly is the correct path and eliminates future migration debt.

**uuid v9 over v4–v6**
uuid v4–v6 retained the deprecated deep-path exports for backward compatibility. v7+ removed them. Targeting v9 now adopts the correct named-export syntax and is immune to the breaking change that has already occurred in v7+.

---

## 5. Dependencies & Integrations

| Dependency | Type | Impact |
|---|---|---|
| `amazon/dynamodb-local` Docker image | Infrastructure | None — v3 SDK uses same endpoint config |
| `aaronshaf/dynamodb-admin` Docker image | Infrastructure | None |
| nvm | Build tooling | `.nvmrc` updated to `22` |
| npm | Build tooling | Regenerate `package-lock.json` on Node 22 |

---

## 6. Non-Functional Requirements

- **Security**: Zero high/critical CVEs from updated packages post-upgrade (`npm audit`)
- **Compatibility**: All existing endpoints and web routes behave identically
- **Intentional vulnerabilities**: Must remain intact and exploitable for workshop use
- **Startup**: App must start cleanly with no deprecation warnings from app code
- **Bundle size**: aws-sdk v3 modular packages reduce install footprint vs. v2 monolith
