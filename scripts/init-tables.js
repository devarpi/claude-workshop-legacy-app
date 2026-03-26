const { dynamodb } = require('../config/db');
const { CreateTableCommand } = require('@aws-sdk/client-dynamodb');

const createUsersTable = () => {
  const params = {
    TableName: 'Users',
    KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'userId', AttributeType: 'S' },
      { AttributeName: 'username', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'username-index',
      KeySchema: [{ AttributeName: 'username', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: 'PAY_PER_REQUEST'
  };

  return dynamodb.send(new CreateTableCommand(params));
};

const createOrdersTable = () => {
  const params = {
    TableName: 'Orders',
    KeySchema: [{ AttributeName: 'orderId', KeyType: 'HASH' }],
    AttributeDefinitions: [
      { AttributeName: 'orderId', AttributeType: 'S' },
      { AttributeName: 'userId', AttributeType: 'S' }
    ],
    GlobalSecondaryIndexes: [{
      IndexName: 'userId-index',
      KeySchema: [{ AttributeName: 'userId', KeyType: 'HASH' }],
      Projection: { ProjectionType: 'ALL' },
      ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 }
    }],
    BillingMode: 'PAY_PER_REQUEST'
  };

  return dynamodb.send(new CreateTableCommand(params));
};

(async () => {
  try {
    await createUsersTable();
    console.log('Users table created');
  } catch (err) {
    if (err.name === 'ResourceInUseException') {
      console.log('Users table already exists');
    } else {
      console.error('Error creating Users table:', err.message);
    }
  }

  try {
    await createOrdersTable();
    console.log('Orders table created');
  } catch (err) {
    if (err.name === 'ResourceInUseException') {
      console.log('Orders table already exists');
    } else {
      console.error('Error creating Orders table:', err.message);
    }
  }

  console.log('Database initialization complete');
})();
