#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { azureDevOpsService } from './azure-devops-service.js';
import { configManager } from './config-manager.js';
import { createConnection } from 'net';

/**
 * Helper function to safely handle response serialization
 * preventing circular reference errors
 */
export function safeResponse(result: any) {
  // If the result is already a string, return it
  if (typeof result === 'string') {
    return result;
  }

  // Special case for file content responses with nested content property
  if (result && typeof result.content === 'string') {
    try {
      // Try to parse the content string which might be a stringified object with circular refs
      const parsedContent = JSON.parse(result.content);

      // If parsing succeeded and content contains buffer data, extract what we need
      if (parsedContent && parsedContent._readableState && parsedContent._readableState.buffer) {
        // Extract buffer data and convert to actual content when possible
        const bufferData = parsedContent._readableState.buffer;

        // If we have buffer data with a "data" property, try to convert it to actual content
        if (
          Array.isArray(bufferData) &&
          bufferData.length > 0 &&
          bufferData[0].type === 'Buffer' &&
          Array.isArray(bufferData[0].data)
        ) {
          try {
            // Convert buffer data to actual content
            const bufferBytes = Buffer.from(bufferData[0].data);

            // Determine if it's likely text content based on content type or binary detection
            const isLikelyText =
              !result.isBinary &&
              (!result.contentType ||
                result.contentType.includes('text') ||
                result.contentType.includes('json') ||
                result.contentType.includes('html') ||
                result.contentType.includes('xml') ||
                result.contentType.includes('javascript') ||
                result.contentType.includes('typescript'));

            // Return structured response with both the converted content and metadata
            return JSON.stringify(
              {
                content: isLikelyText
                  ? bufferBytes.toString('utf-8')
                  : '[Binary content - displaying first 1000 bytes as hex]',
                hexContent: isLikelyText ? null : bufferBytes.toString('hex').substring(0, 2000),
                isBinary: result.isBinary,
                contentType: result.contentType,
                size: result.size || bufferBytes.length,
                length: result.length || bufferBytes.length,
                position: result.position || 0,
              },
              null,
              2
            );
          } catch (bufferError) {
            // Fall back to returning the raw buffer data
            return JSON.stringify(
              {
                buffer: bufferData,
                error: 'Failed to convert buffer to content',
                errorDetails: bufferError instanceof Error ? bufferError.message : 'Unknown error',
                size: result.size || 0,
                length: result.length || 0,
                position: result.position || 0,
                contentType: result.contentType,
                isBinary: result.isBinary,
              },
              null,
              2
            );
          }
        }

        // Fallback to original approach if buffer format is different
        const sanitizedContent = {
          buffer: bufferData,
          size: result.size || 0,
          length: result.length || 0,
          position: result.position || 0,
          contentType: result.contentType,
          isBinary: result.isBinary,
          error: result.error,
        };
        return JSON.stringify(sanitizedContent, null, 2);
      }
    } catch (parseError) {
      // If parsing fails, the content might not be JSON or might be corrupted
      // Continue with the normal safe stringify process
    }
  }

  try {
    // Try to JSON stringify normally first
    return JSON.stringify(result, null, 2);
  } catch (error) {
    // If normal stringify fails, use a more robust approach
    const seen = new WeakSet();
    try {
      return JSON.stringify(
        result,
        (key, value) => {
          // Skip these problematic keys that often cause circular references
          if (
            key === '_httpMessage' ||
            key === 'socket' ||
            key === 'connection' ||
            key === 'agent' ||
            key === 'parser' ||
            key === 'client' ||
            key === '_events' ||
            key === '_eventsCount' ||
            key === '_readableState' ||
            key === '_writableState'
          ) {
            return '[Circular]';
          }

          // Special handling for Buffer data - convert to string if possible
          if (
            key === 'buffer' &&
            Array.isArray(value) &&
            value.length > 0 &&
            value[0].type === 'Buffer'
          ) {
            try {
              const bufferBytes = Buffer.from(value[0].data);
              // Return converted text for smaller buffers, hexdump for larger ones
              if (bufferBytes.length < 10000) {
                return {
                  content: bufferBytes.toString('utf-8'),
                  bytesLength: bufferBytes.length,
                };
              } else {
                return {
                  content: '[Large buffer - first 1000 bytes shown]',
                  hexContent: bufferBytes.toString('hex').substring(0, 2000),
                  bytesLength: bufferBytes.length,
                };
              }
            } catch (bufferErr) {
              // Return truncated buffer array if conversion fails
              return value.slice(0, 1000);
            }
          }

          if (typeof value === 'object' && value !== null) {
            if (seen.has(value)) {
              return '[Circular]';
            }
            seen.add(value);
          }
          return value;
        },
        2
      );
    } catch (secondError) {
      // If all else fails, convert to a simple error message with more details
      return JSON.stringify({
        error: 'Failed to serialize response',
        message: error instanceof Error ? error.message : 'Unknown error',
        type: result ? typeof result : 'undefined',
        hasContent: result && result.content ? true : false,
        contentType: result && result.contentType ? result.contentType : 'unknown',
      });
    }
  }
}

