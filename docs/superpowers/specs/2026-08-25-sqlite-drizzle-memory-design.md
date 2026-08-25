# SQLite + Drizzle Memory Architecture Design

## Overview
This document outlines the design for implementing a cognitive memory system in Yggdrasil using SQLite and Drizzle ORM. The system will provide layered memory storage (working, episodic, and semantic) with auto-compaction and summarization capabilities.

## Goals
- Replace localStorage-based chat storage with SQLite-backed persistence
- Implement a three-tier memory system (working, episodic, semantic) to model human memory patterns
- Provide both vector search and full-text search capabilities using sqlite-vec and FTS5
- Enable automatic memory consolidation and summarization
- Maintain performance with Write-Ahead Logging (WAL) mode for concurrent access

## Architecture

### Database Schema
The system uses three primary memory tables with corresponding FTS5 virtual tables and sqlite-vec for vector operations:

#### Working Memory
- **Purpose**: Short-term context for active sessions
- **Fields**:
  - `id`: Unique identifier
  - `content`: The actual memory content
  - `embedding`: Vector embedding stored as BLOB for sqlite-vec
  - `contextTags`: Tags for context injection (JSON array)
  - `expiresAt`: Timestamp when this memory expires (calculated from TTL)
  - `createdAt`: Creation timestamp

#### Episodic Memory
- **Purpose**: Timestamped events and conversations
- **Fields**:
  - `id`: Unique identifier
  - `sessionId`: Associated session ID
  - `content`: The memory content
  - `embedding`: Vector embedding stored as BLOB for sqlite-vec
  - `importance`: 0.0-1.0 importance score
  - `accessCount`: Number of times accessed
  - `lastAccessedAt`: Last access timestamp
  - `tags`: Semantic tags (JSON array)
  - `metadata`: Additional metadata (JSON)
  - `createdAt`: Creation timestamp
  - `consolidatedInto`: ID of semantic memory this was consolidated into

#### Semantic Memory
- **Purpose**: Extracted facts and knowledge
- **Fields**:
  - `id`: Unique identifier
  - `content`: Consolidated knowledge
  - `embedding`: Vector embedding stored as BLOB for sqlite-vec
  - `importance`: 0.0-1.0 importance score
  - `accessCount`: Number of times accessed
  - `lastAccessedAt`: Last access timestamp
  - `tags`: Semantic tags (JSON array)
  - `sources`: Source episodic memory IDs (JSON array)
  - `metadata`: Additional metadata (JSON)
  - `createdAt`: Creation timestamp
  - `updatedAt`: Last update timestamp

#### Memory Relations
- **Purpose**: Track relationships between memories
- **Fields**:
  - `id`: Unique identifier
  - `fromMemoryId`: Source memory ID
  - `fromMemoryType`: Source memory type ('working'|'episodic'|'semantic')
  - `toMemoryId`: Target memory ID
  - `toMemoryType`: Target memory type ('working'|'episodic'|'semantic')
  - `relationType`: Type of relation (e.g., "related_to", "follows_from", "causes", "part_of")
  - `strength`: 0.0-1.0 relation strength
  - `createdAt`: Creation timestamp

#### Chat Sessions and Messages
- **Chat Sessions**:
  - `id`: Unique identifier
  - `title`: Human-readable title
  - `createdAt`: Creation timestamp
  - `updatedAt`: Last update timestamp

- **Chat Messages**:
  - `id`: Unique identifier
  - `sessionId`: References chat_sessions.id
  - `role`: 'user' | 'assistant' | 'system'
  - `content`: Message content
  - `metadata`: Usage stats, tool calls, etc. (JSON)
  - `createdAt`: Creation timestamp
  - `embeddedInMemory`: ID of associated episodic memory

### FTS5 and Vector Search Integration
- **FTS5 Virtual Tables**: External content tables linked to primary tables via triggers for automatic synchronization
- **Vector Search**: sqlite-vec extension for vector similarity operations
- **Hybrid Search**: Reciprocal Rank Fusion (RRF) to combine FTS5 (BM25) and vector search results

