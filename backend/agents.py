"""
backend/agents.py

LangGraph pipeline for the Text-to-SQL multi-agent system (RAG Upgraded).

    START -> profiler -> generator -> executor --(error & retries < 3)--> critic
                                          |                                 |
                                          +--(ok / security / cap hit)--> END
                                          ^---------------------------------+

Nodes
    profiler   - RAG Schema Pruner: Indexes tables to ChromaDB & retrieves top-K matches
    generator  - ChatGroq (openai/gpt-oss-120b) writes the first SQL attempt
    executor   - Execution Guard (is_read_only) + pandas.read_sql_query
    critic     - rewrites failed SQL using the error message (max 3 rewrites)
"""

from __future__ import annotations

import re
import sqlite3
from functools import lru_cache
from typing import Any, Optional, TypedDict

import pandas as pd
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_groq import ChatGroq
from langgraph.graph import END, START, StateGraph

from backend.database import (
    DEFAULT_DB_PATH,
    get_connection,
    get_table_schemas,
    is_read_only,
)
from backend.rag import SchemaPruner

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

# --------------------------------------------------------------------------- #
# Constants & Global RAG Engine
# --------------------------------------------------------------------------- #

MAX_RETRIES = 3
MAX_ROWS = 1000
SECURITY_PREFIX = "SECURITY_BLOCK:"

# Initialize the ChromaDB Schema Pruner (keeps top 5 most relevant tables)
pruner = SchemaPruner(top_k=5)

# --------------------------------------------------------------------------- #
# 1. State
# --------------------------------------------------------------------------- #

class AgentState(TypedDict):
    question: str
    db_path: str
    schema: str
    sql_query: str
    data_result: Optional[list[dict[str, Any]]]
    error_msg: str
    retries: int
    chart_config: Optional[dict[str, Any]]

# --------------------------------------------------------------------------- #
# LLM + helpers
# --------------------------------------------------------------------------- #

@lru_cache(maxsize=1)
def _get_llm() -> ChatGroq:
    """Master's-level reasoning engine with 120B parameters."""
    return ChatGroq(model="openai/gpt-oss-120b", temperature=0)

def _db_path(state: AgentState) -> Optional[str]:
    return state.get("db_path") or None