// Create MCP server
const server = new McpServer({
  name: 'cursor-azure-devops-mcp',
  version: '1.0.3',
  description: 'MCP Server for Azure DevOps integration with Cursor IDE',
});

// Register Azure DevOps tools
server.tool(
  'azure_devops_get_projects',
  'List all Azure DevOps projects in your organization. Returns project details including ID, name, description, visibility, and state. Results are automatically truncated if they exceed size limits.',
  {},
  async () => {
    try {
      const result = await azureDevOpsService.getProjects();
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_work_item',
  'Get detailed information about a specific work item by ID. Returns work item fields, relations, history, and metadata. Supports all work item types (bugs, tasks, user stories, etc).',
  {
    id: z.number().describe('The ID of the work item to retrieve'),
  },
  async ({ id }) => {
    try {
      const result = await azureDevOpsService.getWorkItem(id);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_work_items',
  'Get detailed information for multiple work items by their IDs. Returns complete work item data including fields, relations, history, and metadata for each item. Useful for bulk retrieval of work items. Response is automatically truncated if it exceeds size limits while preserving essential data.',
  {
    ids: z
      .array(z.number())
      .describe(
        'Array of work item IDs to retrieve. Each ID should be a valid work item identifier.'
      ),
  },
  async ({ ids }) => {
    try {
      const result = await azureDevOpsService.getWorkItems(ids);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

const workItemFieldsSchema = {
  title: z.string().optional().describe('Work item title (System.Title)'),
  description: z.string().optional().describe('Work item description in HTML (System.Description)'),
  state: z.string().optional().describe('Work item state (System.State)'),
  assignedTo: z.string().optional().describe('Assignee display name or email (System.AssignedTo)'),
  areaPath: z.string().optional().describe('Area path (System.AreaPath)'),
  iterationPath: z.string().optional().describe('Iteration path (System.IterationPath)'),
  tags: z.string().optional().describe('Semicolon-separated tags (System.Tags)'),
  fields: z
    .record(z.unknown())
    .optional()
    .describe('Additional custom fields using full Azure DevOps field reference names'),
};

const workItemLinkSchema = z.object({
  targetId: z.number().describe('Target work item ID to link to'),
  linkType: z
    .string()
    .describe(
      'Link type: Related, Parent, Child, Predecessor, Successor, or full System.LinkTypes.* reference'
    ),
});

const workItemLinksSchema = z
  .array(workItemLinkSchema)
  .optional()
  .describe('Work item links to create or add');

server.tool(
  'azure_devops_create_work_item',
  'Create a new work item in Azure DevOps. Supports common fields, custom fields, optional parent linking, and multiple links.',
  {
    type: z
      .string()
      .describe('Work item type to create, e.g. Task, Bug, User Story, Feature, Epic'),
    title: z.string().describe('Title of the work item (System.Title)'),
    project: z
      .string()
      .optional()
      .describe('Project name. If not provided, uses the default project from configuration.'),
    description: workItemFieldsSchema.description,
    state: workItemFieldsSchema.state,
    assignedTo: workItemFieldsSchema.assignedTo,
    areaPath: workItemFieldsSchema.areaPath,
    iterationPath: workItemFieldsSchema.iterationPath,
    tags: workItemFieldsSchema.tags,
    parentId: z.number().optional().describe('Optional parent work item ID to link as a child'),
    links: workItemLinksSchema,
    fields: workItemFieldsSchema.fields,
  },
  async params => {
    try {
      const result = await azureDevOpsService.createWorkItem(params);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_update_work_item',
  'Update an existing work item in Azure DevOps. Only provided fields are changed; optional links are added.',
  {
    id: z.number().describe('The ID of the work item to update'),
    project: z
      .string()
      .optional()
      .describe('Project name. Optional but recommended for ADO routing.'),
    title: workItemFieldsSchema.title,
    description: workItemFieldsSchema.description,
    state: workItemFieldsSchema.state,
    assignedTo: workItemFieldsSchema.assignedTo,
    areaPath: workItemFieldsSchema.areaPath,
    iterationPath: workItemFieldsSchema.iterationPath,
    tags: workItemFieldsSchema.tags,
    links: workItemLinksSchema,
    fields: workItemFieldsSchema.fields,
  },
  async params => {
    try {
      const result = await azureDevOpsService.updateWorkItem(params);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_add_work_item_links',
  'Add one or more links to an existing work item. Supports Related, Parent, Child, Predecessor, and Successor link types.',
  {
    id: z.number().describe('The ID of the source work item'),
    project: z
      .string()
      .optional()
      .describe('Project name. Optional but recommended for ADO routing.'),
    links: z
      .array(workItemLinkSchema)
      .min(1)
      .describe('Links to add, each with targetId and linkType'),
  },
  async params => {
    try {
      const result = await azureDevOpsService.addWorkItemLinks(params);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_remove_work_item_links',
  'Remove one or more links from an existing work item by target ID and link type.',
  {
    id: z.number().describe('The ID of the source work item'),
    project: z
      .string()
      .optional()
      .describe('Project name. Optional but recommended for ADO routing.'),
    links: z
      .array(workItemLinkSchema)
      .min(1)
      .describe('Links to remove, each with targetId and linkType'),
  },
  async params => {
    try {
      const result = await azureDevOpsService.removeWorkItemLinks(params);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_repositories',
  'List all Git repositories in an Azure DevOps project. Returns repository details including ID, name, project info, default branch, size, and URLs. Supports both project-specific and organization-wide repository listing. Results are automatically truncated if they exceed size limits.',
  {
    project: z
      .string()
      .optional()
      .describe(
        'Project name to list repositories from. If not provided, uses the default project from configuration.'
      ),
  },
  async ({ project }) => {
    try {
      const result = await azureDevOpsService.getRepositories(project);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_pull_requests',
  'List all pull requests in a repository. Returns comprehensive PR information including title, description, status, reviewers, work items, commits, and thread counts. Supports filtering and pagination. Results are automatically truncated if they exceed size limits.',
  {
    repositoryId: z
      .string()
      .describe('Repository ID to list pull requests from. Must be a valid repository identifier.'),
    project: z
      .string()
      .optional()
      .describe(
        'Project name containing the repository. If not provided, uses the default project from configuration.'
      ),
  },
  async ({ repositoryId, project }) => {
    try {
      const result = await azureDevOpsService.getPullRequests(repositoryId, project);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_pull_request',
  'Get detailed information about a specific pull request. Returns complete PR data including title, description, status, reviewers, work items, commits, policy evaluations, and merge status. Useful for getting the full context of a PR. Response includes all associated metadata.',
  {
    repositoryId: z
      .string()
      .describe(
        'Repository ID containing the pull request. Must be a valid repository identifier.'
      ),
    pullRequestId: z
      .number()
      .describe('Pull request ID to retrieve. Must be a valid PR number in the repository.'),
    project: z
      .string()
      .optional()
      .describe(
        'Project name containing the repository. If not provided, uses the default project from configuration.'
      ),
  },
  async ({ repositoryId, pullRequestId, project }) => {
    try {
      const result = await azureDevOpsService.getPullRequestById(
        repositoryId,
        pullRequestId,
        project
      );
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_pull_request_threads',
  'Get all comment threads in a pull request. Returns thread details including comments, status, relationships, and file annotations. Supports both file-specific and general comments. Results include thread context and metadata.',
  {
    repositoryId: z
      .string()
      .describe(
        'Repository ID containing the pull request. Must be a valid repository identifier.'
      ),
    pullRequestId: z
      .number()
      .describe('Pull request ID to get threads from. Must be a valid PR number.'),
    project: z
      .string()
      .describe('Project name containing the repository. Required for thread retrieval.'),
  },
  async ({ repositoryId, pullRequestId, project }) => {
    try {
      const result = await azureDevOpsService.getPullRequestThreads(
        repositoryId,
        pullRequestId,
        project
      );
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// New tool for work item attachments
server.tool(
  'azure_devops_get_work_item_attachments',
  'Get all attachments associated with a work item. Returns attachment details including file name, size, creator, timestamps, and download URLs. Supports all attachment types including images, documents, and binary files. Results include metadata for each attachment.',
  {
    id: z
      .number()
      .describe('Work item ID to get attachments from. Must be a valid work item identifier.'),
  },
  async ({ id }) => {
    try {
      const result = await azureDevOpsService.getWorkItemAttachments(id);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// New tool for work item links
server.tool(
  'azure_devops_get_work_item_links',
  'Get all links and relationships for a work item. Returns detailed link information including link types, target work items, and relationship attributes. Supports all link types (Parent/Child, Related, Predecessor/Successor, etc). Results include full context of work item relationships.',
  {
    id: z
      .number()
      .describe('Work item ID to get links from. Must be a valid work item identifier.'),
  },
  async ({ id }) => {
    try {
      const result = await azureDevOpsService.getWorkItemLinks(id);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// New tool for linked work items with full details
server.tool(
  'azure_devops_get_linked_work_items',
  'Get all linked work items with their full details',
  {
    id: z.number().describe('Work item ID'),
  },
  async ({ id }) => {
    const result = await azureDevOpsService.getLinkedWorkItems(id);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// New tool for pull request changes with file contents
server.tool(
  'azure_devops_get_pull_request_changes',
  'Get detailed code changes for a pull request',
  {
    repositoryId: z.string().describe('Repository ID'),
    pullRequestId: z.number().describe('Pull request ID'),
    project: z.string().describe('Project name'),
  },
  async ({ repositoryId, pullRequestId, project }) => {
    const result = await azureDevOpsService.getPullRequestChanges(
      repositoryId,
      pullRequestId,
      project
    );

    return {
      content: [
        {
          type: 'text',
          text: safeResponse(result),
        },
      ],
    };
  }
);

// New tool for getting content of large files in pull requests by chunks
server.tool(
  'azure_devops_get_pull_request_file_content',
  'Get the content of a specific file in a pull request. By default returns the complete file as plain text. Set returnPlainText=false to get content in chunks with metadata. Has a 5-minute timeout for large files.',
  {
    repositoryId: z.string().describe('Repository ID'),
    pullRequestId: z.number().describe('Pull request ID'),
    filePath: z.string().describe('File path'),
    objectId: z.string().describe('Object ID of the file version'),
    startPosition: z
      .number()
      .optional()
      .describe('Starting position in the file (bytes) - only used when returnPlainText=false')
      .default(0),
    length: z
      .number()
      .optional()
      .describe('Length to read (bytes) - only used when returnPlainText=false')
      .default(100000),
    project: z.string().optional().describe('Project name'),
    returnPlainText: z
      .boolean()
      .optional()
      .describe(
        'When true (default), returns complete file as plain text; when false, returns JSON with chunk details'
      )
      .default(true),
  },
  async (
    {
      repositoryId,
      pullRequestId,
      filePath,
      objectId,
      startPosition,
      length,
      project,
      returnPlainText,
    },
    _context
  ) => {
    try {
      if (returnPlainText) {
        // Get the complete file content
        const content = await azureDevOpsService.getCompletePullRequestFileContent(
          repositoryId,
          pullRequestId,
          filePath,
          objectId,
          project
        );

        // Return in the proper MCP format
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      } else {
        // Get the file content in chunks with metadata
        const result = await azureDevOpsService.getPullRequestFileContent(
          repositoryId,
          pullRequestId,
          filePath,
          objectId,
          startPosition,
          length,
          project
        );

        // Format the response properly
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      }
    } catch (error) {
      console.error('Error retrieving PR file content:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// New tool for getting file content directly from a branch
server.tool(
  'azure_devops_get_branch_file_content',
  'Get the content of a file directly from a branch. By default returns the complete file as plain text. Set returnPlainText=false to get content in chunks with metadata. Has a 5-minute timeout for large files.',
  {
    repositoryId: z.string().describe('Repository ID'),
    branchName: z.string().describe('Branch name'),
    filePath: z.string().describe('File path'),
    startPosition: z
      .number()
      .optional()
      .describe('Starting position in the file (bytes) - only used when returnPlainText=false')
      .default(0),
    length: z
      .number()
      .optional()
      .describe('Length to read (bytes) - only used when returnPlainText=false')
      .default(100000),
    project: z.string().optional().describe('Project name'),
    returnPlainText: z
      .boolean()
      .optional()
      .describe(
        'When true (default), returns complete file as plain text; when false, returns JSON with chunk details'
      )
      .default(true),
  },
  async (
    { repositoryId, branchName, filePath, startPosition, length, project, returnPlainText },
    _context
  ) => {
    try {
      if (returnPlainText) {
        // Get the complete file content
        const content = await azureDevOpsService.getCompleteFileFromBranch(
          repositoryId,
          filePath,
          branchName,
          project
        );

        // Return in the proper MCP format
        return {
          content: [
            {
              type: 'text',
              text: content,
            },
          ],
        };
      } else {
        // Get the file content in chunks with metadata
        const result = await azureDevOpsService.getFileFromBranch(
          repositoryId,
          filePath,
          branchName,
          startPosition,
          length,
          project
        );

        // Format the response properly
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result),
            },
          ],
        };
      }
    } catch (error) {
      console.error('Error retrieving branch file content:', error);
      return {
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// New tool for creating pull request comments
server.tool(
  'azure_devops_create_pr_comment',
  'Create a comment on a pull request',
  {
    repositoryId: z.string().describe('Repository ID'),
    pullRequestId: z.number().describe('Pull request ID'),
    project: z.string().describe('Project name'),
    content: z.string().describe('Comment text'),
    threadId: z.number().optional().describe('Thread ID (if adding to existing thread)'),
    filePath: z.string().optional().describe('File path (if commenting on a file)'),
    lineNumber: z.number().optional().describe('Line number (if commenting on a specific line)'),
    parentCommentId: z.number().optional().describe('Parent comment ID (if replying to a comment)'),
    status: z.string().optional().describe('Comment status (e.g., "active", "fixed")'),
  },
  async params => {
    const result = await azureDevOpsService.createPullRequestComment(params);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  }
);

// New tool for work item comments
server.tool(
  'azure_devops_get_work_item_comments',
  'Get comments for a specific work item',
  {
    id: z.number().describe('Work item ID'),
  },
  async ({ id }) => {
    try {
      const result = await azureDevOpsService.getWorkItemComments(id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error(`Error executing azure_devops_get_work_item_comments for ID ${id}:`, error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }, null, 2),
          },
        ],
      };
    }
  }
);

// Test Plans
server.tool(
  'azure_devops_get_test_plans',
  'List all test plans in a project. Returns test plan details including ID, name, area path, and iteration path. Results are automatically truncated if they exceed size limits while preserving essential metadata.',
  {
    project: z
      .string()
      .optional()
      .describe(
        'The name of the project. If not provided, uses the default project from configuration.'
      ),
  },
  async ({ project }) => {
    try {
      const result = await azureDevOpsService.getTestPlans(project);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_test_plan',
  'Get a test plan by ID',
  {
    project: z.string().describe('Project name'),
    testPlanId: z.number().describe('Test plan ID'),
  },
  async ({ project, testPlanId }) => {
    try {
      const result = await azureDevOpsService.getTestPlan(project, testPlanId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error executing azure_devops_get_test_plan:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }, null, 2),
          },
        ],
      };
    }
  }
);

// Test Suites
server.tool(
  'azure_devops_get_test_suites',
  'List all test suites for a test plan',
  {
    project: z.string().describe('Project name'),
    testPlanId: z.number().describe('Test plan ID'),
  },
  async ({ project, testPlanId }) => {
    try {
      const result = await azureDevOpsService.getTestSuites(testPlanId, project);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error executing azure_devops_get_test_suites:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }, null, 2),
          },
        ],
      };
    }
  }
);

server.tool(
  'azure_devops_get_test_suite',
  'Get detailed information about a specific test suite by ID. Returns suite details, test cases, configurations, and related information. Supports all test suite types (static, requirement-based, query-based).',
  {
    project: z
      .string()
      .optional()
      .describe(
        'The name of the project. If not provided, uses the default project from configuration.'
      ),
    testPlanId: z.number().describe('The ID of the test plan containing the test suite'),
    testSuiteId: z.number().describe('The ID of the test suite to retrieve'),
  },
  async ({ project, testPlanId, testSuiteId }) => {
    try {
      const result = await azureDevOpsService.getTestSuite(project, testPlanId, testSuiteId);
      return {
        content: [{ type: 'text', text: safeResponse(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
      };
    }
  }
);

// Test Cases
server.tool(
  'azure_devops_get_test_cases',
  'List all test cases for a test suite',
  {
    project: z.string().describe('Project name'),
    testPlanId: z.number().describe('Test plan ID'),
    testSuiteId: z.number().describe('Test suite ID'),
  },
  async ({ project, testPlanId, testSuiteId }) => {
    try {
      const result = await azureDevOpsService.getTestCases(project, testPlanId, testSuiteId);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      console.error('Error executing azure_devops_get_test_cases:', error);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: String(error) }, null, 2),
          },
        ],
      };
    }
  }
);

// Start server
async function main() {
  // Load configuration from all sources (command line, IDE settings, env vars, defaults)
  const _config = configManager.loadConfig();

  // Display the configuration (sensitive data redacted)
  configManager.printConfig();

  // Check if Azure DevOps configuration is valid
  if (!configManager.isAzureDevOpsConfigValid()) {
    console.error('Azure DevOps configuration is missing or invalid.');
    console.error(
      'Please provide organizationUrl and token via command line, IDE settings, or environment variables.'
    );
    process.exit(1);
  }

  try {
    console.error('Starting Azure DevOps MCP Server with stdio transport...');

    // Initialize Azure DevOps API connection
    try {
      await azureDevOpsService.initialize();
      console.error('Azure DevOps API connection initialized successfully');
    } catch (error) {
      console.error('Failed to initialize Azure DevOps API connection:', error);
      process.exit(1);
    }

    // Create transport and connect
    const transport = new StdioServerTransport();
    await server.connect(transport);

    console.error('Azure DevOps MCP Server running on stdio');
    console.error('Available tools:');
    console.error('- azure_devops_get_projects: List all projects');
    console.error('- azure_devops_get_work_item: Get a work item by ID');
    console.error('- azure_devops_get_work_items: Get multiple work items by IDs');
    console.error('- azure_devops_create_work_item: Create a new work item');
    console.error('- azure_devops_update_work_item: Update an existing work item');
    console.error('- azure_devops_add_work_item_links: Add links to a work item');
    console.error('- azure_devops_remove_work_item_links: Remove links from a work item');
    console.error('- azure_devops_get_repositories: List all repositories');
    console.error('- azure_devops_get_pull_requests: List all pull requests for a repository');
    console.error('- azure_devops_get_pull_request: Get a pull request by ID');
    console.error(
      '- azure_devops_get_pull_request_threads: Get threads (comments) for a pull request'
    );
    console.error('- azure_devops_get_work_item_attachments: Get attachments for a work item');
    console.error('- azure_devops_get_work_item_links: Get links for a work item');
    console.error(
      '- azure_devops_get_linked_work_items: Get all linked work items with their full details'
    );
    console.error(
      '- azure_devops_get_pull_request_changes: Get detailed code changes for a pull request'
    );
    console.error(
      '- azure_devops_get_pull_request_file_content: Get content of a specific file in chunks (for large files)'
    );
    console.error(
      '- azure_devops_get_branch_file_content: Get content of a file directly from a branch'
    );
    console.error('- azure_devops_create_pr_comment: Create a comment on a pull request');
    console.error('- azure_devops_get_work_item_comments: Get comments for a specific work item');
    console.error('- azure_devops_get_test_plans: List all test plans for a project');
    console.error('- azure_devops_get_test_plan: Get a test plan by ID');
    console.error('- azure_devops_get_test_suites: List all test suites for a test plan');
    console.error('- azure_devops_get_test_suite: Get a test suite by ID');
    console.error('- azure_devops_get_test_cases: List all test cases for a test suite');
  } catch (error) {
    console.error('Error starting server:', error);
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGINT', () => {
  console.error('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error('Received SIGTERM, shutting down...');
  process.exit(0);
});

// Run the server
main().catch(error => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
