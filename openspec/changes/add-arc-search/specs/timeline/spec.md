# Timeline — Arc Search

## ADDED Requirements

### Requirement: Arc semantic + calendar search endpoint

The system SHALL provide `POST /v1/timelines/arc/search`, agent-scoped and behind the same guards as the rest of `TimelineController` (`ApiKeyOrJwtGuard`, `RateLimitGuard`), that returns arcs ranked by relevance to an optional semantic query and/or restricted to an optional calendar window.

The request body SHALL accept `query?: string`, `from?: string` (ISO date), `to?: string` (ISO date), `limit?: number` (default 10, max 50), and `lod?: 'index'|'summary'|'standard'` (default `summary`). At least one of `query`, `from`, `to` MUST be present.

Each returned arc SHALL include `arcId`, a representative `title`, a representative `summary` at the requested LOD, `from`, `to`, `dayCount`, and a numeric `score`.

#### Scenario: Semantic query ranks the most relevant arc first

- **GIVEN** two closed arcs for an agent covering distinct topics
- **WHEN** the agent calls `POST /v1/timelines/arc/search` with a `query` describing the first arc's topic
- **THEN** the response `arcs[0].arcId` is the first arc
- **AND** each arc reports its correct `from`, `to`, and `dayCount`

#### Scenario: Calendar window restricts results

- **GIVEN** arcs in March and in September for an agent
- **WHEN** the agent searches with `from`/`to` bounding only March
- **THEN** only arcs overlapping the March window are returned

#### Scenario: Hybrid query plus window intersects both constraints

- **GIVEN** multiple arcs across the year
- **WHEN** the agent searches with both a `query` and a date window
- **THEN** results are limited to arcs within the window, ranked by similarity to the query

#### Scenario: Empty search is rejected

- **WHEN** the agent calls the endpoint with none of `query`, `from`, `to`
- **THEN** the API responds `400 Bad Request`

#### Scenario: Vector query is injection-safe

- **WHEN** the search executes its pgvector similarity query
- **THEN** the query embedding and all user inputs are passed as bound parameters
- **AND** no user-supplied value is string-interpolated into SQL
