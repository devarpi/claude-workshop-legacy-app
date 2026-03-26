# Implementation Plan: Node.js Version Upgrade (14 → 22 LTS)

## 1. Phases & Milestones

- **Phase 1 – Environment**: Switch runtime, update package.json, regenerate dependencies
- **Phase 2 – SDK Migration**: Rewrite config/db.js, update all SDK call sites
- **Phase 3 – Cleanup**: Fix uuid imports, remove body-parser
- **Phase 4 – Verification**: Smoke test all scripts, endpoints, and audit

---

## 2. Task Breakdown

```
Phase 1 – Environment
- [ ] Update .nvmrc from 14 to 22
- [ ] Update package.json engines field to ">=22.0.0"
- [ ] Update all dependency versions in package.json (see table below)
- [ ] Remove body-parser from package.json dependencies
- [ ] Delete package-lock.json and node_modules/
- [ ] Run npm install on Node 22 to regenerate lock file

Phase 2 – SDK Migration
- [ ] Rewrite config/db.js — DynamoDBClient + DynamoDBDocumentClient.from()
- [ ] Update models/user.js — add PutCommand/QueryCommand/GetCommand, replace .promise() (3 sites)
- [ ] Update models/order.js — add PutCommand/QueryCommand, replace .promise() (2 sites)
- [ ] Update scripts/init-tables.js — CreateTableCommand + err.name fix
- [ ] Update scripts/seed.js — add PutCommand/ScanCommand, replace .promise() calls
- [ ] Update scripts/view-data.js — add ScanCommand, replace .promise() call

Phase 3 – Cleanup
- [ ] Fix uuid import in models/user.js: require('uuid/v4') → { v4: uuidv4 } = require('uuid')
- [ ] Fix uuid import in models/order.js
- [ ] Fix uuid import in scripts/seed.js
- [ ] Update app.js — remove body-parser require, use express.json() / express.urlencoded()

Phase 4 – Verification
- [ ] Run node scripts/init-tables.js (first run — "created")
- [ ] Run node scripts/init-tables.js (second run — "already exists", confirms err.name fix)
- [ ] Run node scripts/seed.js — verify summary printed without errors
- [ ] Run node scripts/view-data.js — verify users and orders displayed
- [ ] Run node server.js — verify no errors, no deprecation warnings
- [ ] Curl: POST /api/v1/auth/register
- [ ] Curl: POST /api/v1/auth/login — verify JWT + plain-text password in response
- [ ] Curl: POST /api/v1/orders — verify order placed
- [ ] Curl: GET /api/v1/orders/:userId — verify IDOR still works
- [ ] Browser: login → orders flow
- [ ] Run npm audit — verify zero high/critical CVEs on upgraded packages
- [ ] Update README.md to reference Node 22
```

**Dependency version targets:**

| Package | From | To |
|---|---|---|
| `aws-sdk` | 2.814.0 | REMOVE |
| `@aws-sdk/client-dynamodb` | — | `^3.0.0` |
| `@aws-sdk/lib-dynamodb` | — | `^3.0.0` |
| `uuid` | 3.4.0 | `^9.0.0` |
| `jsonwebtoken` | 8.5.1 | `^9.0.0` |
| `express` | 4.17.1 | `^4.21.0` |
| `dotenv` | 8.2.0 | `^16.0.0` |
| `body-parser` | 1.19.0 | REMOVE |
| `morgan` | 1.9.1 | `^1.10.0` |
| `cookie-parser` | 1.4.5 | `^1.4.7` |
| `ejs` | 3.1.6 | `^3.1.10` |

---

## 3. Dependencies & Sequencing

```
Phase 1 → must complete before Phase 2
  npm install must run on Node 22 before any code is executed

config/db.js → must be updated before models or scripts are tested
  all downstream files import { dynamodb, docClient } from config/db.js

uuid imports (Phase 3) → can be done in parallel with Phase 2
  independent changes in the same files

Phase 4 → blocked by all of Phases 1–3
```

No external blockers — all packages are publicly available on npm.

---

## 4. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `err.name` check missed in `init-tables.js` | Medium | Silent failure — existing tables not detected | Run init-tables twice; second run must print "already exists" |
| Transitive dependency uses removed Node 14 API (`util.isArray` etc.) | Low | Runtime crash on startup | Check startup output carefully; manual start test required |
| `DynamoDBDocumentClient` marshaling differs from v2 | Low | Data read/write failures | Verify seed + view-data produce expected output |
| uuid import missed in one file | High (easy to miss) | Crash on any user/order creation | Search all files for `require('uuid/v4')` before marking done |

---

## 5. Definition of Done

- [ ] `node --version` prints `v22.x.x`
- [ ] `cat .nvmrc` prints `22`
- [ ] `npm install` completes without errors
- [ ] `npm audit` reports zero high/critical CVEs on upgraded packages
- [ ] `node scripts/init-tables.js` run twice: first "created", second "already exists"
- [ ] `node scripts/seed.js` prints full summary table without errors
- [ ] `node scripts/view-data.js` prints users and orders without errors
- [ ] `node server.js` starts with no deprecation warnings
- [ ] All API endpoints respond correctly via curl
- [ ] Web login → orders flow works in browser
- [ ] `body-parser` not present as a direct dependency
- [ ] All intentional workshop vulnerabilities remain exploitable
- [ ] `README.md` updated to reference Node 22
