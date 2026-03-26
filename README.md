# Legacy Shop App

A deliberately vulnerable Node.js 22 web application for security workshop use. Participants practice identifying and exploiting common web vulnerabilities in a safe, local environment.

---

## Components

| Component | Technology | Port |
|---|---|---|
| Web App + API | Node.js 22, Express 4.21.x | 3000 |
| Database | DynamoDB Local (Amazon) | 8010 |
| Database Admin UI | DynamoDB Admin (aaronshaf) | 8011 |

### Web App (`server.js` / `app.js`)
Express server that handles both server-rendered HTML pages (EJS templates) and a JSON REST API under `/api/v1`. No TLS, no security headers, no rate limiting.

### REST API (`/api/v1`)
| Method | Endpoint | Auth | Description |
|---|---|---|---|
| POST | `/api/v1/auth/register` | None | Register a new user |
| POST | `/api/v1/auth/login` | None | Login, returns JWT + full user record |
| GET | `/api/v1/users/:userId` | JWT | Get user by ID |
| POST | `/api/v1/orders` | JWT | Place a new order |
| GET | `/api/v1/orders/:userId` | JWT | Get orders for any userId (IDOR) |

### Web UI Routes
| Method | Path | Description |
|---|---|---|
| GET | `/login` | Login page |
| POST | `/login` | Authenticate, set JWT cookie |
| GET | `/register` | Register page |
| POST | `/register` | Create account, redirect to login |
| GET | `/orders` | View orders (auth required) |
| POST | `/orders` | Place order (auth required) |
| GET | `/orders/new` | New order form (auth required) |
| GET | `/logout` | Clear cookie, redirect to login |

### DynamoDB Tables
**Users**
- Partition key: `userId` (UUID)
- Attributes: `username`, `email`, `password` (plain text), `role`, `createdAt`
- GSI: `username-index` on `username` (used for login lookup)

**Orders**
- Partition key: `orderId` (UUID)
- Attributes: `userId`, `item`, `quantity`, `price`, `status`, `createdAt`
- GSI: `userId-index` on `userId` (used to fetch orders per user)

---

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser / Client                    │
│              (HTML forms  or  REST API calls)            │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP :3000
                         ▼
