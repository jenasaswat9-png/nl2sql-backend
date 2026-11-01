"""
backend/rag.py

Dynamic Schema Pruning using ChromaDB and FastEmbed.

This module initializes an in-memory vector store that holds the DDL of
individual database tables. When a question is asked, it retrieves only
the tables most semantically relevant to the question.
"""

from typing import Dict, List
import chromadb
from chromadb.api.models.Collection import Collection

# --------------------------------------------------------------------------- #
# Schema Pruner / RAG Engine
# --------------------------------------------------------------------------- #

class SchemaPruner:
    def __init__(self, top_k: int = 5):
        """
        Initialize the Schema Pruner with an ephemeral in-memory Chroma client.
        Data is stored in memory and lost when the program terminates.
        """
        self.top_k = top_k
        self.client = chromadb.Client()
        self.collection_name = "schema_collection"
        
        # Reset the collection if it exists from a previous database upload
        try:
            self.client.delete_collection(self.collection_name)
        except Exception:
            pass
            
        self.collection: Collection = self.client.create_collection(
            name=self.collection_name,
            # We use FastEmbed internally via Chroma's integration or let Chroma use its default ONNX model
            metadata={"hnsw:space": "cosine"}
        )
        self.is_indexed = False

    def index_schema(self, table_schemas: Dict[str, str]) -> None:
        """
        Takes a dictionary of table names -> table DDL strings.
        Embeds each table DDL into the Chroma collection.
        """
        if not table_schemas:
            self.is_indexed = False
            return

        documents: List[str] = []
        ids: List[str] = []

        for table_name, ddl in table_schemas.items():
            ids.append(table_name)
            documents.append(ddl)

        # Clear existing data if re-indexing a new uploaded database
        try:
            self.client.delete_collection(self.collection_name)
        except Exception:
            pass
            
        self.collection = self.client.create_collection(
            name=self.collection_name,
            metadata={"hnsw:space": "cosine"}
        )
        
        self.collection.add(
            documents=documents,
            ids=ids
        )
        self.is_indexed = True

    def retrieve_relevant_schema(self, question: str) -> str:
        """
        Embeds the user's question and retrieves the top-K most relevant 
        table DDLs from the vector store.
        """
        if not self.is_indexed:
            return "-- No schema indexed."

        # Query ChromaDB. It automatically embeds the query text.
        results = self.collection.query(
            query_texts=[question],
            n_results=self.top_k
        )

        if not results or not results['documents'] or not results['documents'][0]:
            return "-- No relevant tables found."

        # The results['documents'] is a list of lists. We grab the first batch.
        relevant_ddls = results['documents'][0]
        
        # Join the retrieved DDLs into a single string for the prompt
        return "\n\n".join(relevant_ddls)