# EARS — Requirements Plan: Node.js Version Upgrade (14 → 22 LTS)

## Functional Requirements

**FR-1:** The system shall run on Node.js 22 LTS.

**FR-2:** WHEN `node scripts/init-tables.js` is executed the system shall create the `Users` and `Orders` tables in DynamoDB Local without error.

**FR-3:** WHEN `node scripts/init-tables.js` is executed and the tables already exist the system shall print `"already exists"` for each table and exit cleanly.

**FR-4:** WHEN `node scripts/seed.js` is executed the system shall write 3 users and 7 orders to DynamoDB and print the seed summary table.

**FR-5:** WHEN `node scripts/view-data.js` is executed the system shall read and display all users and orders currently in DynamoDB.

**FR-6:** The system shall handle all DynamoDB operations using the aws-sdk v3 `send(new Command(...))` pattern.

**FR-7:** WHEN `npm install` is run the system shall install all dependencies without `body-parser` being present as a direct dependency.

**FR-8:** The system shall generate unique IDs using `uuid` v9 via `const { v4: uuidv4 } = require('uuid')`.

---

## Performance Requirements

**PR-1:** The system shall start (`node server.js`) and be ready to accept HTTP requests within 3 seconds on local hardware.

**PR-2:** The system shall install all dependencies (`npm install`) within 30 seconds on a standard network connection.

---

## Security Requirements

**SR-1:** WHEN `npm audit` is run after the upgrade the system shall report zero high or critical severity vulnerabilities attributable to the upgraded packages.

**SR-2:** The system shall retain all intentional workshop vulnerabilities (plain-text passwords, IDOR, XSS, hardcoded JWT secret, no rate limiting) unchanged and exploitable.

---

## Reliability Requirements

**RR-1:** IF `node scripts/init-tables.js` is run when DynamoDB Local is not reachable THEN the system shall print the connection error and exit with a non-zero code.

**RR-2:** WHILE the application is running the system shall handle DynamoDB `ECONNREFUSED` errors with the same behavior as before the upgrade.

**RR-3:** The system shall produce identical HTTP responses on all existing endpoints before and after the upgrade.

---

## Usability / API Ergonomics

**UE-1:** The system shall print no `DeprecationWarning` or `ExperimentalWarning` messages originating from application code on startup.

**UE-2:** The `.nvmrc` file shall contain `22` so that `nvm use` switches to the correct Node version automatically.

**UE-3:** The `package.json` `engines` field shall specify `">=22.0.0"` to surface version mismatches early during `npm install`.
