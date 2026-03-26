const { docClient } = require('../config/db');
const { PutCommand, QueryCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
const { v4: uuidv4 } = require('uuid');

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

  return docClient.send(new PutCommand({ TableName: TABLE, Item: user }))
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

  return docClient.send(new QueryCommand(params))
    .then(result => result.Items[0] || null);
};

const findById = (userId) => {
  return docClient.send(new GetCommand({ TableName: TABLE, Key: { userId } }))
    .then(result => result.Item || null);
};

module.exports = { create, findByUsername, findById };
