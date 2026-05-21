#!/usr/bin/env node

import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { azureDevOpsService } from './azure-devops-service.js';
import { config } from './config.js';
import { createServer } from 'http';
import { configManager } from './config-manager.js';
import { safeResponse } from './index.js';
import { EventEmitter } from 'events';

// Extend EventEmitter to allow more listeners
EventEmitter.defaultMaxListeners = 100;

// Create Express app
const app = express();
const PORT = config.server.port;

// Define interface for MCP tools
interface McpTool {
  description: string;
  parameters: Record<string, { description: string; type: string }>;
  handler: (params: any) => Promise<any>;
}

// Define a type that extends McpServer to include transport property
interface ExtendedMcpServer extends McpServer {
  transport?: SSEServerTransport;
  closeHandler?: () => void;
}

// Store active MCP servers
const servers: ExtendedMcpServer[] = [];

// Enable CORS for all requests
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');

  // Handle OPTIONS requests immediately
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  next();
});

// Serve basic info at root
app.get('/', (req, res) => {
  res.send(`
    <h1>Azure DevOps MCP Server</h1>
    <p>Status: Running</p>
    <p>SSE endpoint: <a href="/sse">/sse</a></p>
    <p>Version: ${config.version}</p>
    <p>Active connections: ${servers.length}</p>
  `);
});

