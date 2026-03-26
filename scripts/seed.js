const { docClient } = require('../config/db');
const uuidv4 = require('uuid/v4');

const users = [
  { username: 'alice',  email: 'alice@example.com',  password: 'password123', role: 'user'  },
  { username: 'bob',    email: 'bob@example.com',    password: 'bob1234',     role: 'user'  },
  { username: 'admin',  email: 'admin@example.com',  password: 'admin',       role: 'admin' },
];

const orderTemplates = [
  { item: 'Widget Pro',       quantity: 2,  price: 19.99  },
  { item: 'Gadget Lite',      quantity: 1,  price: 49.00  },
  { item: 'Super Connector',  quantity: 5,  price: 4.99   },
  { item: 'Turbo Adapter',    quantity: 1,  price: 129.95 },
  { item: 'Nano Cable',       quantity: 10, price: 2.50   },
  { item: 'Power Pack',       quantity: 1,  price: 39.99  },
];

const isEmpty = async () => {
  const result = await docClient.scan({ TableName: 'Users', Limit: 1 }).promise();
  return result.Count === 0;
};

const seedUsers = async () => {
  const created = [];
  for (const u of users) {
    const user = {
      userId:    uuidv4(),
      username:  u.username,
      email:     u.email,
      password:  u.password,   // plain text - intentional
      role:      u.role,
      createdAt: new Date().toISOString(),
    };
    await docClient.put({ TableName: 'Users', Item: user }).promise();
    created.push(user);
  }
  return created;
};

const seedOrders = async (seededUsers) => {
  const created = [];
  for (const user of seededUsers) {
    const count = user.role === 'admin' ? 1 : 3;
    for (let i = 0; i < count; i++) {
      const template = orderTemplates[(seededUsers.indexOf(user) * 3 + i) % orderTemplates.length];
      const order = {
        orderId:   uuidv4(),
        userId:    user.userId,
        item:      template.item,
        quantity:  template.quantity,
        price:     template.price,
        status:    i === 0 ? 'complete' : 'pending',
        createdAt: new Date(Date.now() - i * 86400000).toISOString(),
      };
      await docClient.put({ TableName: 'Orders', Item: order }).promise();
      created.push({ username: user.username, ...order });
    }
  }
  return created;
};

const printSummary = (seededUsers, seededOrders) => {
  const line = '─'.repeat(60);

  console.log('\n' + line);
  console.log('  SEED DATA SUMMARY');
  console.log(line);

  console.log('\n  USERS  (passwords stored in plain text)\n');
  console.log('  Username   Role    Email                      Password');
  console.log('  ' + '─'.repeat(56));
  for (const u of seededUsers) {
    console.log(
      `  ${u.username.padEnd(10)} ${u.role.padEnd(7)} ${u.email.padEnd(26)} ${u.password}`
    );
  }

  console.log('\n\n  ORDERS\n');
  console.log('  User       Item                  Qty   Price    Status');
  console.log('  ' + '─'.repeat(56));
  for (const o of seededOrders) {
    console.log(
      `  ${o.username.padEnd(10)} ${o.item.padEnd(21)} ${String(o.quantity).padEnd(5)} ` +
      `$${String(o.price).padEnd(8)} ${o.status}`
    );
  }

  console.log('\n' + line);
  console.log('  WORKSHOP HINTS');
  console.log(line);
  console.log('  - Passwords are stored plain text: check Users table in Admin UI');
  console.log('  - Login as any user, then fetch another user\'s orders (IDOR)');
  console.log('  - Place an order with item: <script>alert(1)</script>  (XSS)');
  console.log('  - POST /api/v1/orders with price: -999  (client-supplied price)');
  console.log('\n  Admin UI   http://localhost:8011');
  console.log('  Web App    http://localhost:3000');
  console.log(line + '\n');
};

(async () => {
  const checkOnly = process.argv.includes('--if-empty');

  if (checkOnly && !(await isEmpty())) {
    console.log('  DynamoDB already has data, skipping seed.');
    return;
  }

  console.log('\nSeeding database...');
  const seededUsers  = await seedUsers();
  const seededOrders = await seedOrders(seededUsers);

  printSummary(seededUsers, seededOrders);
})().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
