# Memory Storage Prompt (GraphitiLocal)

After completing this task, consider storing the work in knowledge graph memory for future reference.

## Why Store in Memory?

Storing episodes helps you (and future Claude instances):
- **Remember decisions** made during implementation
- **Avoid duplicating work** on similar tasks
- **Share knowledge** across sessions
- **Build institutional memory** of the codebase

## When to Store

**DO store episodes for:**
- ✓ Major features implemented
- ✓ Architectural decisions made
- ✓ Bug fixes with valuable lessons
- ✓ Refactoring work that changed patterns
- ✓ Performance optimizations
- ✓ Security findings or fixes
- ✓ API design decisions
- ✓ Testing strategies that worked well

**DON'T store episodes for:**
- ✗ Trivial changes (typos, formatting)
- ✗ Temporary debugging code
- ✗ Exploratory work that didn't lead anywhere
- ✗ Simple documentation updates
- ✗ Automated changes (dependency updates)

## How to Store

Use the graphiti_local Python API:

```python
import asyncio
from graphiti_local.session import GraphitiSession
from graphiti_local.operations.episodes import add_episode_sync

async def store_episode():
    async with GraphitiSession() as session:
        result = await add_episode_sync(
            client=session.graphiti,
            name="Task: [Brief title of what was accomplished]",
            episode_body="""
## What
Brief description of what was done.

## Why
Rationale and context for decisions made.

## How
Technical approach and implementation details.

## Files
- path/to/file1.py
- path/to/file2.ts

## Decisions
Key choices made and alternatives considered.

## Next Steps
Follow-up work or considerations for future tasks.
            """,
            source_description="claude_code",
            group_id=session.config.group_id,
        )
        print(f"✓ Episode stored: {result.get('episode_uuid', 'N/A')}")

asyncio.run(store_episode())
```

## Episode Naming Convention

Use consistent prefixes for easy searching:
- `Task: <description>` - Completed implementation work
- `Decision: <choice>` - Architectural or technical decisions
- `Bug: <summary>` - Bug fixes and their root causes
- `Review: <context>` - Code review findings
- `Learning: <topic>` - Insights and discoveries
- `Refactor: <area>` - Refactoring work

## Example Episode

```python
name = "Task: Implemented JWT authentication with refresh tokens"

episode_body = """
## What
Added JWT-based authentication system with refresh token support.

## Why
Previous session-based auth didn't scale across multiple servers.
JWT tokens allow stateless authentication and horizontal scaling.

## How
- Created AuthService with token generation/validation
- Implemented refresh token rotation for security
- Added middleware to verify tokens on protected routes
- Used RS256 signing with rotating keys

## Files
- backend/services/auth_service.py
- backend/middleware/auth_middleware.py
- backend/models/refresh_token.py
- tests/test_auth_flow.py

## Decisions
- Chose RS256 over HS256 for better key management
- Refresh token TTL set to 30 days (vs 7 days alternative)
- Stored refresh tokens in database (not Redis) for audit trail

## Next Steps
- Add rate limiting to token endpoint
- Consider implementing token revocation list
- Add metrics for auth failures
"""
```

## Memory Not Available

If graphiti_local is not configured, you can still document your work in:
- Task work logs (maintained by logging agent)
- Commit messages (descriptive commits)
- Code comments (inline documentation)

**To enable memory:**
```bash
cd /home/heliosuser/piadda-mvp/graphiti-memory-stack/local
python3 run_local.py init
docker compose -f docker-compose.local.yml up -d
```

See `@local/CLAUDE.memory.md` for complete documentation.

---

**Reminder:** Storing episodes is optional but highly recommended for non-trivial work. Future Claude instances will thank you!
