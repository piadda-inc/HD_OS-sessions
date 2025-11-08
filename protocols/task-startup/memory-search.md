# Memory Search (GraphitiLocal)

Before starting work on this task, search the knowledge graph memory for relevant context.

## Memory Search Process

Use the graphiti_local Python API to search for relevant facts:

```python
import asyncio
from graphiti_local.session import GraphitiSession
from graphiti_local.operations.search import search_memory_facts

async def search_task_memory(task_title: str):
    try:
        async with GraphitiSession() as session:
            results = await search_memory_facts(
                client=session.graphiti,
                query=task_title,
                group_ids=[session.config.group_id],
                max_facts=5,
            )

            if results.get('facts'):
                print("\n## 📚 Relevant Memory\n")
                for fact in results['facts'][:5]:
                    fact_text = fact.get('fact', 'N/A')
                    episode = fact.get('episode_name', 'Unknown source')
                    print(f"- {fact_text}")
                    print(f"  (from: {episode})\n")
            else:
                print("\n## 📚 Memory Search\n")
                print("No relevant prior work found in memory.\n")
    except Exception as e:
        # Silently fail if memory not available
        pass

# Execute search with task title
asyncio.run(search_task_memory("{task_title}"))
```

## What to Look For

When memory results appear:
- **Prior implementations** of similar features
- **Past decisions** about architecture or technology choices
- **Bug fixes** related to this area of the codebase
- **Lessons learned** from previous work
- **Gotchas** or pitfalls to avoid

## If No Results

If no memory is found, this task may be:
- Working in a new area of the codebase
- The first time addressing this type of issue
- Using features not yet documented in memory

Proceed normally and consider storing an episode after completion to help future work.

## Memory Not Available

If graphiti_local is not configured or FalkorDB is not running, skip this step silently. Memory is optional but helpful when available.

**Prerequisites for memory:**
- FalkorDB running: `docker compose -f local/docker-compose.local.yml up -d`
- Environment configured: `cd local && python3 run_local.py init`

See `@local/CLAUDE.memory.md` for complete documentation.
