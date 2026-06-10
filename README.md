# Cursor Azure DevOps MCP Server

[![CI](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/ci.yml)
[![Publish](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/publish.yml/badge.svg)](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/publish.yml)
[![Version Bump](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/version-bump.yml/badge.svg)](https://github.com/maximtitovich/cursor-azure-devops-mcp/actions/workflows/version-bump.yml)
[![npm version](https://img.shields.io/npm/v/cursor-azure-devops-mcp)](https://www.npmjs.com/package/cursor-azure-devops-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A Model Context Protocol (MCP) server for integrating Azure DevOps with Cursor IDE. This tool allows Claude AI in Cursor to interact with Azure DevOps, providing access to projects, work items, repositories, and pull requests.

## Features

- Get Azure DevOps projects
- Retrieve work items by ID
- Fetch multiple work items
- Create work items (Task, Bug, User Story, etc.)
- Update work items (title, state, assignee, and custom fields)
- Add and remove work item links (Related, Parent, Child, Predecessor, Successor) and external hyperlinks (e.g. GitLab merge requests)
- List repositories in a project
- Get pull requests for a repository
- View pull request details and threads
- Retrieve work item attachments (images, PDFs, and other files)
- Get work item comments with metadata (including mentions and reactions)
- Get detailed code changes for pull requests (view file contents before and after changes)
- Create comments on pull requests (with support for replying to existing comments)
- Test Plan Management:
  - List all test plans in a project
  - Get test plan details by ID
  - List test suites in a test plan
  - Get test suite details by ID
  - List test cases in a test suite
- Smart Response Handling:
  - Automatic truncation of large responses to fit AI model limits
  - Preservation of essential fields in truncated responses
  - Metadata about truncation status and original size
- Project Configuration:
  - Default project support from configuration
  - Fallback to configuration when project is not specified
  - Proper error handling for missing project information

## Changelog

### Version 1.4.0

#### Added
- External hyperlink support in `azure_devops_get_work_item`, `azure_devops_get_work_item_links`, `azure_devops_add_work_item_links`, and `azure_devops_remove_work_item_links`
- Normalized relation output with `relations`, `workItemLinks`, and `hyperlinks` arrays
- Unit tests for relation normalization and hyperlink patch logic (Vitest)

#### Changed (Breaking)
- `azure_devops_get_work_item_links` now returns a normalized `WorkItemRelationsSummary` instead of a grouped object keyed by ADO relation type

#### Fixed
- External hyperlinks are no longer returned by `azure_devops_get_work_item_attachments`

### Version 1.3.0

#### Added
- Work item link tools: `azure_devops_add_work_item_links`, `azure_devops_remove_work_item_links`
- Optional `links` array on `azure_devops_create_work_item` and `azure_devops_update_work_item`
- Supported link types: Related, Parent, Child, Predecessor, Successor (or full `System.LinkTypes.*` references)

### Version 1.2.0

#### Added
- Work item write tools: `azure_devops_create_work_item`, `azure_devops_update_work_item`

#### Changed (Breaking)
- Renamed all read/list MCP tools to use the `azure_devops_get_*` prefix for consistency with create/update tools
- `azure_devops_pull_request_by_id` renamed to `azure_devops_get_pull_request`

### Version 1.0.3

#### Added
- Test Plan Management Support:
  - New tool: `azure_devops_test_plans` - List all test plans for a project
  - New tool: `azure_devops_test_plan` - Get a test plan by ID
  - New tool: `azure_devops_test_suites` - List all test suites for a test plan
  - New tool: `azure_devops_test_suite` - Get a test suite by ID
  - New tool: `azure_devops_test_cases` - List all test cases for a test suite

#### Enhanced
- Response Size Management:
  - Added intelligent response truncation (max 50KB by default)
  - Preserved essential fields in truncated responses
  - Added truncation metadata in responses
- Project Configuration:
  - Added support for default project from configuration
  - Improved project parameter handling in all test-related methods
  - Added proper error handling for missing project information

#### Fixed
- Parameter ordering in test suite methods to comply with TypeScript requirements
- Error handling improvements in test-related API calls
- Response formatting for large test suite responses

## Installation

### Global Installation

```bash
npm install -g cursor-azure-devops-mcp
```

### Local Installation

```bash
npm install cursor-azure-devops-mcp
```

## Configuration

The server can be configured using multiple sources, with the following priority:

1. Command line arguments
2. VSCode/Cursor IDE settings
3. Environment variables / `.env` file
4. Default values

### Command Line Arguments

You can configure the server using command line arguments:

```bash
npx cursor-azure-devops-mcp --azure-org-url=https://dev.azure.com/your-organization --azure-token=your-token --azure-project=YourProject
```

Available options:

| Option | Alias | Description |
|--------|-------|-------------|
| `--azure-org-url` | `--org` | Azure DevOps organization URL |
| `--azure-token` | `--token` | Azure DevOps personal access token |
| `--azure-project` | `--project` | Default Azure DevOps project name |
| `--port` | `-p` | Server port (for HTTP mode) |
| `--host` | `-h` | Server hostname (for HTTP mode) |
| `--log-level` | `--log` | Logging level (error, warn, info, debug) |
| `--help` | `-?` | Show help |

### VSCode/Cursor IDE Settings

You can configure the server in your VSCode or Cursor IDE settings:

1. Global settings: `~/.vscode/settings.json` or `~/.cursor/settings.json`
2. Workspace settings: `.vscode/settings.json` or `.cursor/settings.json`

Example settings:

```json
{
  "azureDevOps.organization": "your-organization",
  "azureDevOps.token": "your-personal-access-token",
  "azureDevOps.project": "YourProject",
  "cursor-azure-devops-mcp": {
    "port": 3000,
    "logLevel": "info"
  }
}
```

### Environment Variables

Create a `.env` file in your project root with the following variables:

```
AZURE_DEVOPS_ORG_URL=https://dev.azure.com/your-organization
AZURE_DEVOPS_TOKEN=your-personal-access-token
AZURE_DEVOPS_PROJECT=YourProject
PORT=3000
LOG_LEVEL=info
```

You can also copy the provided `.env.example` file:

```bash
cp .env.example .env
```

Then edit the file with your Azure DevOps credentials.

## Usage

### Running with npx

The easiest way to use this MCP server is with npx:

```bash
npx cursor-azure-devops-mcp
```

### Setting up in Cursor IDE (Version 0.46.9+)

Cursor IDE supports two methods for connecting to MCP servers: Command mode and SSE mode.

#### Option 1: Command Mode (Recommended)

The Command mode runs the MCP server as a process directly from Cursor. This is the **most reliable method** and should be your first choice:

1. Open Cursor IDE
2. Go to Settings > Features > MCP Servers
3. Click "Add New MCP Server"
4. Enter a name for your server (e.g., "Azure DevOps")
5. Select "command" from the dropdown
6. Enter the command to run the server:
   ```
   cursor-azure-devops-mcp
   ```
   
   If you haven't installed it globally, you can use npx:
   ```
   npx cursor-azure-devops-mcp
   ```

7. Click "Add"

**Important**: When using Command mode, the server will automatically use your environment variables from your system or from a `.env` file in your current working directory. Make sure your `.env` file is properly set up with your Azure DevOps credentials.

**Troubleshooting Command Mode**:

If you encounter the error "server.setRequestHandler is not a function" or similar errors:
1. Make sure you have the latest version of the package installed
2. Try reinstalling the package: `npm install -g cursor-azure-devops-mcp`
3. Check that your `.env` file is correctly set up with your Azure DevOps credentials

#### Option 2: SSE Mode (Alternative)

**Note**: SSE mode is more prone to connection issues. If you're experiencing problems, please use Command mode instead.

The SSE mode connects to an HTTP server with Server-Sent Events:

1. First, start the HTTP server with SSE support:
   ```bash
   npm run sse-server
   ```
   or
   ```bash
   npx cursor-azure-devops-mcp-sse
   ```
   This will start a server on port 3000 by default.

2. Open Cursor IDE
3. Go to Settings > Features > MCP Servers
4. Click "Add New MCP Server"
5. Enter a name for your server (e.g., "Azure DevOps SSE")
6. Select "sse" from the dropdown
7. Enter the SSE endpoint URL:
   ```
   http://localhost:3000/sse
   ```
8. Click "Add"

### Windows Users

If you're using Windows and experiencing issues with the command mode, try this format:

```
cmd /k npx cursor-azure-devops-mcp
```

### mcp.json installation

```json
{
    "azure-devops": {
      "command": "cmd",
      "args": [
        "/c",
        "npx",
        "cursor-azure-devops-mcp",
        "--azure-org-url",
        "https://your-organization.visualstudio.com",
        "--azure-token",
        "your-personal-access-token",
        "--azure-project",
        "your-project"
      ]
    }
}
```

### Using in Your Code

```javascript
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { registerTools } = require('cursor-azure-devops-mcp');
const azureDevOpsService = require('cursor-azure-devops-mcp/lib/azure-devops-service');

// Create MCP server
const server = new McpServer({
  name: 'cursor-azure-devops-mcp',
  version: '1.0.0'
});

// Register Azure DevOps tools with the server
registerTools(server, azureDevOpsService);

// Connect to your transport of choice
// ...
```

## Available Tools

| Tool Name | Description | Required Parameters |
|-----------|-------------|-------------------|
| `azure_devops_get_projects` | Get all projects | None |
| `azure_devops_get_work_item` | Get a specific work item | `id` (number) |
| `azure_devops_get_work_items` | Get multiple work items | `ids` (array of numbers) |
| `azure_devops_create_work_item` | Create a new work item | `type` (string), `title` (string), optional: `project`, `description`, `state`, `assignedTo`, `areaPath`, `iterationPath`, `tags`, `parentId`, `links`, `fields` |
| `azure_devops_update_work_item` | Update an existing work item | `id` (number), optional: `project`, `title`, `description`, `state`, `assignedTo`, `areaPath`, `iterationPath`, `tags`, `links`, `fields` |
| `azure_devops_add_work_item_links` | Add links to a work item | `id` (number), `links` (array of `{ targetId, linkType }`), optional: `project` |
| `azure_devops_remove_work_item_links` | Remove links from a work item | `id` (number), `links` (array of `{ targetId, linkType }`), optional: `project` |
| `azure_devops_get_repositories` | Get repositories for a project | `project` (string) |
| `azure_devops_get_pull_requests` | Get pull requests from a repository | `repositoryId` (string), `project` (string) |
| `azure_devops_get_pull_request` | Get a specific pull request | `repositoryId` (string), `pullRequestId` (number), `project` (string) |
| `azure_devops_get_pull_request_threads` | Get threads from a pull request | `repositoryId` (string), `pullRequestId` (number), `project` (string) |
| `azure_devops_get_work_item_attachments` | Get attachments for a work item | `id` (number) |
| `azure_devops_get_work_item_comments` | Get comments for a work item | `id` (number) |
| `azure_devops_get_pull_request_changes` | Get detailed PR code changes | `repositoryId` (string), `pullRequestId` (number), `project` (string) |
| `azure_devops_get_pull_request_file_content` | Get content of a specific file in a pull request | `repositoryId` (string), `pullRequestId` (number), `filePath` (string), `objectId` (string), `project` (string), optional: `returnPlainText` (boolean), `startPosition` (number), `length` (number) |
| `azure_devops_get_branch_file_content` | Get file content directly from a branch | `repositoryId` (string), `branchName` (string), `filePath` (string), `project` (string), optional: `returnPlainText` (boolean), `startPosition` (number), `length` (number) |
| `azure_devops_create_pr_comment` | Create a comment on a pull request | `repositoryId` (string), `pullRequestId` (number), `project` (string), `content` (string), and other optional parameters |
| `azure_devops_get_test_plans` | List all test plans for a project | `project` (string) |
| `azure_devops_get_test_plan` | Get a test plan by ID | `project` (string), `testPlanId` (number) |
| `azure_devops_get_test_suites` | List all test suites for a test plan | `project` (string), `testPlanId` (number) |
| `azure_devops_get_test_suite` | Get a test suite by ID | `project` (string), `testPlanId` (number), `testSuiteId` (number) |
| `azure_devops_get_test_cases` | List all test cases for a test suite | `project` (string), `testPlanId` (number), `testSuiteId` (number) |

> **Note:** Creating and updating work items requires a Personal Access Token with **Work Items (read & write)** scope.

### Work Item Management

The work item write tools accept friendly field names and map them to Azure DevOps field references internally. Links use friendly link type names that map to Azure DevOps relation types.

**Supported link types:** `Related`, `Parent`, `Child`, `Predecessor`, `Successor` (or full `System.LinkTypes.*` references).

#### Example Usage:

**Create a task:**
```json
{
  "type": "Task",
  "title": "Implement login validation",
  "description": "<p>Add client-side and server-side validation.</p>",
  "assignedTo": "user@example.com"
}
```

**Create a task with multiple Related links:**
```json
{
  "type": "Task",
  "title": "Linked task",
  "links": [
    { "targetId": 100, "linkType": "Related" },
    { "targetId": 101, "linkType": "Related" }
  ]
}
```

**Create a child task linked to a parent:**
```json
{
  "type": "Task",
  "title": "Sub-task from MCP",
  "parentId": 12345
}
```

**Add links to an existing work item:**
```json
{
  "id": 12346,
  "links": [
    { "targetId": 200, "linkType": "Related" },
    { "targetId": 201, "linkType": "Parent" }
  ]
}
```

**Update work item state and add a Related link:**
```json
{
  "id": 12346,
  "state": "Active",
  "links": [{ "targetId": 300, "linkType": "Related" }]
}
```

**Remove a Related link:**
```json
{
  "id": 12346,
  "links": [{ "targetId": 300, "linkType": "Related" }]
}
```

**Update work item state only:**
```json
{
  "id": 12346,
  "state": "Active"
}
```

### Test Management Tools

The test management tools provide comprehensive access to Azure DevOps test plans, suites, and cases:

- **Automatic Project Handling**: All test tools support using the default project from configuration
- **Smart Response Truncation**: Large responses are automatically truncated to fit AI model limits while preserving essential information
- **Metadata Preservation**: Even in truncated responses, important metadata like IDs, names, and relationships are preserved
- **Error Handling**: Comprehensive error handling with detailed error messages

#### Example Usage:

**List all test plans in a project:**
```json
{
  "project": "YourProject"
}
```

**Get a specific test suite:**
```json
{
  "project": "YourProject",
  "testPlanId": 185735,
  "testSuiteId": 186771
}
```

**List test cases in a suite:**
```json
{
  "project": "YourProject",
  "testPlanId": 185735,
  "testSuiteId": 186771
}
```

When working with test management tools, you should:

1. First retrieve the test plans for your project using `azure_devops_get_test_plans`
2. Use a specific test plan ID to get test suites with `azure_devops_get_test_suites`
3. Finally, get test cases for a specific suite using `azure_devops_get_test_cases`

The response format includes truncation metadata when necessary:
```json
{
  "items": [...],
  "totalCount": 100,
  "isTruncated": true,
  "truncatedCount": 80,
  "message": "Response was truncated. Showing 20 of 100 items."
}
```