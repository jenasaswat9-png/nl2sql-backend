"""
backend/database.py

SQLite plumbing for the Text-to-SQL multi-agent system:

1. get_connection()      - read-only connection to the default or an uploaded DB
2. save_uploaded_file()  - validates and stores an ephemeral BYOD upload
3. get_table_schemas()   - extracts individual table DDLs for the RAG Vector Store
4. get_schema_ddl()      - builds a combined DDL string for legacy zero-shot nodes
5. is_read_only()        - regex-based security guard with a timestamped audit log
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Optional, Union

# --------------------------------------------------------------------------- #
# Paths & constants
# --------------------------------------------------------------------------- #

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB_PATH = PROJECT_ROOT / "data" / "northwind.db"
AUDIT_LOG_PATH = PROJECT_ROOT / "security_audit.log"

UPLOAD_ROOT = Path(tempfile.gettempdir()) / "text2sql_uploads"

ALLOWED_UPLOAD_EXTENSIONS = {".db", ".sqlite", ".sqlite3"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB
SQLITE_MAGIC_HEADER = b"SQLite format 3\x00"

PathLike = Union[str, "os.PathLike[str]"]


# --------------------------------------------------------------------------- #
# 1. Connection
# --------------------------------------------------------------------------- #

def get_connection(db_path: Optional[PathLike] = None) -> sqlite3.Connection:
    path = Path(db_path).resolve() if db_path else DEFAULT_DB_PATH.resolve()
    if not path.is_file():
        raise FileNotFoundError(f"Database file not found: {path}")

    conn = sqlite3.connect(
        f"{path.as_uri()}?mode=ro", uri=True, check_same_thread=False
    )
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA query_only = ON")
    return conn


# --------------------------------------------------------------------------- #
# 2. Upload handling (BYOD)
# --------------------------------------------------------------------------- #

def save_uploaded_file(file_bytes: bytes, filename: str = "upload.db") -> str:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_UPLOAD_EXTENSIONS:
        raise ValueError(
            f"Unsupported file type '{suffix}'. "
            f"Allowed: {', '.join(sorted(ALLOWED_UPLOAD_EXTENSIONS))}"
        )
    if not file_bytes:
        raise ValueError("Uploaded file is empty.")
    if len(file_bytes) > MAX_UPLOAD_BYTES:
        raise ValueError(
            f"File too large ({len(file_bytes)} bytes). "
            f"Limit is {MAX_UPLOAD_BYTES} bytes."
        )
    if not file_bytes.startswith(SQLITE_MAGIC_HEADER):
        raise ValueError("File is not a valid SQLite database (bad header).")

    safe_name = re.sub(r"[^A-Za-z0-9._-]", "_", Path(filename).name) or "upload.db"

    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    upload_dir = Path(tempfile.mkdtemp(prefix="upload_", dir=UPLOAD_ROOT))
    saved_path = upload_dir / safe_name

    try:
        saved_path.write_bytes(file_bytes)
        conn = get_connection(saved_path)
        try:
            conn.execute("SELECT name FROM sqlite_master LIMIT 1").fetchall()
        finally:
            conn.close()
    except (sqlite3.DatabaseError, OSError) as exc:
        shutil.rmtree(upload_dir, ignore_errors=True)
        raise ValueError(f"Could not open uploaded database: {exc}") from exc

    return str(saved_path)


def delete_uploaded_file(db_path: PathLike) -> bool:
    path = Path(db_path).resolve()
    if UPLOAD_ROOT.resolve() not in path.parents:
        return False
    shutil.rmtree(path.parent, ignore_errors=True)
    return True


# --------------------------------------------------------------------------- #
# 3. Dynamic schema extraction for RAG
# --------------------------------------------------------------------------- #

def _quote(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def get_table_schemas(db_path: Optional[PathLike] = None) -> dict[str, str]:
    """
    Return a dictionary mapping table/view names to their complete CREATE DDL.
    This allows the RAG vector store to embed individual tables for schema pruning.
    """
    conn = get_connection(db_path)
    try:
        objects = conn.execute(
            """
            SELECT type, name, sql
            FROM sqlite_master
            WHERE type IN ('table', 'view')
              AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
            ORDER BY type, name
            """
        ).fetchall()

        schema_dict: dict[str, str] = {}

        for obj in objects:
            name = obj["name"]

            if obj["type"] == "view":
                if obj["sql"]:
                    schema_dict[name] = obj["sql"].rstrip().rstrip(";") + ";"
                continue

            columns = conn.execute(
                'SELECT cid, name, type, "notnull", dflt_value, pk '
                "FROM pragma_table_info(?) ORDER BY cid",
                (name,),
            ).fetchall()

            pk_columns = sorted(
                (c for c in columns if c["pk"] > 0), key=lambda c: c["pk"]
            )
            single_pk = len(pk_columns) == 1

            lines: list[str] = []
            for col in columns:
                parts = [_quote(col["name"])]
                if col["type"]:
                    parts.append(col["type"])
                if single_pk and col["pk"] > 0:
                    parts.append("PRIMARY KEY")
                if col["notnull"]:
                    parts.append("NOT NULL")
                if col["dflt_value"] is not None:
                    parts.append(f"DEFAULT {col['dflt_value']}")
                lines.append(" ".join(parts))

            if len(pk_columns) > 1:
                pk_list = ", ".join(_quote(c["name"]) for c in pk_columns)
                lines.append(f"PRIMARY KEY ({pk_list})")

            fk_rows = conn.execute(
                'SELECT id, seq, "table", "from", "to" '
                "FROM pragma_foreign_key_list(?) ORDER BY id, seq",
                (name,),
            ).fetchall()

            fks: dict[int, dict] = {}
            for fk in fk_rows:
                entry = fks.setdefault(
                    fk["id"], {"table": fk["table"], "from": [], "to": []}
                )
                entry["from"].append(fk["from"])
                if fk["to"]:
                    entry["to"].append(fk["to"])

            for fk in fks.values():
                local = ", ".join(_quote(c) for c in fk["from"])
                clause = f"FOREIGN KEY ({local}) REFERENCES {_quote(fk['table'])}"
                if fk["to"]:
                    clause += " (" + ", ".join(_quote(c) for c in fk["to"]) + ")"
                lines.append(clause)

            body = ",\n  ".join(lines)
            schema_dict[name] = f"CREATE TABLE {_quote(name)} (\n  {body}\n);"

        return schema_dict
    finally:
        conn.close()


def get_schema_ddl(db_path: Optional[PathLike] = None) -> str:
    """
    Return a unified DDL string describing the active DB.
    """
    schemas = get_table_schemas(db_path)
    if not schemas:
        return "-- No user tables found in this database."
    return "\n\n".join(schemas.values())


# --------------------------------------------------------------------------- #
# 4. Security guard + audit log
# --------------------------------------------------------------------------- #

def _build_audit_logger() -> logging.Logger:
    logger = logging.getLogger("text2sql.security_audit")
    if not logger.handlers:
        handler = logging.FileHandler(AUDIT_LOG_PATH, encoding="utf-8")
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s | %(levelname)s | %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
        )
        logger.addHandler(handler)
        logger.setLevel(logging.INFO)
        logger.propagate = False
    return logger


_audit_logger = _build_audit_logger()

def _audit_block(reason: str, query: object) -> None:
    text = query if isinstance(query, str) else repr(query)
    snippet = re.sub(r"\s+", " ", text).strip()[:500]
    _audit_logger.warning("BLOCKED | reason=%s | query=%s", reason, snippet)

_NOISE_PATTERN = re.compile(
    r"""
      --[^\n]*                  
    | /\*.*?(?:\*/|\Z)          
    | '(?:[^']|'')*'            
    | "(?:[^"]|"")*"            
    | `(?:[^`]|``)*`            
    | \[[^\]\n]*\]              
    """,
    re.DOTALL | re.VERBOSE,
)

_BLOCKED_PATTERN = re.compile(
    r"\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b|\b(REPLACE)\s+INTO\b",
    re.IGNORECASE,
)

_READ_START_PATTERN = re.compile(r"(SELECT|WITH)\b", re.IGNORECASE)

def is_read_only(query: str) -> bool:
    if not isinstance(query, str) or not query.strip():
        _audit_block("empty or non-string query", query)
        return False

    cleaned = _NOISE_PATTERN.sub(" ", query)
    match = _BLOCKED_PATTERN.search(cleaned)
    if match:
        keyword = (match.group(1) or match.group(2)).upper()
        _audit_block(f"blocked keyword {keyword}", query)
        return False

    statement = cleaned.strip().rstrip(";").strip()
    if ";" in statement:
        _audit_block("multiple statements", query)
        return False

    if not _READ_START_PATTERN.match(statement):
        _audit_block("statement does not start with SELECT/WITH", query)
        return False

    return True