# Task: Fix an Issue

## Trigger
Test failure, bug report, health degradation, or CI failure

## Input
- Error description and/or stack trace
- Affected file(s)

## Instructions
1. Read the error and affected files
2. Query engram-code for related code:
   `POST http://localhost:3002/v1/search {"query": "<error context>", "projectId": "af22c027-7495-46d7-9c4d-d0d89e07a1bb", "limit": 10}`
3. Query Engram for similar past issues:
   `POST http://localhost:3001/v1/recall {"query": "<error description>", "limit": 5}`
   Headers: X-AM-API-Key: eg_sk_your_key_here, X-AM-User-ID: user_123
4. Identify root cause
5. Implement fix
6. Add regression test
7. Verify all tests pass

## Constraints
- Minimal change — fix the bug, don't refactor
- Always add a regression test
- Check if the same bug exists elsewhere (search for similar patterns)
- If the fix touches auth or data, flag for human review
