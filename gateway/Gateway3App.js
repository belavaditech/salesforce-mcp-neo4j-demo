// gateway.js
// Node.js Gateway that demonstrates:
// - Method 1: translateToCypher() via LLM -> call read_neo4j_cypher MCP tool
// - Method 2: call text2cypher_retriever MCP tool -> use returned grounding
// - No-RAG: simple pre-canned logic (or direct SOQL/Apex-like behavior simulated)

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { OpenAI } = require('openai');

const app = express();
app.use(bodyParser.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function createMcpClient() {
  const transport = new StreamableHTTPClientTransport('http://localhost:8005/mcp/');
  const client = new Client({ name: 'Neo4j Gateway', version: '1.0.0' });
  await client.connect(transport);
  console.log('✅ Connected to MCP Neo4j Cypher');
  return client;
}

let mcpClientPromise = createMcpClient();

// ---------- Utility: Translate natural language -> Cypher using LLM (Method 1) ----------
async function translateToCypher(question) {
  const prompt = `You are an assistant that converts natural language questions into Cypher queries for Neo4j.
Database contains nodes: Supplier, Component, Product, Case; relationships: CAN_SUPPLY, USED_IN, SUPPLIES.
Return ONLY the Cypher query without explanation, no markdown.

Question: "${question}"
Cypher:`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0
  });

  let query = response.choices[0].message.content.trim();
  query = query.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '').trim();
  return query;
}

// ---------- Utility: Produce grounded LLM answer from graph data ----------
async function groundedAnswer(originalQuestion, graphData, cypher) {
  const context = `Grounding data (first rows): ${JSON.stringify(graphData).slice(0, 10000)}`;
  const prompt = `You are an expert product design analyst.
Use the following grounding data from Neo4j to answer the question below. Be concise and show the reasoning paths and metrics (cost, risk, time) when possible. Use the cypher used: ${cypher}\n\nGrounding: ${context}\n\nQuestion: ${originalQuestion}`;

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1
  });

  return response.choices[0].message.content.trim();
}

// ---------- Endpoints ----------

// Health
app.get('/health', (req, res) => res.json({ ok: true }));

// 1) Method 1: LWC -> Gateway -> translateToCypher(LM) -> MCP read_neo4j_cypher -> groundedAnswer -> return
app.post('/method1', async (req, res) => {
  try {
    const { naturalLanguage } = req.body;
    const cypherQuery = await translateToCypher(naturalLanguage);

    const client = await mcpClientPromise;
    const result = await client.callTool({ name: 'read_neo4j_cypher', arguments: { query: cypherQuery } });

	  console.log(result);

    const grounded = await groundedAnswer(naturalLanguage, result.content?.json || result.content?.text || result, cypherQuery);

    res.json({ mode: 'method1', cypher: cypherQuery, rawGrounding: result.content || null, groundedAnswer: grounded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 2) Method 2: LWC -> Gateway -> MCP text2cyphertool -> returns cypher + grounding -> groundedAnswer -> return
app.post('/method2', async (req, res) => {

  console.log("method2 LWC -> Gateway -> MCP text2cyphertool");
  try {
    const { naturalLanguage } = req.body;
    const client = await mcpClientPromise;

    // Call the MCP tool that exposes text2cypher retriever on the Neo4j side
    const toolResult = await client.callTool({ name: 'text2cypher', arguments: { query: naturalLanguage } });

	  console.log(toolResult);
    // Expect toolResult.content to include { cypherQuery, graphData }
    // const cypherQuery = toolResult.content?.json?.cypherQuery || toolResult.content?.json?.cypher || (toolResult.content?.text || '').slice(0, 2000);


  const contentBlock = toolResult.content?.[0];
  if (contentBlock?.type === 'text' && contentBlock.text) {
    const parsed = JSON.parse(contentBlock.text);
    cypherQuery = parsed.cypher || parsed.cypherQuery || parsed.metadata?.cypher;
    graphData = parsed.graphData || parsed.rows || parsed.records || parsed.data;
  }


    console.log("cypherQuery = " + cypherQuery);
    // const graphData = toolResult.content?.json?.graphData || toolResult.content?.json?.rows || toolResult.content?.text || toolResult.content || {};
	

    console.log("graphData = " + graphData);

    const grounded = await groundedAnswer(naturalLanguage, graphData, cypherQuery);

    console.log("grounded = " + grounded);

    res.json({ mode: 'method2', cypher: cypherQuery, rawGrounding: graphData, groundedAnswer: grounded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 3) No-RAG: simple heuristic mock (simulate direct DB lookups or Apex)
app.post('/no-rag', async (req, res) => {
  try {
    const { naturalLanguage } = req.body;
    const cypherQuery = await translateToCypher(naturalLanguage);

    const client = await mcpClientPromise;
    const result = await client.callTool({ name: 'read_neo4j_cypher', arguments: { query: cypherQuery } });

	  console.log(result);

    // const grounded = await groundedAnswer(naturalLanguage, result.content?.json || result.content?.text || result, cypherQuery);

    res.json({ mode: 'no-rag', cypher: cypherQuery, rawGrounding: naturalLanguage, groundedAnswer: result.content || null });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 9005;
app.listen(PORT, () => console.log(`🚀 Gateway running on http://localhost:${PORT}`));
