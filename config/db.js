const AWS = require('aws-sdk');

// Hardcoded credentials - intentional vulnerability (CWE-798)
const JWT_SECRET = 'supersecret123';

AWS.config.update({
  region: 'us-east-1',
  accessKeyId: 'fakeAccessKeyId',
  secretAccessKey: 'fakeSecretAccessKey',
  endpoint: process.env.DYNAMO_ENDPOINT || 'http://localhost:8010'
});

const dynamodb = new AWS.DynamoDB();
const docClient = new AWS.DynamoDB.DocumentClient();

module.exports = { dynamodb, docClient, JWT_SECRET };
