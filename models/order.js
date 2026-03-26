const { docClient } = require('../config/db');
const { PutCommand, QueryCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

const TABLE = 'Orders';

const create = (data) => {
  const order = {
    orderId: uuidv4(),
    userId: data.userId,
    item: data.item,         // unsanitized - used with <%-  in EJS (XSS) (CWE-79)
    quantity: data.quantity, // no validation - accepts negative values
    price: data.price,       // client-supplied price - intentional vulnerability
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  return docClient.send(new PutCommand({ TableName: TABLE, Item: order }))
    .then(() => order);
};

const findByUserId = (userId) => {
  // No ownership verification - intentional vulnerability (IDOR) (CWE-639)
  const params = {
    TableName: TABLE,
    IndexName: 'userId-index',
    KeyConditionExpression: 'userId = :userId',
    ExpressionAttributeValues: { ':userId': userId }
  };

  return docClient.send(new QueryCommand(params))
    .then(result => result.Items);
};

module.exports = { create, findByUserId };
