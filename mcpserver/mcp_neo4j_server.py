# mcp_neo4j_server.py — FastMCP + Neo4j GraphRAG Retriever (robust retriever invocation)
# Uses neo4j-graphrag Text2CypherRetriever, tolerant to several API shapes.
# Run: python mcp_neo4j_server.py
# Requirements (examples):
#   pip install fastmcp neo4j neo4j-graphrag openai python-dotenv

import os
import traceback
from dotenv import load_dotenv

from neo4j import GraphDatabase
from fastmcp import FastMCP
from neo4j_graphrag.llm import OpenAILLM as LLM
from neo4j_graphrag.retrievers.text2cypher import Text2CypherRetriever
from neo4j_graphrag.generation import GraphRAG
from neo4j_graphrag.embeddings import OpenAIEmbeddings
from neo4j_graphrag.retrievers import VectorRetriever

load_dotenv()

# -----------------------
# Config (from env)
# -----------------------
NEO4J_URI = os.getenv("NEO4J_URL", "bolt://localhost:7687")
NEO4J_USER = os.getenv("NEO4J_USER", "neo4j")
NEO4J_PASS = os.getenv("NEO4J_PASSWORD", "password")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
MCP_PORT = int(os.getenv("MCP_PORT", "8005"))

if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY not set in environment")

INDEX_NAME = "my_vector_index"

# -----------------------
# Neo4j driver
# -----------------------
driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASS))

# -----------------------
# LLM wrapper for retriever
# -----------------------
# neo4j_graphrag provides OpenAILLM (or similar) — use that class
llm = LLM(model_name="gpt-4o-mini", model_params={"temperature": 0}, api_key=OPENAI_API_KEY)

# 2. Retriever
# Create Embedder object, needed to convert the user question (text) to a vector
vectorembedder = OpenAIEmbeddings(model="text-embedding-3-large")

# Initialize the retriever
vectorretriever = VectorRetriever(driver, INDEX_NAME, vectorembedder)

# Initialize the RAG pipeline
vectorrag = GraphRAG(retriever=vectorretriever, llm=llm)

# -----------------------
# Initialize Text2CypherRetriever
# -----------------------
# The retriever expects a driver + llm (kwargs may differ across versions)
retriever = Text2CypherRetriever(driver=driver, llm=llm, neo4j_database=os.getenv("NEO4J_DATABASE", "neo4j"))

rag = GraphRAG(retriever=retriever, llm=llm)

# -----------------------
# FastMCP app
# -----------------------
mcp = FastMCP(name="neo4j-mcp-server", stateless_http=True)



# -----------------------
# Helpers
# -----------------------
def _execute_cypher_return_rows(cypher_text: str, params: dict | None = None):
    """Execute a cypher string in read mode and return list of record.data() dicts."""
    params = params or {}
    with driver.session(default_access_mode="READ") as session:
        result = session.run(cypher_text, **params)
        return [rec.data() for rec in result]

def _normalize_retriever_output(raw):
    """
    Accept several possible retriever outputs and return a normalized tuple:
    (cypher_text: str | None, graph_rows: list | None, metadata: dict)
    """
    metadata = {}
    cypher_text = None
    graph_rows = None

    # 1) If retriever returned a simple string (cypher)
    if isinstance(raw, str):
        cypher_text = raw
        return cypher_text, None, metadata

    # 2) If tuple/list like (cypher, metadata) or (cypher, rows)
    if isinstance(raw, (list, tuple)):
        if len(raw) >= 1:
            if isinstance(raw[0], str):
                cypher_text = raw[0]
            elif isinstance(raw[0], dict):
                # maybe raw[0] is a dict with 'cypher'
                cypher_text = raw[0].get("cypher")
        # try to find rows or metadata in remaining items
        for item in raw[1:]:
            if isinstance(item, list):
                graph_rows = item
            elif isinstance(item, dict):
                metadata.update(item)

        return cypher_text, graph_rows, metadata

    # 3) If dict-like (some versions may return dict)
    if isinstance(raw, dict):
        # common keys: 'cypher', 'cypher_text', 'query', 'data', 'rows', 'records', 'metadata'
        cypher_text = raw.get("cypher") or raw.get("cypher_text") or raw.get("query")
        if "data" in raw and isinstance(raw["data"], list):
            graph_rows = raw["data"]
        elif "rows" in raw and isinstance(raw["rows"], list):
            graph_rows = raw["rows"]
        elif "records" in raw and isinstance(raw["records"], list):
            graph_rows = raw["records"]
        # metadata: anything else
        for k, v in raw.items():
            if k not in ("cypher", "cypher_text", "query", "data", "rows", "records"):
                metadata[k] = v
        return cypher_text, graph_rows, metadata

    # 4) If object with attributes (e.g., result.cypher, result.data)
    if hasattr(raw, "cypher") or hasattr(raw, "data") or hasattr(raw, "records") or hasattr(raw, "metadata"):
        try:
            cypher_text = getattr(raw, "cypher", None)
            # some versions expose `data` or `rows` or `records`
            graph_rows = getattr(raw, "data", None) or getattr(raw, "rows", None) or getattr(raw, "records", None)
            # attempt to transform records -> list of dicts
            if graph_rows and not isinstance(graph_rows, list):
                # try converting record objects to .data()
                try:
                    graph_rows = [r.data() for r in graph_rows]
                except Exception:
                    # leave as-is
                    pass
            # metadata
            metadata = getattr(raw, "metadata", {}) or {}
        except Exception:
            pass
        return cypher_text, graph_rows, dict(metadata)

    # fallback: unknown type — return its string repr as cypher (last resort)
    try:
        return str(raw), None, metadata
    except Exception:
        return None, None, metadata

