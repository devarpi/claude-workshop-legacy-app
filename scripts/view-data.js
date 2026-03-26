const { docClient } = require('../config/db');
const { ScanCommand } = require('@aws-sdk/lib-dynamodb');

const scan = (table) =>
  docClient.send(new ScanCommand({ TableName: table })).then(r => r.Items);

const printUsers = (users) => {
  console.log(`\n  USERS  (${users.length} records)\n`);
  console.log('  Username   Role    Email                      Password');
  console.log('  ' + '─'.repeat(56));
  if (users.length === 0) {
    console.log('  (empty)');
    return;
  }
  users
    .sort((a, b) => a.username.localeCompare(b.username))
    .forEach(u => {
      console.log(
        `  ${u.username.padEnd(10)} ${u.role.padEnd(7)} ${u.email.padEnd(26)} ${u.password}`
      );
    });
};

const printOrders = (orders, users) => {
  const userMap = Object.fromEntries(users.map(u => [u.userId, u.username]));

  console.log(`\n\n  ORDERS  (${orders.length} records)\n`);
  console.log('  User       Item                  Qty   Price     Status    Date');
  console.log('  ' + '─'.repeat(68));
  if (orders.length === 0) {
    console.log('  (empty)');
    return;
  }
  orders
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .forEach(o => {
      const username = (userMap[o.userId] || o.userId.slice(0, 8)).padEnd(10);
      const date = new Date(o.createdAt).toLocaleDateString();
      console.log(
        `  ${username} ${o.item.padEnd(21)} ${String(o.quantity).padEnd(5)} ` +
        `$${String(o.price).padEnd(9)} ${o.status.padEnd(9)} ${date}`
      );
    });
};

(async () => {
  const line = '─'.repeat(72);

  console.log('\n' + line);
  console.log('  DYNAMODB  —  CURRENT DATA');
  console.log(line);

  const [users, orders] = await Promise.all([scan('Users'), scan('Orders')]);

  printUsers(users);
  printOrders(orders, users);

  console.log('\n' + line);
  console.log(`  Total: ${users.length} users, ${orders.length} orders`);
  console.log(`  Admin UI  http://localhost:8011`);
  console.log(line + '\n');
})().catch(err => {
  console.error('Failed to read data:', err.message);
  process.exit(1);
});