### Database Connection and Initialization
- **Engine**: better-sqlite3 with WAL mode enabled
- **Pragmas**: 
  - `journal_mode = WAL` for concurrent reads/writes
  - `synchronous = NORMAL` for performance
  - `foreign_keys = ON` for referential integrity
- **Migration**: Automatic schema migration using drizzle-kit

## Memory Pipeline

### Ingestion Process
1. **Raw Input Processing**: Incoming content is processed and prepared for memory storage
2. **Duplicate Detection**: Check for similar existing memories to prevent redundancy
3. **Classification**: Determine memory type (working, episodic, semantic) based on content and context
4. **Embedding Generation**: Create vector embeddings using the existing vLLM-compatible endpoint
5. **Storage**: Insert into appropriate memory table with FTS5 and vector indexing

### Working Memory Management
- **Automatic Injection**: Relevant working memories are automatically injected into active LLM prompts
- **TTL-Based Eviction**: Lazy eviction based on expiresAt timestamp (filtered on read)
- **Size Limits**: Configurable limits to prevent unbounded growth

### Episodic Memory Consolidation
- **Background Process**: Periodic consolidation triggered during idle periods
- **Clustering Algorithm**: Group similar episodic memories using vector similarity (cosine > 0.85) within time windows
- **Summarization**: Use LLM to create semantic memories from clustered episodic memories
- **Relationship Extraction**: Identify and store connections between consolidated memories

### Auto-Compaction and Summarization
- **Importance Scoring**: Multi-factor importance calculation (access frequency, recency, content type)
- **Periodic Consolidation**: Background process runs every 5 minutes during idle periods
- **Summary Generation**: Create higher-level summaries from clusters of related memories
- **Pruning**: Remove low-importance memories when storage thresholds are reached

## Retrieval Strategy

### Hybrid Search Implementation
- **Keyword Search**: FTS5 for exact matches and term-based retrieval
- **Semantic Search**: Vector similarity for concept-based retrieval
- **Rank Fusion**: Reciprocal Rank Fusion to combine results from multiple search methods
- **Contextual Filtering**: Filter results based on memory type, time range, and relevance to current session

### Memory Injection
- **Working Memory**: Automatically injected into active LLM prompts based on relevance
- **Long-term Memory**: Retrieved on-demand using hybrid search for context augmentation
- **Entity Linking**: Use memory relations to provide connected context

## Implementation Phases

### Phase 1: Basic Infrastructure
1. Set up Drizzle ORM with SQLite and sqlite-vec
2. Create schema with triggers for FTS5 synchronization
3. Implement basic CRUD operations for all memory types
4. Set up database connection with WAL mode and proper pragmas

### Phase 2: Ingestion Pipeline
1. Implement embedding generation using existing vLLM endpoint
2. Create ingestion workflow with classification and duplicate detection
3. Set up FTS5 virtual tables with sync triggers
4. Implement working memory TTL management

### Phase 3: Retrieval System
1. Implement hybrid search with RRF
2. Create memory injection mechanisms for LLM prompts
3. Add entity relationship tracking
4. Implement basic consolidation triggers

### Phase 4: Advanced Features
1. Implement periodic consolidation and summarization
2. Add importance scoring and pruning mechanisms
3. Create memory visualization and management tools
4. Add backup and recovery procedures

## Technical Considerations
- Use sqlite-vec for vector storage and similarity search since SQLite doesn't have native vector types
- Implement FTS5 synchronization using triggers to keep virtual tables in sync
- Handle vector queries with raw SQL since Drizzle ORM doesn't support vector operations natively
- Ensure proper error handling for database connection issues
- Validate memory content before storage
- Implement proper backup and recovery procedures

## Security Considerations
- Input sanitization for all user-generated content
- Parameterized queries to prevent SQL injection
- Proper isolation of different memory types
- Secure handling of sensitive information in memories
</ARG