// SSE endpoint - this is what Cursor connects to
app.get('/sse', async (req, res) => {
  console.log('New SSE connection request from:', req.headers['user-agent']);

  // NOTE: Do NOT set headers manually here - the SSEServerTransport will do this

  try {
    // Create transport with message endpoint
    const transport = new SSEServerTransport('/message', res);

    // Create and configure MCP server
    const server: ExtendedMcpServer = new McpServer({
      name: 'cursor-azure-devops-mcp',
      version: '1.0.0',
      description: 'Azure DevOps integration for Cursor IDE',
    });

    // Register Azure DevOps tools
    server.tool('azure_devops_projects', 'Get projects from Azure DevOps', {}, async () => {
      const result = await azureDevOpsService.getProjects();
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    });

    server.tool(
      'azure_devops_work_item',
      'Get a specific work item by ID',
      {
        id: z.number().describe('Work item ID'),
      },
      async ({ id }) => {
        const result = await azureDevOpsService.getWorkItem(id);
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

    server.tool(
      'azure_devops_work_items',
      'Get multiple work items by IDs',
      {
        ids: z.array(z.number()).describe('Array of work item IDs'),
      },
      async ({ ids }) => {
        const result = await azureDevOpsService.getWorkItems(ids);
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

    server.tool(
      'azure_devops_create_work_item',
      'Create a new work item in Azure DevOps',
      {
        type: z.string().describe('Work item type, e.g. Task, Bug, User Story'),
        title: z.string().describe('Work item title'),
        project: z.string().optional().describe('Project name'),
        description: z.string().optional().describe('Work item description (HTML)'),
        state: z.string().optional().describe('Work item state'),
        assignedTo: z.string().optional().describe('Assignee display name or email'),
        areaPath: z.string().optional().describe('Area path'),
        iterationPath: z.string().optional().describe('Iteration path'),
        tags: z.string().optional().describe('Semicolon-separated tags'),
        parentId: z.number().optional().describe('Parent work item ID'),
        fields: z.record(z.unknown()).optional().describe('Additional custom fields'),
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
      'Update an existing work item in Azure DevOps',
      {
        id: z.number().describe('Work item ID'),
        project: z.string().optional().describe('Project name'),
        title: z.string().optional().describe('Work item title'),
        description: z.string().optional().describe('Work item description (HTML)'),
        state: z.string().optional().describe('Work item state'),
        assignedTo: z.string().optional().describe('Assignee display name or email'),
        areaPath: z.string().optional().describe('Area path'),
        iterationPath: z.string().optional().describe('Iteration path'),
        tags: z.string().optional().describe('Semicolon-separated tags'),
        fields: z.record(z.unknown()).optional().describe('Additional custom fields'),
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
      'azure_devops_repositories',
      'Get repositories for a project',
      {
        project: z.string().describe('Project name'),
      },
      async ({ project }) => {
        const result = await azureDevOpsService.getRepositories(project);
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

    server.tool(
      'azure_devops_pull_requests',
      'Get pull requests from a repository',
      {
        repositoryId: z.string().describe('Repository ID'),
        project: z.string().describe('Project name'),
      },
      async ({ repositoryId, project }) => {
        const result = await azureDevOpsService.getPullRequests(repositoryId, project);
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

    server.tool(
      'azure_devops_pull_request_by_id',
      'Get a specific pull request by ID',
      {
        repositoryId: z.string().describe('Repository ID'),
        pullRequestId: z.number().describe('Pull request ID'),
        project: z.string().describe('Project name'),
      },
      async ({ repositoryId, pullRequestId, project }) => {
        const result = await azureDevOpsService.getPullRequestById(
          repositoryId,
          pullRequestId,
          project
        );
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

    server.tool(
      'azure_devops_pull_request_threads',
      'Get threads from a pull request',
      {
        repositoryId: z.string().describe('Repository ID'),
        pullRequestId: z.number().describe('Pull request ID'),
        project: z.string().describe('Project name'),
      },
      async ({ repositoryId, pullRequestId, project }) => {
        const result = await azureDevOpsService.getPullRequestThreads(
          repositoryId,
          pullRequestId,
          project
        );
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

    // New tool for work item attachments
    server.tool(
      'azure_devops_work_item_attachments',
      'Get attachments for a specific work item',
      {
        id: z.number().describe('Work item ID'),
      },
      async ({ id }) => {
        const result = await azureDevOpsService.getWorkItemAttachments(id);
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

    // New tool for work item links
    server.tool(
      'azure_devops_work_item_links',
      'Get links for a specific work item',
      {
        id: z.number().describe('Work item ID'),
      },
      async ({ id }) => {
        const result = await azureDevOpsService.getWorkItemLinks(id);
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

    // New tool for linked work items with full details
    server.tool(
      'azure_devops_linked_work_items',
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
      'azure_devops_pull_request_changes',
      'Get detailed code changes for a pull request',
      {
        repositoryId: z.string().describe('Repository ID'),
        pullRequestId: z.number().describe('Pull request ID'),
        project: z.string().describe('Project name'),
      },
      async ({ repositoryId, pullRequestId, project }, { signal }) => {
        signal.throwIfAborted();
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

    // New tool for work item comments
    server.tool(
      'azure_devops_work_item_comments',
      'Get comments for a specific work item',
      {
        id: z.number().describe('Work item ID'),
      },
      async ({ id }) => {
        const result = await azureDevOpsService.getWorkItemComments(id);
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

    // Main server tools
    const serverTools: Record<string, McpTool> = {
      azure_devops_pull_request_file_content: {
        description:
          'Get the content of a specific file in a pull request. By default returns the complete file as plain text. Set returnPlainText=false to get content in chunks with metadata. Has a 5-minute timeout for large files.',
        parameters: {
          repositoryId: {
            description: 'Repository ID',
            type: 'string',
          },
          pullRequestId: {
            description: 'Pull request ID',
            type: 'number',
          },
          filePath: {
            description: 'File path',
            type: 'string',
          },
          objectId: {
            description: 'Object ID of the file version',
            type: 'string',
          },
          startPosition: {
            description:
              'Starting position in the file (bytes) - only used when returnPlainText=false',
            type: 'number',
          },
          length: {
            description: 'Length to read (bytes) - only used when returnPlainText=false',
            type: 'number',
          },
          project: {
            description: 'Project name',
            type: 'string',
          },
          returnPlainText: {
            description:
              'When true (default), returns complete file as plain text; when false, returns JSON with chunk details',
            type: 'boolean',
          },
        },
        handler: async (params: any) => {
          try {
            const {
              repositoryId,
              pullRequestId,
              filePath,
              objectId,
              startPosition = 0,
              length = 100000,
              project,
              returnPlainText = true,
            } = params;

            // Set a timeout for the operation (5 minutes)
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timed out after 5 minutes')), 300000);
            });

            if (returnPlainText) {
              // Get the complete file content
              const contentPromise = azureDevOpsService.getCompletePullRequestFileContent(
                repositoryId,
                pullRequestId,
                filePath,
                objectId,
                project
              );

              // Race against timeout
              const content = (await Promise.race([contentPromise, timeoutPromise])) as string;

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
              const resultPromise = azureDevOpsService.getPullRequestFileContent(
                repositoryId,
                pullRequestId,
                filePath,
                objectId,
                startPosition,
                length,
                project
              );

              // Race against timeout
              const result = await Promise.race([resultPromise, timeoutPromise]);

              return JSON.stringify(result);
            }
          } catch (error) {
            console.error('Error retrieving PR file content:', error);
            if (error instanceof Error) {
              return JSON.stringify({ error: error.message });
            }
            return JSON.stringify({ error: 'Failed to retrieve PR file content' });
          }
        },
      },

      azure_devops_branch_file_content: {
        description:
          'Get the content of a file directly from a branch. By default returns the complete file as plain text. Set returnPlainText=false to get content in chunks with metadata. Has a 5-minute timeout for large files.',
        parameters: {
          repositoryId: {
            description: 'Repository ID',
            type: 'string',
          },
          branchName: {
            description: 'Branch name',
            type: 'string',
          },
          filePath: {
            description: 'File path',
            type: 'string',
          },
          startPosition: {
            description:
              'Starting position in the file (bytes) - only used when returnPlainText=false',
            type: 'number',
          },
          length: {
            description: 'Length to read (bytes) - only used when returnPlainText=false',
            type: 'number',
          },
          project: {
            description: 'Project name',
            type: 'string',
          },
          returnPlainText: {
            description:
              'When true (default), returns complete file as plain text; when false, returns JSON with chunk details',
            type: 'boolean',
          },
        },
        handler: async (params: any) => {
          try {
            const {
              repositoryId,
              branchName,
              filePath,
              startPosition = 0,
              length = 100000,
              project,
              returnPlainText = true,
            } = params;

            // Set a timeout for the operation (5 minutes)
            const timeoutPromise = new Promise((_, reject) => {
              setTimeout(() => reject(new Error('Request timed out after 5 minutes')), 300000);
            });

            if (returnPlainText) {
              // Get the complete file content
              const contentPromise = azureDevOpsService.getCompleteFileFromBranch(
                repositoryId,
                filePath,
                branchName,
                project
              );

              // Race against timeout
              const content = (await Promise.race([contentPromise, timeoutPromise])) as string;

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
              const resultPromise = azureDevOpsService.getFileFromBranch(
                repositoryId,
                filePath,
                branchName,
                startPosition,
                length,
                project
              );

              // Race against timeout
              const result = await Promise.race([resultPromise, timeoutPromise]);

              return JSON.stringify(result);
            }
          } catch (error) {
            console.error('Error retrieving branch file content:', error);
            if (error instanceof Error) {
              return JSON.stringify({ error: error.message });
            }
            return JSON.stringify({ error: 'Failed to retrieve branch file content' });
          }
        },
      },

      // ... other tools ...
    };

    // Handle server close
    server.closeHandler = () => {
      console.log('SSE connection closed');
      const index = servers.indexOf(server);
      if (index !== -1) {
        servers.splice(index, 1);
      }
    };

    // Store transport reference
    server.transport = transport;

    // Add to active servers
    servers.push(server);

    // Connect the MCP server to the transport
    await server.connect(transport);

    console.log('Azure DevOps MCP Server connected to SSE transport');
    console.log('Session ID:', transport.sessionId);

    // Handle client disconnect
    req.on('close', () => {
      console.log('Client disconnected');
      if (server.closeHandler) {
        server.closeHandler();
      }
    });
  } catch (error) {
    console.error('Error initializing MCP server:', error);
    // Don't try to send a response, it might already be in use
    console.error('Detailed error:', error instanceof Error ? error.stack : String(error));
  }
});

// Message endpoint for receiving messages from the client
app.post('/message', async (req, res) => {
  console.log('Received message from client');

  const sessionId = req.query.sessionId as string;
  if (!sessionId) {
    console.error('Missing sessionId parameter');
    return res.status(400).send('Missing sessionId parameter');
  }

  // Find the transport for this session
  const server = servers.find(s => s.transport && s.transport.sessionId === sessionId);
  if (!server || !server.transport) {
    console.error('Session not found:', sessionId);
    return res.status(404).send('Session not found');
  }

  try {
    // Handle the message
    await server.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error('Error handling message:', error);
    // Only try to send error if headers haven't been sent
    if (!res.headersSent) {
      res
        .status(500)
        .send(
          'Error handling message: ' + (error instanceof Error ? error.message : String(error))
        );
    } else {
      console.error('Could not send error to client, headers already sent');
    }
  }
});

// Initialize Azure DevOps connection
async function initializeAzureDevOps() {
  try {
    await azureDevOpsService.testConnection();
    console.log('Azure DevOps API connection initialized successfully');
    return true;
  } catch (error) {
    console.error('Error connecting to Azure DevOps API:', error);
    console.error('Please check your .env configuration');
    return false;
  }
}

// Start HTTP server
async function startServer() {
  // Initialize Azure DevOps connection
  const initialized = await initializeAzureDevOps();
  if (!initialized) {
    console.error('Failed to initialize Azure DevOps connection. Exiting...');
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
    console.log(`Message endpoint: http://localhost:${PORT}/message`);
  });
}

// Handle termination signals
process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down...');
  process.exit(0);
});

// Start the server
console.log('Starting Azure DevOps MCP Server with SSE transport...');
startServer().catch(error => {
  console.error('Fatal error starting server:', error);
  process.exit(1);
});
