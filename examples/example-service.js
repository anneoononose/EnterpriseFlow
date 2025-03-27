/**
 * Example backend service for testing EnterpriseFlow
 */

const express = require('express');
const app = express();
const port = 3001;

// Middleware
app.use(express.json());

// Sample data
const products = [
  { id: '1', name: 'Product 1', price: 100 },
  { id: '2', name: 'Product 2', price: 200 },
  { id: '3', name: 'Product 3', price: 300 }
];

// Routes
app.get('/api/example/products', (req, res) => {
  res.json(products);
});

app.get('/api/example/products/:id', (req, res) => {
  const product = products.find(p => p.id === req.params.id);
  
  if (!product) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  res.json(product);
});

app.post('/api/example/products', (req, res) => {
  const { name, price } = req.body;
  
  if (!name || !price) {
    return res.status(400).json({ error: 'Name and price are required' });
  }
  
  const newProduct = {
    id: String(products.length + 1),
    name,
    price
  };
  
  products.push(newProduct);
  res.status(201).json(newProduct);
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Start server
app.listen(port, () => {
  console.log(`Example service running at http://localhost:${port}`);
});