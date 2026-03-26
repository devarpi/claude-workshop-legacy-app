const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Legacy shop app running on http://localhost:${PORT}`);
  console.log(`DynamoDB Admin UI: http://localhost:8011`);
});
