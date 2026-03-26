# LLD — Low-Level Design: Node.js Version Upgrade (14 → 22 LTS)

## 1. Component Breakdown

### `config/db.js` — Full rewrite

**Responsibility**: Construct and export DynamoDB clients and JWT secret.

```js
// BEFORE (aws-sdk v2)
const AWS = require('aws-sdk');
AWS.config.update({ region, accessKeyId, secretAccessKey, endpoint });
const dynamodb = new AWS.DynamoDB();
const docClient = new AWS.DynamoDB.DocumentClient();

// AFTER (aws-sdk v3)
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

const dynamodb = new DynamoDBClient({
  region: 'us-east-1',
  credentials: { accessKeyId: 'fakeAccessKeyId', secretAccessKey: 'fakeSecretAccessKey' },
  endpoint: process.env.DYNAMO_ENDPOINT || 'http://localhost:8010'
});
const docClient = DynamoDBDocumentClient.from(dynamodb);
// Exports: { dynamodb, docClient, JWT_SECRET }  ← names unchanged
```

### `models/user.js` and `models/order.js`

**uuid import fix** (both files):
```js
// Remove:
const uuidv4 = require('uuid/v4');
// Add:
const { v4: uuidv4 } = require('uuid');
```

**SDK call pattern** — every `.promise()` call replaced with `send(new Command(...))`:

| Old call | New call | Command import source |
|---|---|---|
| `docClient.put(p).promise()` | `docClient.send(new PutCommand(p))` | `@aws-sdk/lib-dynamodb` |
| `docClient.query(p).promise()` | `docClient.send(new QueryCommand(p))` | `@aws-sdk/lib-dynamodb` |
| `docClient.get(p).promise()` | `docClient.send(new GetCommand(p))` | `@aws-sdk/lib-dynamodb` |
| `docClient.scan(p).promise()` | `docClient.send(new ScanCommand(p))` | `@aws-sdk/lib-dynamodb` |
| `dynamodb.createTable(p).promise()` | `dynamodb.send(new CreateTableCommand(p))` | `@aws-sdk/client-dynamodb` |

### `scripts/init-tables.js`

**Additional fix — error name check:**
```js
// Before (v2 error shape):
if (err.code === 'ResourceInUseException')

// After (v3 error shape):
if (err.name === 'ResourceInUseException')
```

> **Assumption:** No other v2 error properties (`err.code`, `err.statusCode`) are used elsewhere. Confirmed by inspection — only `init-tables.js` inspects error properties.

### `app.js`

```js
// Remove:
const bodyParser = require('body-parser');
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Replace with:
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
```

---

## 2. Data Model Changes

None. DynamoDB table schemas (`Users`, `Orders`), GSI definitions, and all attribute names are unchanged. The v3 `DynamoDBDocumentClient` provides identical marshaling/unmarshaling behavior to the v2 `DocumentClient`.

---

## 3. Logic & Algorithms

No algorithmic changes. The v3 `send(new Command(...))` calls return native Promises with the same resolved shapes as v2's `.promise()` calls:

| Command | Resolved shape |
|---|---|
| `PutCommand` | `{}` |
| `QueryCommand` | `{ Items: [...], Count: N }` |
| `GetCommand` | `{ Item: {...} }` |
| `ScanCommand` | `{ Items: [...], Count: N }` |
| `CreateTableCommand` | `{ TableDescription: {...} }` |

---

## 4. API / Interface Design

No changes to any HTTP endpoints, request/response shapes, or web routes. All existing API contracts are preserved.

---

## 5. Error Handling & Edge Cases

| Failure mode | Location | Detection | Fix |
|---|---|---|---|
| `uuid/v4` MODULE_NOT_FOUND | `models/user.js`, `models/order.js`, `scripts/seed.js` | App crash on startup | Fix import syntax |
| `.promise is not a function` | All model/script call sites | Runtime TypeError | Replace with `send()` |
| `err.code` undefined on ResourceInUseException | `scripts/init-tables.js` | Silent uncaught rejection | Use `err.name` |
| DynamoDB Local not running | All DB operations | `ECONNREFUSED` on `send()` | Existing behavior — unchanged |

---

## 6. Testing Considerations

**Manual smoke tests (no automated test suite in this codebase):**

| Test | Command | Expected |
|---|---|---|
| Tables init (first run) | `node scripts/init-tables.js` | "Users table created", "Orders table created" |
| Tables init (second run) | `node scripts/init-tables.js` | "already exists" for both — confirms `err.name` fix |
| Seed | `node scripts/seed.js` | Summary table printed, no TypeError |
| View data | `node scripts/view-data.js` | Users and orders printed |
| App start | `node server.js` | Listening on :3000, no deprecation warnings |
| Register | `POST /api/v1/auth/register` | 201 + user record with plain-text password |
| Login | `POST /api/v1/auth/login` | JWT + full user record |
| Place order | `POST /api/v1/orders` | 201 + order record |
| Get orders | `GET /api/v1/orders/:userId` | Array of orders (IDOR still works) |
| Web login | Browser `POST /login` | Redirect to `/orders` |