def _clean_sql(raw: str) -> str:
    text = raw.strip()
    fenced = re.search(r"```(?:sql|sqlite)?\s*(.*?)```", text, re.DOTALL | re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    start = re.search(r"^\s*(SELECT|WITH)\b", text, re.IGNORECASE | re.MULTILINE)
    if start:
        text = text[start.start():]
    return text.strip().rstrip(";").strip()

_SQL_RULES = """RULES:
1. Output ONLY the raw SQL query. No explanations, no comments, no markdown, no code fences.
2. Use ONLY tables and columns that appear in the schema. Never invent names.
3. Read-only: a single SELECT (or WITH ... SELECT). Never use INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, REPLACE or PRAGMA.
4. Use SQLite syntax (strftime for dates, || for concatenation, LIMIT for row limits).
5. Return ONLY the columns the question asks for. No extra columns.
6. When joining tables, join along the FOREIGN KEY relationships shown in the schema.
7. Match text values exactly as the question states them."""

# --------------------------------------------------------------------------- #
# 2. Profiler node (RAG Upgraded)
# --------------------------------------------------------------------------- #

def profiler_node(state: AgentState) -> dict:
    """
    RAG Schema Pruner: 
    1. Extracts individual table DDLs.
    2. Dynamically indexes them into ChromaDB.
    3. Retrieves only the tables semantically relevant to the question.
    """
    db_path = _db_path(state)
    
    # Get dictionary of {table_name: table_ddl}
    table_schemas = get_table_schemas(db_path)
    
    # Index into the vector store (automatically resets previous data)
    pruner.index_schema(table_schemas)
    
    # Semantic search to prune the schema context
    relevant_ddl = pruner.retrieve_relevant_schema(state["question"])
    
    return {"schema": relevant_ddl}

# --------------------------------------------------------------------------- #
# 3. Generator node
# --------------------------------------------------------------------------- #

def generator_node(state: AgentState) -> dict:
    system_prompt = f"""You are an expert SQLite analyst. Convert the user's question into ONE valid SQLite query.

RELEVANT DATABASE SCHEMA:
{state["schema"]}

{_SQL_RULES}

EXAMPLES:
Question: How many orders are there?
SQL: SELECT COUNT(*) FROM Orders
Question: List the names of customers from Germany.
SQL: SELECT CompanyName FROM Customers WHERE Country = 'Germany'"""

    response = _get_llm().invoke(
        [
            SystemMessage(content=system_prompt),
            HumanMessage(content=f"Question: {state['question']}\nSQL:"),
        ]
    )
    return {"sql_query": _clean_sql(str(response.content))}

# --------------------------------------------------------------------------- #
# 4. Executor node (Execution Guard + pandas)
# --------------------------------------------------------------------------- #

def executor_node(state: AgentState) -> dict:
    sql = state["sql_query"]

    if not is_read_only(sql):
        return {
            "data_result": None,
            "chart_config": None,
            "error_msg": f"{SECURITY_PREFIX} Query rejected by Execution Guard."
        }

    try:
        conn = get_connection(_db_path(state))
        try:
            df = pd.read_sql_query(sql, conn)
        finally:
            conn.close()
    except (sqlite3.Error, pd.errors.DatabaseError) as exc:
        root = exc.__cause__ or exc
        return {"data_result": None, "chart_config": None, "error_msg": f"{type(root).__name__}: {root}"}

    # Autonomous Chart Detection Logic
    chart_config = None
    if 2 <= len(df) <= 50: # Only chart if data is statistically meaningful
        num_cols = df.select_dtypes(include=['number']).columns.tolist()
        cat_cols = df.select_dtypes(exclude=['number']).columns.tolist()
        
        # Filter out ID columns from being plotted as values
        valid_nums = [c for c in num_cols if not str(c).lower().endswith('id')]
        
        if valid_nums and cat_cols:
            x_col = cat_cols[0]
            y_col = valid_nums[0]
            
            # Determine chart type based on question intent
            q_lower = state["question"].lower()
            c_type = 'bar'
            if any(w in q_lower for w in ['trend', 'time', 'year', 'month', 'date']):
                c_type = 'line'
            elif any(w in q_lower for w in ['proportion', 'share', 'percentage', 'ratio']):
                c_type = 'doughnut'
                
            chart_config = {"type": c_type, "x": x_col, "y": y_col}

    df = df.head(MAX_ROWS)
    records = df.astype(object).where(df.notna(), None).to_dict(orient="records")
    return {"data_result": records, "chart_config": chart_config, "error_msg": ""}

# --------------------------------------------------------------------------- #
# 5. Router + Critic
# --------------------------------------------------------------------------- #

def route_after_execution(state: AgentState) -> str:
    error = state.get("error_msg", "")
    if not error or error.startswith(SECURITY_PREFIX):
        return "end"
    if state.get("retries", 0) >= MAX_RETRIES:
        return "end"
    return "critic"

def critic_node(state: AgentState) -> dict:
    system_prompt = f"""You are a senior SQLite debugger. A query failed. Fix it so it answers the original question.

RELEVANT DATABASE SCHEMA:
{state["schema"]}

{_SQL_RULES}
8. Read the error carefully. For "no such column" or "no such table", use the exact names from the schema.
9. Output the corrected query only, never an explanation."""

    user_prompt = (
        f"Question: {state['question']}\n\n"
        f"Failed SQL:\n{state['sql_query']}\n\n"
        f"Error:\n{state['error_msg']}\n\n"
        "Corrected SQL:"
    )

    response = _get_llm().invoke(
        [SystemMessage(content=system_prompt), HumanMessage(content=user_prompt)]
    )
    return {
        "sql_query": _clean_sql(str(response.content)),
        "retries": state.get("retries", 0) + 1,
    }

# --------------------------------------------------------------------------- #
# Graph assembly
# --------------------------------------------------------------------------- #

def build_graph():
    workflow = StateGraph(AgentState)

    workflow.add_node("profiler", profiler_node)
    workflow.add_node("generator", generator_node)
    workflow.add_node("executor", executor_node)
    workflow.add_node("critic", critic_node)

    workflow.add_edge(START, "profiler")
    workflow.add_edge("profiler", "generator")
    workflow.add_edge("generator", "executor")
    workflow.add_conditional_edges(
        "executor",
        route_after_execution,
        {"critic": "critic", "end": END},
    )
    workflow.add_edge("critic", "executor")

    return workflow.compile()

graph = build_graph()

def run_pipeline(question: str, db_path: Optional[str] = None) -> AgentState:
    initial: AgentState = {
        "question": question,
        "db_path": str(db_path) if db_path else str(DEFAULT_DB_PATH),
        "schema": "",
        "sql_query": "",
        "data_result": None,
        "error_msg": "",
        "retries": 0,
    }
    return graph.invoke(initial)