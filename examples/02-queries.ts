/**
 * Query filtering, sorting, and pagination.
 *
 * Run: bun run examples/02-queries.ts
 */

import { EzBase } from '@ezwrld/ezbase'

const ez = new EzBase({
  url: 'http://localhost:7003',
  adminKey: process.env.ADMIN_KEY || 'test-admin-key',
})

// Seed some data
const products = [
  { name: 'Laptop', price: 999, category: 'electronics', inStock: true },
  { name: 'Keyboard', price: 79, category: 'electronics', inStock: true },
  { name: 'Desk', price: 450, category: 'furniture', inStock: false },
  { name: 'Monitor', price: 599, category: 'electronics', inStock: true },
  { name: 'Chair', price: 350, category: 'furniture', inStock: true },
  { name: 'Mouse', price: 49, category: 'electronics', inStock: true },
  { name: 'Bookshelf', price: 200, category: 'furniture', inStock: true },
]

for (const p of products) {
  await ez.collection('products').add(p)
}
console.log(`Seeded ${products.length} products\n`)

// Filter by category
const electronics = await ez.collection('products')
  .where('category', '==', 'electronics')
  .get()
console.log('Electronics:', electronics.map(d => d.data.name))
// → ['Laptop', 'Keyboard', 'Monitor', 'Mouse']

// Filter by price range
const midRange = await ez.collection('products')
  .where('price', '>=', 100)
  .where('price', '<=', 600)
  .get()
console.log('Mid-range ($100-$600):', midRange.map(d => `${d.data.name} ($${d.data.price})`))

// Sort by price ascending
const cheapest = await ez.collection('products')
  .orderBy('price', 'asc')
  .limit(3)
  .get()
console.log('Cheapest 3:', cheapest.map(d => `${d.data.name} ($${d.data.price})`))

// Combined: in-stock electronics, sorted by price
const bestDeals = await ez.collection('products')
  .where('category', '==', 'electronics')
  .where('inStock', '==', true)
  .orderBy('price', 'asc')
  .get()
console.log('In-stock electronics (cheapest first):', bestDeals.map(d => `${d.data.name} ($${d.data.price})`))

// Sort by creation time (most recent first)
const newest = await ez.collection('products')
  .orderBy('created', 'desc')
  .limit(3)
  .get()
console.log('3 most recently added:', newest.map(d => d.data.name))
