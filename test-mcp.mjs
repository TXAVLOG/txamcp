import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const API_KEY = process.env.API_KEY || 'txamcp-test-key';
const BASE_URL = 'http://localhost:3000';

async function testAuth() {
  console.log('--- Testing Authentication ---');
  
  // Test No Key
  const res1 = await fetch(`${BASE_URL}/mcp/config`);
  console.log(`No Key: ${res1.status} (Expected: 401)`);
  
  // Test Invalid Key
  const res2 = await fetch(`${BASE_URL}/mcp/config?api_key=wrong-key`);
  console.log(`Invalid Key: ${res2.status} (Expected: 403)`);
  
  // Test Valid Key
  const res3 = await fetch(`${BASE_URL}/mcp/config?api_key=${API_KEY}`);
  console.log(`Valid Key: ${res3.status} (Expected: 200)`);
}

async function testTools() {
  console.log('\n--- Testing Tools Endpoints ---');
  
  // List Tools
  const res1 = await fetch(`${BASE_URL}/mcp/tools?api_key=${API_KEY}`);
  const data1 = await res1.json();
  console.log(`List Tools: Found ${data1.tools?.length || 0} tools`);
  
  // Call Tool (list_repositories)
  const res2 = await fetch(`${BASE_URL}/mcp/tools/list_repositories?api_key=${API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ arguments: {} })
  });
  const data2 = await res2.json();
  console.log(`Call Tool (list_repositories): ${data2.content ? 'Success' : 'Failed'}`);
}

async function runTests() {
  try {
    await testAuth();
    await testTools();
  } catch (err) {
    console.error('Test Failed:', err.message);
  }
}

runTests();
