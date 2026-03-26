const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');

// Hardcoded credentials - intentional vulnerability (CWE-798)
const JWT_SECRET = 'supersecret123';

const dynamodb = new DynamoDBClient({
  region: 'us-east-1',
  credentials: {
    accessKeyId: 'fakeAccessKeyId',
    secretAccessKey: 'fakeSecretAccessKey'
  },
  endpoint: process.env.DYNAMO_ENDPOINT || 'http://localhost:8010'
});

const docClient = DynamoDBDocumentClient.from(dynamodb);

module.exports = { dynamodb, docClient, JWT_SECRET };
