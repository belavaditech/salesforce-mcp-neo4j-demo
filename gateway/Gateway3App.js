/**
 * Node.js Gateway for Salesforce → MCP Neo4j integration
 * Provides three routes: /method1, /method2, /no-rag
 *  
 * Architecture:
 *  - Receives natural language request from LWC/Apex
 *  - Calls MCP client tool for Neo4j (read/cypher or text2cypher)
 *  - Returns JSON with mode, cypher, raw grounding, grounded answer
 */

import express from 'express';
import bodyParser from 'body-parser';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { OpenAI } from 'openai';

const app = express();
app.use(bodyParser.json());

// Setup MCP client transport
const transport = new StreamableHTTPClientTransport('http://localhost:8005/mcp/');
const mcpClient = new Client({ name: 'Neo4j-Gateway', version: '1.0.0' });
await mcpClient.connect(transport);
console.log('✅ Connected to MCP Neo4j Gateway');

// Setup OpenAI client
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Helper method: translate natural language to Cypher via LLM
 * @param {string} question
 * @returns {Promise<string>} Cypher query
 */
async function translateToCypher(question) {
  const prompt = `
You are an assistant that converts natural language questions into Cypher queries.
Database contains Supplier, Component, Product, Case nodes and relationships.
Return ONLY the Cypher query (no explanation, no markdown).

Question: "${question}"
Cypher:
  `;
  const resp = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [ { role: 'user', content: prompt } ],
    temperature: 0
  });
  let query = resp.choices[0].message.content.trim();
  query = query.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  return query;
}

/**
 * Handler: Method 1 – LLM → Cypher
 */
app.post('/method1', async (req, res) => {
  try {
    const { naturalLanguage } = req.body;
    const cypher = await translateToCypher(naturalLanguage);
    const result = await mcpClient.callTool({ name: 'read_neo4j_cypher', arguments: { query: cypher } });
    console.log('➡️ result:', result);

    // Grounded answer could integrate with LLM summarisation
    const grounded = await groundedAnswer(naturalLanguage, result.content?.json || result.content?.text, cypher);

    res.json({ mode: 'method1', cypher, rawGrounding: result.content, groundedAnswer: grounded });
  } catch (err) {
    console.error('❌ /method1 error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Handler: Method 2 – GraphRAG Text2CypherRetriever
 */
app.post('/method2', async (req, res) => {
  try {
    const { naturalLanguage } = req.body;
    console.log('ℹ️ method2 input:', naturalLanguage);

    const toolResult = await mcpClient.callTool({ name: 'text2cypher', arguments: { query: naturalLanguage } });
    console.log('➡️ toolResult:', toolResult);

    let cypher, graphData;
    const blk = toolResult.content?.[0];
    if (blk?.type === 'text') {
      const parsed = JSON.parse(blk.text);
      cypher = parsed.cypher || parsed.cypherQuery;
      graphData = parsed.graphData || parsed.rows || parsed.data;
    }

    const grounded = await groundedAnswer(naturalLanguage, graphData, cypher);
    res.json({ mode: 'method2', cypher, rawGrounding: graphData, groundedAnswer: grounded });
  } catch (err) {
    console.error('❌ /method2 error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Handler: No-RAG – direct Cypher execution
 */
app.post('/no-rag', async (req, res) => {
  try {
    const { naturalLanguage } = req.body;
    const cypher = await translateToCypher(naturalLanguage);
    const result = await mcpClient.callTool({ name: 'read_neo4j_cypher', arguments: { query: cypher } });
    console.log('➡️ /no-rag result:', result);

    res.json({ mode: 'no-rag', cypher, rawGrounding: naturalLanguage, groundedAnswer: result.content });
  } catch (err) {
    console.error('❌ /no-rag error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start listener
const PORT = process.env.PORT || 9005;
app.listen(PORT, () => console.log(`🚀 Gateway running at http://localhost:${PORT}`));
