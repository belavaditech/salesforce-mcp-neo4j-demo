import os
import traceback
from dotenv import load_dotenv
from neo4j import GraphDatabase
from fastmcp import FastMCP
from neo4j_graphrag.retrievers.text2cypher import Text2CypherRetriever
from neo4j_graphrag.llm import OpenAILLM as LLM

# Load environment variables
load_dotenv()

# Neo4j connection settings
NEO4J_URI = os.getenv("NEO4J_URL", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASS = os.getenv("NEO4J_PASSWORD", "password")

driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))

# Initialize LLM
llm = LLM(
    model_name="gpt-4o-mini",
    model_params={"temperature": 0},
    api_key=os.getenv("OPENAI_API_KEY")
)

# Initialize retriever
retriever = Text2CypherRetriever(driver=driver, llm=llm, neo4j_database="neo4j")

# Initialize MCP server
mcp = FastMCP(name="neo4j-mcp-server", stateless_http=True)  # lighter service mode

@mcp.tool(name="read_neo4j_cypher", description="Execute read-only Cypher against Neo4j")
def read_cypher(query: str) -> dict:
    """
    Executes a Cypher query in Neo4j in READ mode and returns rows.
    """
    try:
        with driver.session(default_access_mode="READ") as session:
            result = session.run(query)
            rows = [record.data() for record in result]
        return {"ok": True, "rows": rows}
    except Exception as e:
        return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

@mcp.tool(name="text2cypher", description="Translate natural language into Cypher queries using GraphRAG retriever")
def text2cypher_tool(query: str, top_k: int = 3) -> dict:
    """
    Uses the Neo4j GraphRAG Text2CypherRetriever to generate Cypher queries,
    executes them, and returns both cypher text and result rows.
    """
    try:
        result = retriever.generate(query)  # or retriever.search(query_text=query) per version
        cypher_query = result.cypher
        graph_result = result.data

        # Execute the generated query
        with driver.session(default_access_mode="READ") as session:
            exec_res = session.run(cypher_query)
            rows = [r.data() for r in exec_res]

        return {
            "input": query,
            "cypher": cypher_query,
            "graphData": rows
        }
    except Exception as e:
        return {"error": str(e), "trace": traceback.format_exc()}

if __name__ == "__main__":
    print("🚀 FastMCP Neo4j MCP Server starting on port 8005 (HTTP)...")
    mcp.run(port=8005)
