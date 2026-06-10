# Task: Extend Azure DevOps MCP Server — Hyperlink Support

## Context

Our Azure DevOps MCP server (`user-ado-dbx-haprotec`) currently supports only **internal work item links** (Parent, Child, Related, Predecessor, Successor) via `targetId` + `linkType`.

It does NOT support **external Hyperlinks** (e.g. GitLab Merge Requests), which are a separate relation type in Azure DevOps:

```json
{
  "op": "add",
  "path": "/relations/-",
  "value": {
    "rel": "Hyperlink",
    "url": "https://gitlab.ad.haprotec.de/customers/siemens-mobility-gmbh-braunschweig/p23-001431-lackierlinie/-/merge_requests/18"
  }
}
```

Reference: https://learn.microsoft.com/en-us/rest/api/azure/devops/wit/work-items/update

## Goal

Extend the existing link tools so agents can read, add, and remove **both** work item links and external hyperlinks — without breaking the current API for existing callers.

## Architecture Decision (follow this)

- **Dedicated link tools** are the single write path for all relations.
- `get_work_item` should include relations (read-only summary).
- `update_work_item` must NOT be extended for hyperlink management.

| Tool | Hyperlinks lesen | Hyperlinks schreiben |
|---|---|---|
| `get_work_item` | Ja (als `relations`-Zusammenfassung) | — |
| `get_work_item_links` | Ja (vollständig, alle Typen) | — |
| `add_work_item_links` | — | Ja (Work-Item + Hyperlink) |
| `remove_work_item_links` | — | Ja (Work-Item + Hyperlink) |
| `update_work_item` | — | Nein |

## Required Changes

### 1. `azure_devops_get_work_item`

- Fetch work item with `$expand=Relations` (or `All`).
- Include a normalized `relations` array in the response:

```typescript
interface WorkItemRelation {
  type: "workItem" | "hyperlink" | "other";
  rel: string;                    // raw ADO rel, e.g. "Hyperlink" or "System.LinkTypes.Hierarchy-Forward"
  url: string;
  targetId?: number;              // only for workItem type (parse from URL)
  linkType?: string;              // human-readable: "Parent", "Child", "Related", "Hyperlink", etc.
  attributes?: Record<string, unknown>; // e.g. comment, isLocked
}
```

- Group optionally in response:
  - `workItemLinks[]`
  - `hyperlinks[]`

### 2. `azure_devops_get_work_item_links`

- Return ALL relations, not only work item hierarchy/dependency links.
- Currently missing: `rel: "Hyperlink"` entries.
- Normalize output same as above.
- Update tool description to explicitly mention Hyperlink support.

### 3. `azure_devops_add_work_item_links`

Extend `links[]` items to a **discriminated union**:

```typescript
// Option A — work item link (existing, keep backward compatible)
{
  "kind": "workItem",       // optional, default if targetId present
  "targetId": 207,
  "linkType": "Parent"      // Related | Parent | Child | Predecessor | Successor
}

// Option B — external hyperlink (new)
{
  "kind": "hyperlink",
  "url": "https://gitlab.ad.haprotec.de/.../merge_requests/18",
  "comment": "Merge Request for review"   // optional, maps to attributes.comment
}
```

Implementation:

- For `kind: "hyperlink"` → PATCH with `rel: "Hyperlink"`.
- Validate URL format (must start with `http://` or `https://`).
- Prevent duplicate hyperlinks (same URL on same work item).
- Keep backward compatibility: if only `targetId` + `linkType` provided, treat as work item link.

### 4. `azure_devops_remove_work_item_links`

Extend removal to support hyperlinks:

```typescript
// Remove work item link (existing)
{ "kind": "workItem", "targetId": 207, "linkType": "Parent" }

// Remove hyperlink (new) — match by URL
{ "kind": "hyperlink", "url": "https://gitlab.ad.haprotec.de/.../merge_requests/18" }
```

Implementation:

- Fetch current relations first.
- Find relation index by matching `rel` + `url` (for hyperlinks) or `rel` + parsed `targetId` (for work items).
- PATCH with `{ "op": "remove", "path": "/relations/{index}" }`.
- Return clear error if link not found.

### 5. `azure_devops_update_work_item`

- Do NOT add hyperlink parameters.
- Update description: "For link management, use add_work_item_links / remove_work_item_links."

## Azure DevOps REST API Details

**Add hyperlink:**

```
PATCH https://dev.azure.com/{org}/_apis/wit/workitems/{id}?api-version=7.1
Content-Type: application/json-patch+json

[
  { "op": "add", "path": "/relations/-", "value": { "rel": "Hyperlink", "url": "https://..." } }
]
```

**Get relations:**

```
GET https://dev.azure.com/{org}/_apis/wit/workitems/{id}?$expand=Relations&api-version=7.1
```

**Remove relation:**

```
[
  { "op": "remove", "path": "/relations/2" }
]
```

Relation index is 0-based in the `relations` array. Always fetch fresh before remove.

## Link Type Mapping (work items)

| Input linkType | ADO rel |
|---|---|
| Parent | System.LinkTypes.Hierarchy-Reverse |
| Child | System.LinkTypes.Hierarchy-Forward |
| Related | System.LinkTypes.Related |
| Predecessor | System.LinkTypes.Dependency-Reverse |
| Successor | System.LinkTypes.Dependency-Forward |

## Tests / Acceptance Criteria

1. `get_work_item(451)` returns existing hyperlinks in `relations` / `hyperlinks`.
2. `get_work_item_links(451)` returns hyperlinks alongside work item links.
3. `add_work_item_links(451, [{ kind: "hyperlink", url: "https://gitlab.../merge_requests/18" }])` succeeds.
4. Duplicate add of same URL returns a clear, non-destructive error.
5. `remove_work_item_links(451, [{ kind: "hyperlink", url: "https://..." }])` succeeds.
6. Existing work item link operations (targetId + linkType) remain unchanged.
7. Tool JSON schemas updated with `oneOf` / discriminated union and clear descriptions.

## Real-World Use Case

Task 451 ("Umsetzung") under PBI 207 needs a GitLab MR link for code review:

`https://gitlab.ad.haprotec.de/customers/siemens-mobility-gmbh-braunschweig/p23-001431-lackierlinie/-/merge_requests/18`

Agent workflow after this change:

1. `get_work_item(451)` → check if MR link already exists
2. `add_work_item_links(451, [{ kind: "hyperlink", url: "..." }])` → add if missing
3. `get_work_item_links(451)` → verify

## Non-Goals

- Do not add new separate tools like `add_hyperlink` — extend existing link tools.
- Do not modify Azure DevOps process templates or UI layout.
- Do not add hyperlink support to `update_work_item`.

## Deliverables

- Updated MCP tool implementations
- Updated JSON schemas for all affected tools
- Unit/integration tests for hyperlink add/remove/read
- Brief changelog entry