# -----------------------
# Tool: read_neo4j_cypher
# -----------------------
@mcp.tool(name="read_neo4j_cypher")
def read_neo4j_cypher(query: str):
    """
    Execute read-only Cypher and return rows.
    """
    try:
        rows = _execute_cypher_return_rows(query)
        return {"ok": True, "rows": rows}
    except Exception as e:
        return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

# -----------------------
# Tool: text2cypher (GraphRAG)
# -----------------------

@mcp.tool(name="text2cypher")
def text2cypher_tool(query: str, top_k: int = 3):
    """
    Use Neo4j GraphRAG Text2CypherRetriever to generate Cypher via rag.search().
    """
    try:
        # ✅ Call correct official API for latest neo4j-graphrag
        # result = rag.search(query_text=query)
        result = retriever.search(query_text=query)
        print (result)
        

        # fallback if result.cypher_query is missing
        # cypher_query = getattr(result, "cypher_query", None) or getattr(result, "cypher", None)

        cypher_query = (
            getattr(result, "cypher_query", None)
            or getattr(result, "cypher", None)
            or getattr(result, "query", None)
            or (getattr(result, "metadata", {}) or {}).get("cypher")
            or (getattr(result, "metadata", {}) or {}).get("cypher_text")
        )



        # ✅ Extract fields safely
        # cypher_query = getattr(result, "cypher_query", None)
        graph_data = getattr(result, "records", None)

        if not cypher_query:
            return {"error": "No Cypher generated", "raw": str(result)}

        # ✅ Execute Cypher via standard Neo4j session
        with driver.session() as session:
            data_rows = session.run(cypher_query)
            final_data = [record.data() for record in data_rows]

        return {
            "input": query,
            "cypher": cypher_query,
            "graphData": final_data
        }

    except Exception as e:
        return {"error": str(e)}




# -----------------------
# Tool: vectorsearch (GraphRAG)
# -----------------------

@mcp.tool(name="vectorsearch")
def vectorsearch_tool(query: str, top_k: int = 3):
    """
    Use Neo4j GraphRAG VectorRetriever to generate similar patterns via rag.search().
    """
    try:
        # ✅ Call correct official API for latest neo4j-graphrag
        # result = rag.search(query_text=query)
        # result = retriever.search(query_text=query)
        # Query the graph

        result = vectorrag.search(query_text=query, retriever_config={"top_k": 5})
        print(result.answer)

        print (result)

        # ✅ Extract fields safely
        cypher_query = getattr(result, "cypher_query", None)
        graph_data = getattr(result, "records", None)

        if not cypher_query:
            return {"error": "No Cypher generated", "raw": str(result)}

        # ✅ Execute Cypher via standard Neo4j session
        with driver.session() as session:
            data_rows = session.run(cypher_query)
            final_data = [record.data() for record in data_rows]

        return {
            "input": query,
            "cypher": cypher_query,
            "graphData": _normalize_retriever_output(final_data)
        }

    except Exception as e:
        return {"error": str(e)}



# -----------------------
# Tool: health
# -----------------------
@mcp.tool(name="health")
def health_check():
    try:
        with driver.session(default_access_mode="READ") as session:
            val = session.run("RETURN 1 AS ok").single()
            ok = bool(val and val["ok"] == 1 or val["ok"] is True)
        return {"ok": True, "neo4j": ok}
    except Exception as e:
        return {"ok": False, "error": str(e), "trace": traceback.format_exc()}

# -----------------------
# Start server
# -----------------------
if __name__ == "__main__":
    print(f"🚀 Starting FastMCP Neo4j MCP Server on port {MCP_PORT} ...")
    mcp.run(
           transport="http",   # Serve via HTTP transport
           host="0.0.0.0",
           port=8005
           )