┌─────────────────────────────────────────────────────────┐
│                  Express Application                     │
│                                                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ authRoutes  │  │ orderRoutes  │  │   apiRoutes   │  │
│  │  /login     │  │  /orders     │  │  /api/v1/*    │  │
│  │  /register  │  │  /orders/new │  │               │  │
│  └──────┬──────┘  └──────┬───────┘  └──────┬────────┘  │
│         │                │                  │            │
│         └────────────────┼──────────────────┘            │
│                          │                               │
│               ┌──────────▼──────────┐                   │
│               │  auth middleware     │                   │
│               │  (JWT cookie/header)│                   │
│               └──────────┬──────────┘                   │
│                          │                               │
│          ┌───────────────┼───────────────┐              │
│          ▼               ▼               ▼              │
│  ┌───────────────┐ ┌──────────┐ ┌──────────────┐       │
│  │authController │ │ order    │ │    EJS       │       │
│  │               │ │Controller│ │   Views      │       │
│  └───────┬───────┘ └────┬─────┘ └──────────────┘       │
│          │              │                               │
│          └──────┬───────┘                               │
│                 │                                       │
│       ┌─────────▼─────────┐                            │
│       │   Models           │                            │
│       │  user.js           │                            │
│       │  order.js          │                            │
│       └─────────┬──────────┘                            │
└─────────────────┼───────────────────────────────────────┘
                  │ AWS SDK v2  :8010
                  ▼
┌─────────────────────────────────────────────────────────┐
│              DynamoDB Local  (:8010)                     │
│                                                          │
│        ┌───────────────┐   ┌───────────────┐           │
│        │  Users table  │   │  Orders table │           │
│        └───────────────┘   └───────────────┘           │
└─────────────────────────────────────────────────────────┘
                  │
                  │ viewed via
                  ▼
┌─────────────────────────────────────────────────────────┐
│              DynamoDB Admin UI  (:8011)                  │
│         (browse tables, inspect raw records)             │
└─────────────────────────────────────────────────────────┘
```

---

## User Request Flows

### 1. Register

```
Browser                Express                 DynamoDB
  │                       │                       │
  │  POST /register       │                       │
  │  {username, email,    │                       │
  │   password}           │                       │
  │──────────────────────►│                       │
  │                       │  PUT Users            │
  │                       │  (password plain text)│
  │                       │──────────────────────►│
  │                       │  200 OK               │
  │                       │◄──────────────────────│
  │  302 redirect /login  │                       │
  │◄──────────────────────│                       │
```

### 2. Login

```
Browser                Express                 DynamoDB
  │                       │                       │
  │  POST /login          │                       │
  │  {username, password} │                       │
  │──────────────────────►│                       │
  │                       │  Query username-index │
  │                       │──────────────────────►│
  │                       │  {user record}        │
  │                       │◄──────────────────────│
  │                       │                       │
  │                       │  compare plain-text   │
  │                       │  passwords            │
  │                       │                       │
  │                       │  sign JWT             │
  │                       │  (secret: super       │
  │                       │   secret123)          │
  │                       │                       │
  │  Set-Cookie: token=…  │                       │
  │  302 redirect /orders │                       │
  │◄──────────────────────│                       │
```

### 3. View Orders (Web)

```
Browser                Express            auth middleware        DynamoDB
  │                       │                     │                   │
  │  GET /orders          │                     │                   │
  │  Cookie: token=…      │                     │                   │
  │──────────────────────►│                     │                   │
  │                       │  jwt.verify(token)  │                   │
  │                       │────────────────────►│                   │
  │                       │  {userId, username} │                   │
  │                       │◄────────────────────│                   │
  │                       │                     │                   │
  │                       │  Query userId-index (userId from JWT)   │
  │                       │────────────────────────────────────────►│
  │                       │  [{orders}]                             │
  │                       │◄────────────────────────────────────────│
  │                       │                     │                   │
  │  render orders/index  │                     │                   │
  │  (item rendered with  │                     │                   │
  │   <%-  unescaped)     │                     │                   │
  │◄──────────────────────│                     │                   │
```

### 4. Place Order (Web)

```
Browser                Express            auth middleware        DynamoDB
  │                       │                     │                   │
  │  POST /orders         │                     │                   │
  │  {item, quantity,     │                     │                   │
  │   price}              │                     │                   │
  │──────────────────────►│                     │                   │
  │                       │  jwt.verify(token)  │                   │
  │                       │────────────────────►│                   │
  │                       │  {userId}           │                   │
  │                       │◄────────────────────│                   │
  │                       │                     │                   │
  │                       │  PUT Orders                             │
  │                       │  (price from client, no validation)     │
  │                       │────────────────────────────────────────►│
  │                       │  200 OK                                 │
  │                       │◄────────────────────────────────────────│
  │  302 redirect /orders │                     │                   │
  │◄──────────────────────│                     │                   │
```

### 5. API Login + Place Order (REST)

```
Client                 Express                 DynamoDB
  │                       │                       │
  │  POST /api/v1/        │                       │
  │    auth/login         │                       │
  │──────────────────────►│                       │
  │                       │  Query + compare      │
  │                       │──────────────────────►│
  │  {token, user         │◄──────────────────────│
  │   (incl. password)}   │                       │
  │◄──────────────────────│                       │
  │                       │                       │
  │  POST /api/v1/orders  │                       │
  │  Authorization: token │                       │
  │  {item, qty, price}   │                       │
  │──────────────────────►│                       │
  │                       │  PUT Orders           │
  │                       │──────────────────────►│
  │  {order}              │◄──────────────────────│
  │◄──────────────────────│                       │
```

---

## Setup & Running

```bash
# 1. Install dependencies
npm install

# 2. Start everything (infra + app)
make start

# Or step by step:
make infra    # start DynamoDB Local + Admin UI
make init     # create tables
make app      # start the web server
```

**Services after startup:**

| Service | URL |
|---|---|
| Web App | http://localhost:3000 |
| REST API | http://localhost:3000/api/v1 |
| DynamoDB Admin | http://localhost:8011 |

Stop everything: `make stop`

---

## Project Structure

```
legacy-app/
├── app.js                   # Express setup, middleware, route mounting
├── server.js                # HTTP server bootstrap
├── Makefile                 # start / stop / init commands
├── docker-compose.yml       # DynamoDB Local + Admin containers
├── package.json             # Node 22 engine, updated deps
├── config/
│   └── db.js                # DynamoDB client, hardcoded JWT secret
├── middleware/
│   └── auth.js              # JWT verification (no algorithm pinning)
├── models/
│   ├── user.js              # Users table access
│   └── order.js             # Orders table access
├── controllers/
│   ├── authController.js    # Register / login logic
│   └── orderController.js   # Place order / get orders logic
├── routes/
│   ├── authRoutes.js        # /login, /register, /logout
│   ├── orderRoutes.js       # /orders, /orders/new
│   └── apiRoutes.js         # /api/v1/*
├── views/
│   ├── auth/
│   │   ├── login.ejs
│   │   └── register.ejs
│   ├── orders/
│   │   ├── index.ejs        # uses <%-  (unescaped, XSS)
│   │   └── new.ejs
│   └── error.ejs            # renders full stack trace
├── public/
│   └── css/style.css
└── scripts/
    └── init-tables.js       # one-time table creation
```

---

## Intentional Vulnerabilities

| # | Vulnerability | CWE | Location |
|---|---|---|---|
| V1 | Plain-text passwords stored | CWE-256 | `models/user.js` |
| V2 | Hardcoded JWT secret in source | CWE-798 | `config/db.js` |
| V3 | Password returned in API responses | CWE-200 | `controllers/authController.js` |
| V4 | IDOR — fetch any user's orders | CWE-639 | `routes/apiRoutes.js` |
| V5 | Stored XSS via unescaped EJS `<%-` | CWE-79 | `views/orders/index.ejs` |
| V6 | Stack traces exposed in responses | CWE-209 | `views/error.ejs`, controllers |
| V7 | No rate limiting on `/login` | CWE-307 | `routes/authRoutes.js` |
| V8 | JWT algorithm not pinned (`alg:none`) | CWE-327 | `middleware/auth.js` |
| V9 | Client-supplied price accepted as-is | CWE-20 | `models/order.js` |
| V10 | No security headers (no helmet) | CWE-693 | `app.js` |
