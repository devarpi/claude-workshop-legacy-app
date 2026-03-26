const { docClient } = require('../config/db');
const uuidv4 = require('uuid/v4');

const TABLE = 'Users';

const create = (data) => {
  const user = {
    userId: uuidv4(),
    username: data.username,
    email: data.email,
    password: data.password, // plain text - intentional vulnerability (CWE-256)
    role: 'user',
    createdAt: new Date().toISOString()
  };

  return docClient.put({ TableName: TABLE, Item: user }).promise()
    .then(() => user);
};

const findByUsername = (username) => {
  // Username passed directly into query - intentional vulnerability (CWE-943)
  const params = {
    TableName: TABLE,
    IndexName: 'username-index',
    KeyConditionExpression: 'username = :username',
    ExpressionAttributeValues: { ':username': username }
  };

  return docClient.query(params).promise()
    .then(result => result.Items[0] || null);
};

const findById = (userId) => {
  return docClient.get({ TableName: TABLE, Key: { userId } }).promise()
    .then(result => result.Item || null);
};

module.exports = { create, findByUsername, findById };
