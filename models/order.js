const { docClient } = require('../config/db');
const uuidv4 = require('uuid/v4');

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

  return docClient.put({ TableName: TABLE, Item: order }).promise()
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

  return docClient.query(params).promise()
    .then(result => result.Items);
};

module.exports = { create, findByUserId };
