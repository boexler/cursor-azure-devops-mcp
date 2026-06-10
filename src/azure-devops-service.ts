import * as azdev from 'azure-devops-node-api';
import { configManager } from './config-manager.js';
import {
  TeamProject,
  WorkItem,
  GitRepository,
  GitPullRequest,
  GitPullRequestCommentThread,
  ApiClients,
  WorkItemAttachment,
  PullRequestChange,
  PullRequestChanges,
  PullRequestCommentRequest,
  PullRequestCommentResponse,
  PullRequestFileContent,
  WorkItemCommentsResponse,
  WorkItemCreateRequest,
  WorkItemUpdateRequest,
  WorkItemJsonPatchOperation,
  WorkItemLinkHyperlinkInput,
  WorkItemLinkInput,
  WorkItemAddLinksRequest,
  WorkItemRemoveLinksRequest,
  WorkItemWithRelations,
  WorkItemRelationsSummary,
  WorkItemLinkWorkItemInput,
} from './types.js';
import {
  assertWorkItemLinksOnly,
  buildLinkAddPatchValue,
  buildRelationsSummary,
  findRelationIndexForRemoval,
  hasDuplicateHyperlink,
  inferLinkKind,
} from './relation-utils.js';

/**
 * Helper function to safely stringify objects with circular references
 */
function safeStringify(obj: any): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    // Skip _httpMessage, socket and similar properties that cause circular references
    if (key === '_httpMessage' || key === 'socket' || key === 'connection' || key === 'agent') {
      return '[Circular]';
    }
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

/**
 * Service for interacting with Azure DevOps API
 */
class AzureDevOpsService {
  private connection: azdev.WebApi | null = null;
  private projectClient: any = null;
  private workItemClient: any = null;
  private gitClient: any = null;
  private testPlanClient: any = null;
  private defaultProject: string | undefined;
  private organizationUrl: string | undefined;

  constructor(connection?: azdev.WebApi, defaultProject?: string) {
    if (connection) {
      this.connection = connection;
    }
    this.defaultProject = defaultProject;
  }

  /**
   * Initialize the Azure DevOps API connection
   */
  async initialize(): Promise<void> {
    if (this.connection) {
      return;
    }

    const config = configManager.loadConfig();
    const { organizationUrl, token } = config.azureDevOps;

    if (!organizationUrl || !token) {
      throw new Error('Azure DevOps organization URL and token are required');
    }

    // Create a connection to Azure DevOps
    const authHandler = azdev.getPersonalAccessTokenHandler(token);
    this.connection = new azdev.WebApi(organizationUrl, authHandler);
    this.organizationUrl = organizationUrl.replace(/\/$/, '');

    // Set default project if not provided in constructor
    if (!this.defaultProject && config.azureDevOps.project) {
      this.defaultProject = config.azureDevOps.project;
    }

    // Get API clients
    this.projectClient = await this.connection.getCoreApi();
    this.workItemClient = await this.connection.getWorkItemTrackingApi();
    this.gitClient = await this.connection.getGitApi();
    this.testPlanClient = await this.connection.getTestPlanApi();
  }

  /**
   * Get all projects from Azure DevOps
   */
  async getProjects(): Promise<TeamProject[]> {
    await this.initialize();

    if (!this.projectClient) {
      throw new Error('Project client not initialized');
    }

    // CoreApi provides the getProjects method to list all projects
    const projects = await this.projectClient.getProjects();
    return projects;
  }

  /**
   * Get a specific work item by ID with normalized relation summary
   */
  async getWorkItem(id: number): Promise<WorkItemWithRelations> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const workItem = await this.workItemClient.getWorkItem(
      id,
      undefined,
      undefined,
      4 // WorkItemExpand.Relations
    );

    return this.enrichWorkItemWithRelations(workItem);
  }

  /**
   * Attach normalized relation summary fields to a work item response
   */
  private enrichWorkItemWithRelations(workItem: WorkItem): WorkItemWithRelations {
    const summary = buildRelationsSummary(workItem.relations);

    return {
      ...workItem,
      ...summary,
    };
  }

  /**
   * Fetch a work item with relations expanded
   */
  private async getWorkItemWithRelations(workItemId: number): Promise<WorkItem> {
    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const workItem = await this.workItemClient.getWorkItem(
      workItemId,
      undefined,
      undefined,
      4 // WorkItemExpand.Relations
    );

    if (!workItem) {
      throw new Error(`Work item ${workItemId} not found`);
    }

    return workItem;
  }

  /**
   * Get multiple work items by IDs
   */
  async getWorkItems(ids: number[]): Promise<WorkItem[]> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const workItems = await this.workItemClient.getWorkItems(ids);
    return workItems;
  }

  /**
   * Build JSON Patch operations to add work item links or external hyperlinks
   */
  private buildLinkAddPatches(links: WorkItemLinkInput[]): WorkItemJsonPatchOperation[] {
    if (!this.organizationUrl) {
      throw new Error('Organization URL is not initialized');
    }

    const organizationUrl = this.organizationUrl;

    return links.map(link => ({
      op: 'add' as const,
      path: '/relations/-',
      value: buildLinkAddPatchValue(link, organizationUrl),
    }));
  }

  /**
   * Ensure hyperlink URLs are not already present on the work item
   */
  private assertNoDuplicateHyperlinks(workItem: WorkItem, links: WorkItemLinkInput[]): void {
    for (const link of links) {
      if (inferLinkKind(link) !== 'hyperlink') {
        continue;
      }

      const hyperlinkLink = link as WorkItemLinkHyperlinkInput;

      if (hasDuplicateHyperlink(workItem.relations, hyperlinkLink.url)) {
        throw new Error(`Hyperlink already exists on work item: ${hyperlinkLink.url}`);
      }
    }
  }

  /**
   * Collect all link inputs including legacy parentId support
   */
  private collectWorkItemLinks(params: {
    parentId?: number;
    links?: WorkItemLinkInput[];
  }): WorkItemLinkInput[] {
    const collected: WorkItemLinkInput[] = [...(params.links ?? [])];

    if (params.parentId !== undefined) {
      collected.push({ targetId: params.parentId, linkType: 'Parent' });
    }

    return collected;
  }

  /**
   * Build JSON Patch operations to remove work item links or external hyperlinks
   */
  private async buildLinkRemovePatches(
    workItemId: number,
    links: WorkItemLinkInput[]
  ): Promise<WorkItemJsonPatchOperation[]> {
    const workItem = await this.getWorkItemWithRelations(workItemId);

    if (!workItem.relations?.length) {
      throw new Error(`Work item ${workItemId} has no relations to remove`);
    }

    const indicesToRemove: number[] = [];

    for (const link of links) {
      const index = findRelationIndexForRemoval(workItem.relations, link);

      if (index === -1) {
        const kind = inferLinkKind(link);
        const message =
          kind === 'hyperlink'
            ? `Hyperlink not found on work item ${workItemId}: ${(link as WorkItemLinkHyperlinkInput).url}`
            : `Link not found on work item ${workItemId}: ${(link as WorkItemLinkWorkItemInput).linkType} -> ${(link as WorkItemLinkWorkItemInput).targetId}`;

        throw new Error(message);
      }

      indicesToRemove.push(index);
    }

    return [...new Set(indicesToRemove)]
      .sort((a, b) => b - a)
      .map(index => ({
        op: 'remove' as const,
        path: `/relations/${index}`,
      }));
  }

  /**
   * Apply a JSON Patch document to an existing work item
   */
  private async applyWorkItemPatch(
    id: number,
    document: WorkItemJsonPatchOperation[],
    project?: string
  ): Promise<WorkItem> {
    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const projectName = project || this.defaultProject;

    const workItem = await this.workItemClient.updateWorkItem(null, document, id, projectName);

    if (!workItem) {
      throw new Error(
        `Azure DevOps returned no work item for ID ${id}. Verify the ID, field values, and PAT permissions (Work Items read & write).`
      );
    }

    return workItem;
  }

  /**
   * Build a JSON Patch document from friendly work item field parameters
   */
  private buildWorkItemPatchDocument(
    params: {
      title?: string;
      description?: string;
      state?: string;
      assignedTo?: string;
      areaPath?: string;
      iterationPath?: string;
      tags?: string;
      parentId?: number;
      links?: WorkItemLinkInput[];
      fields?: Record<string, unknown>;
    },
    operation: 'add' | 'replace'
  ): WorkItemJsonPatchOperation[] {
    const document: WorkItemJsonPatchOperation[] = [];
    const fieldMappings: Array<[keyof typeof params, string]> = [
      ['title', 'System.Title'],
      ['description', 'System.Description'],
      ['state', 'System.State'],
      ['assignedTo', 'System.AssignedTo'],
      ['areaPath', 'System.AreaPath'],
      ['iterationPath', 'System.IterationPath'],
      ['tags', 'System.Tags'],
    ];

    for (const [paramKey, fieldRef] of fieldMappings) {
      const value = params[paramKey];
      if (value !== undefined && value !== null && value !== '') {
        document.push({
          op: operation,
          path: `/fields/${fieldRef}`,
          value,
        });
      }
    }

    if (params.fields) {
      for (const [fieldRef, value] of Object.entries(params.fields)) {
        if (value !== undefined) {
          document.push({
            op: operation,
            path: `/fields/${fieldRef}`,
            value,
          });
        }
      }
    }

    if (operation === 'add') {
      const links = this.collectWorkItemLinks(params);
      assertWorkItemLinksOnly(links);
      if (links.length > 0) {
        document.push(...this.buildLinkAddPatches(links));
      }
    }

    return document;
  }

  /**
   * Create a new work item in Azure DevOps
   */
  async createWorkItem(params: WorkItemCreateRequest): Promise<WorkItem> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const projectName = params.project || this.defaultProject;
    if (!projectName) {
      throw new Error('Project name is required');
    }

    const document = this.buildWorkItemPatchDocument(params, 'add');
    if (document.length === 0) {
      throw new Error('At least one field is required to create a work item');
    }

    try {
      const workItem = await this.workItemClient.createWorkItem(
        null,
        document,
        projectName,
        params.type
      );

      if (!workItem) {
        throw new Error(
          'Azure DevOps returned no work item. Verify project, work item type, field values, and PAT permissions (Work Items read & write).'
        );
      }

      return workItem;
    } catch (error) {
      console.error('Error creating work item:', error);
      throw new Error(
        `Failed to create work item: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Update an existing work item in Azure DevOps
   */
  async updateWorkItem(params: WorkItemUpdateRequest): Promise<WorkItem> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const projectName = params.project || this.defaultProject;
    assertWorkItemLinksOnly(params.links);
    const document = [
      ...this.buildWorkItemPatchDocument(params, 'replace'),
      ...(params.links?.length ? this.buildLinkAddPatches(params.links) : []),
    ];

    if (document.length === 0) {
      throw new Error('At least one field or link must be provided to update a work item');
    }

    try {
      return await this.applyWorkItemPatch(params.id, document, projectName);
    } catch (error) {
      console.error(`Error updating work item ${params.id}:`, error);
      throw new Error(
        `Failed to update work item: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Add links to an existing work item
   */
  async addWorkItemLinks(params: WorkItemAddLinksRequest): Promise<WorkItem> {
    await this.initialize();

    if (!params.links?.length) {
      throw new Error('At least one link must be provided');
    }

    try {
      const workItem = await this.getWorkItemWithRelations(params.id);
      this.assertNoDuplicateHyperlinks(workItem, params.links);
      const document = this.buildLinkAddPatches(params.links);
      return await this.applyWorkItemPatch(params.id, document, params.project);
    } catch (error) {
      console.error(`Error adding links to work item ${params.id}:`, error);
      throw new Error(
        `Failed to add work item links: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Remove links from an existing work item
   */
  async removeWorkItemLinks(params: WorkItemRemoveLinksRequest): Promise<WorkItem> {
    await this.initialize();

    if (!params.links?.length) {
      throw new Error('At least one link must be provided');
    }

    try {
      const document = await this.buildLinkRemovePatches(params.id, params.links);
      return await this.applyWorkItemPatch(params.id, document, params.project);
    } catch (error) {
      console.error(`Error removing links from work item ${params.id}:`, error);
      throw new Error(
        `Failed to remove work item links: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get repositories for a project
   */
  async getRepositories(project?: string): Promise<GitRepository[]> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    const repositories = await this.gitClient.getRepositories(projectName);
    return repositories;
  }

  /**
   * Get pull requests for a repository
   */
  async getPullRequests(repositoryId: string, project?: string): Promise<GitPullRequest[]> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    const pullRequests = await this.gitClient.getPullRequests(repositoryId, {
      project: projectName,
    });

    return pullRequests;
  }

  /**
   * Get a specific pull request by ID
   */
  async getPullRequestById(
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<GitPullRequest> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    // Get all pull requests for the repository with all statuses
    const pullRequests = await this.gitClient.getPullRequests(repositoryId, {
      project: projectName,
      status: 'all',
      includeLinks: true,
    });

    // Find the specific pull request
    const pullRequest = pullRequests.find(
      (pr: GitPullRequest) => pr.pullRequestId === pullRequestId
    );

    if (!pullRequest) {
      throw new Error(`Pull request ${pullRequestId} not found in repository ${repositoryId}`);
    }

    return pullRequest;
  }

  /**
   * Get threads (comments) for a pull request
   */
  async getPullRequestThreads(
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<GitPullRequestCommentThread[]> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    const threads = await this.gitClient.getThreads(repositoryId, pullRequestId, projectName);
    return threads;
  }

  /**
   * Test the connection to Azure DevOps
   */
  async testConnection(): Promise<boolean> {
    await this.initialize();
    // If we get here, the connection was successful
    return true;
  }

  /**
   * Get the API clients
   * @returns Object containing all initialized clients
   */
  getClients(): ApiClients {
    if (!this.projectClient || !this.workItemClient || !this.gitClient || !this.testPlanClient) {
      throw new Error('API clients not initialized. Call initialize() first.');
    }

    return {
      projectClient: this.projectClient,
      workItemClient: this.workItemClient,
      gitClient: this.gitClient,
      testPlanClient: this.testPlanClient,
    };
  }

  /**
   * Get attachments for a specific work item
   * @param workItemId The ID of the work item
   * @returns Array of attachments with metadata
   */
  async getWorkItemAttachments(workItemId: number): Promise<WorkItemAttachment[]> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    // Get work item with relations (includes attachments)
    const workItem = await this.workItemClient.getWorkItem(
      workItemId,
      undefined,
      undefined,
      4 // 4 = WorkItemExpand.Relations in the SDK
    );

    if (!workItem || !workItem.relations) {
      return [];
    }

    // Filter for attachment relations only (hyperlinks are managed via link tools)
    const attachmentRelations = workItem.relations.filter(
      (relation: any) => relation.rel === 'AttachedFile'
    );

    // Map relations to attachment objects
    const attachments = attachmentRelations.map((relation: any) => {
      const url = relation.url;
      const attributes = relation.attributes || {};

      const attachment: WorkItemAttachment = {
        url,
        name: attributes.name || url.split('/').pop() || 'unnamed',
        comment: attributes.comment || '',
        resourceSize: attributes.resourceSize || 0,
        contentType: attributes.resourceType || '',
      };

      return attachment;
    });

    return attachments;
  }

  /**
   * Get comments for a specific work item
   * @param workItemId The ID of the work item
   * @returns Array of comments with their metadata
   */
  async getWorkItemComments(workItemId: number): Promise<WorkItemCommentsResponse> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    try {
      // First get the work item to determine its project
      const workItem = await this.getWorkItem(workItemId);
      if (!workItem || !workItem.fields) {
        throw new Error('Work item not found or invalid');
      }

      // Get the project from the work item's fields
      const projectId = workItem.fields['System.TeamProject'];
      if (!projectId) {
        throw new Error('Could not determine project for work item');
      }

      // Get comments for the work item using the discussions API
      const comments = await this.workItemClient.getComments(projectId, workItemId);

      if (!comments) {
        return {
          totalCount: 0,
          count: 0,
          comments: [],
        };
      }

      // Process comments and their metadata
      const processedComments = (comments.comments || []).map((comment: any) => ({
        id: comment.id || 0,
        workItemId,
        text: comment.text || '',
        createdBy: {
          displayName: comment.createdBy?.displayName || 'Unknown',
          id: comment.createdBy?.id || '',
          uniqueName: comment.createdBy?.uniqueName || '',
        },
        createdDate: comment.createdDate || new Date().toISOString(),
        modifiedDate: comment.modifiedDate,
        mentions:
          comment.mentions?.map((mention: any) => ({
            id: mention.id || '',
            displayName: mention.displayName || '',
            uniqueName: mention.uniqueName || '',
          })) || [],
        reactions:
          comment.reactions?.map((reaction: any) => ({
            type: reaction.type || '',
            count: reaction.count || 0,
            users:
              reaction.users?.map((user: any) => ({
                id: user.id || '',
                displayName: user.displayName || '',
              })) || [],
          })) || [],
      }));

      return {
        totalCount: comments.totalCount || processedComments.length,
        count: processedComments.length,
        comments: processedComments,
      };
    } catch (error) {
      console.error(`Error getting comments for work item ${workItemId}:`, error);
      // Return empty response instead of throwing error
      return {
        totalCount: 0,
        count: 0,
        comments: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get all relations associated with a work item in normalized form
   * @param workItemId The ID of the work item
   * @returns Normalized relations summary including work item links and hyperlinks
   */
  async getWorkItemLinks(workItemId: number): Promise<WorkItemRelationsSummary> {
    await this.initialize();

    const workItem = await this.getWorkItemWithRelations(workItemId);
    return buildRelationsSummary(workItem.relations);
  }

  /**
   * Get all linked work items with their full details
   * @param workItemId The ID of the work item to get links from
   * @returns Array of work items that are linked to the specified work item
   */
  async getLinkedWorkItems(workItemId: number): Promise<WorkItem[]> {
    await this.initialize();

    if (!this.workItemClient) {
      throw new Error('Work item client not initialized');
    }

    const { workItemLinks } = await this.getWorkItemLinks(workItemId);

    const linkedIds = workItemLinks
      .map(link => link.targetId)
      .filter((targetId): targetId is number => targetId !== undefined && targetId > 0);

    // If no linked items found, return empty array
    if (linkedIds.length === 0) {
      return [];
    }

    // Get the full work item details for all linked items
    const linkedWorkItems = await this.getWorkItems(linkedIds);
    return linkedWorkItems;
  }

  /**
   * Get detailed changes for a pull request
   */
  async getPullRequestChanges(
    repositoryId: string,
    pullRequestId: number,
    project?: string
  ): Promise<PullRequestChanges> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    // Get the changes for the pull request
    const changes = await this.gitClient.getPullRequestIterationChanges(
      repositoryId,
      pullRequestId,
      1, // Iteration (usually 1 for the latest)
      projectName
    );

    // File size and content handling constants
    const MAX_INLINE_FILE_SIZE = 500000; // Increased to 500KB for inline content
    const MAX_CHUNK_SIZE = 100000; // 100KB chunks for larger files
    const PREVIEW_SIZE = 10000; // 10KB preview for very large files

    // Get detailed content for each change
    const enhancedChanges = await Promise.all(
      (changes.changeEntries || []).map(async (change: any) => {
        const filePath = change.item?.path || '';
        let originalContent = null;
        let modifiedContent = null;
        let originalContentSize = 0;
        let modifiedContentSize = 0;
        let originalContentPreview = null;
        let modifiedContentPreview = null;

        // Skip folders or binary files
        const isBinary = this.isBinaryFile(filePath);
        const isFolder = change.item?.isFolder === true;

        if (!isFolder && !isBinary && change.item) {
          try {
            // Get original content if the file wasn't newly added
            if (change.changeType !== 'add' && change.originalObjectId) {
              try {
                // First get the item metadata to check file size
                const originalItem = await this.gitClient.getItem(
                  repositoryId,
                  filePath,
                  projectName,
                  change.originalObjectId
                );

                originalContentSize = originalItem?.contentMetadata?.contentLength || 0;

                // For files within the inline limit, get full content
                if (originalContentSize <= MAX_INLINE_FILE_SIZE) {
                  const originalItemContent = await this.gitClient.getItemContent(
                    repositoryId,
                    filePath,
                    projectName,
                    change.originalObjectId,
                    undefined,
                    true,
                    true
                  );

                  originalContent = originalItemContent.toString('utf8');
                }
                // For large files, get a preview
                else {
                  // Get just the beginning of the file for preview
                  const previewContent = await this.gitClient.getItemText(
                    repositoryId,
                    filePath,
                    projectName,
                    change.originalObjectId,
                    0, // Start at beginning
                    PREVIEW_SIZE // Get preview bytes
                  );

                  originalContentPreview = previewContent;
                  originalContent = `(File too large to display inline - ${Math.round(originalContentSize / 1024)}KB. Preview shown.)`;
                }
              } catch (error) {
                console.error(`Error getting original content for ${filePath}:`, error);
                originalContent = '(Content unavailable)';
              }
            }

            // Get modified content if the file wasn't deleted
            if (change.changeType !== 'delete' && change.item.objectId) {
              try {
                // First get the item metadata to check file size
                const modifiedItem = await this.gitClient.getItem(
                  repositoryId,
                  filePath,
                  projectName,
                  change.item.objectId
                );

                modifiedContentSize = modifiedItem?.contentMetadata?.contentLength || 0;

                // For files within the inline limit, get full content
                if (modifiedContentSize <= MAX_INLINE_FILE_SIZE) {
                  const modifiedItemContent = await this.gitClient.getItemContent(
                    repositoryId,
                    filePath,
                    projectName,
                    change.item.objectId,
                    undefined,
                    true,
                    true
                  );

                  modifiedContent = modifiedItemContent.toString('utf8');
                }
                // For large files, get a preview
                else {
                  // Get just the beginning of the file for preview
                  const previewContent = await this.gitClient.getItemText(
                    repositoryId,
                    filePath,
                    projectName,
                    change.item.objectId,
                    0, // Start at beginning
                    PREVIEW_SIZE // Get preview bytes
                  );

                  modifiedContentPreview = previewContent;
                  modifiedContent = `(File too large to display inline - ${Math.round(modifiedContentSize / 1024)}KB. Preview shown.)`;
                }
              } catch (error) {
                console.error(`Error getting modified content for ${filePath}:`, error);
                modifiedContent = '(Content unavailable)';
              }
            }
          } catch (error) {
            console.error(`Error processing file ${filePath}:`, error);
          }
        }

        // Create enhanced change object
        const enhancedChange: PullRequestChange = {
          ...change,
          originalContent,
          modifiedContent,
          originalContentSize,
          modifiedContentSize,
          originalContentPreview,
          modifiedContentPreview,
          isBinary,
          isFolder,
        } as PullRequestChange;

        return enhancedChange;
      })
    );

    return {
      changeEntries: enhancedChanges,
      totalCount: enhancedChanges.length,
    };
  }

  /**
   * Helper method to get the Git API client
   */
  private async getGitApiClient() {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    return this.gitClient;
  }

  /**
   * Retrieves complete file content by fetching chunks in parallel
   * @param fetchChunk Function to fetch a single chunk of the file
   * @returns Promise resolving to the complete file content as string
   */
  private async getCompleteFileContent(
    fetchChunk: (startPosition: number, length: number) => Promise<PullRequestFileContent>
  ): Promise<string> {
    try {
      // First, fetch a tiny chunk to determine if it's binary and get content length
      const initialChunk = await fetchChunk(0, 1024);

      if (initialChunk.isBinary) {
        return `[Binary file content not displayed. File size: ${initialChunk.contentLength || initialChunk.size} bytes]`;
      }

      const contentLength = initialChunk.contentLength || initialChunk.size;

      // If the file is small enough, return it directly
      if (contentLength <= 100000) {
        if (contentLength <= initialChunk.content.length) {
          return initialChunk.content;
        }
        const fullContent = await fetchChunk(0, contentLength);
        return fullContent.content;
      }

      // For larger files, fetch in parallel chunks
      const totalLength = contentLength;
      const CHUNK_SIZE = 100000; // 100KB chunks
      const NUM_PARALLEL_REQUESTS = 5; // Number of parallel requests

      const chunks: string[] = [];
      let position = 0;

      // Process the file in batches of parallel requests
      while (position < totalLength) {
        const chunkPromises: Promise<PullRequestFileContent>[] = [];

        // Create batch of chunk requests
        for (let i = 0; i < NUM_PARALLEL_REQUESTS && position < totalLength; i++) {
          const chunkSize = Math.min(CHUNK_SIZE, totalLength - position);
          chunkPromises.push(fetchChunk(position, chunkSize));
          position += chunkSize;
        }

        // Wait for all chunks in this batch to be retrieved
        const chunkResults = await Promise.all(chunkPromises);

        // Add chunks to our collection in the correct order
        for (const chunk of chunkResults) {
          chunks.push(chunk.content);
        }

        // Small delay to avoid overwhelming the API
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return chunks.join('');
    } catch (error) {
      console.error('Error retrieving complete file content:', error);
      if (error instanceof Error) {
        throw new Error(`Failed to retrieve complete file content: ${error.message}`);
      } else {
        throw new Error('Failed to retrieve complete file content due to an unknown error');
      }
    }
  }

  /**
   * Get the content of a file in a pull request
   */
  async getPullRequestFileContent(
    repositoryId: string,
    pullRequestId: number,
    filePath: string,
    objectId: string,
    startPosition = 0,
    length = 100000,
    project?: string
  ): Promise<PullRequestFileContent> {
    try {
      const gitClient = await this.getGitApiClient();
      const projectName = project || this.defaultProject;

      if (!projectName) {
        throw new Error('Project name is required but not provided');
      }

      // Check if this is likely a binary file
      const isBinaryFile = this.isBinaryFile(filePath);

      try {
        // Get the content with range
        const content = await gitClient.getBlobContent(
          repositoryId,
          objectId,
          projectName,
          undefined, // download
          undefined, // scopePath
          {
            startPosition: startPosition,
            endPosition: startPosition + length - 1,
          }
        );

        // Check if we got a Buffer
        let contentStr = '';
        let contentSize = 0;
        let totalContentLength = 0;

        if (Buffer.isBuffer(content)) {
          contentSize = content.length;

          // Attempt to get the total file size by requesting the file metadata
          try {
            const fileInfo = await gitClient.getBlobsZip(repositoryId, [objectId], projectName);

            // This may not give us the exact size, but we'll try to estimate
            totalContentLength = fileInfo?._response?.bodyAsText?.length || contentSize;
          } catch (error) {
            // If we can't get the total size, use the current chunk size or try another method
            totalContentLength = contentSize;
          }

          if (isBinaryFile) {
            contentStr = '[Binary content]';
          } else {
            try {
              contentStr = content.toString('utf8');
            } catch (error) {
              contentStr = '[Error converting content to string]';
            }
          }
        } else if (typeof content === 'string') {
          contentStr = content;
          contentSize = contentStr.length;
          totalContentLength = contentSize;
        } else if (content === null || content === undefined) {
          contentStr = '';
          contentSize = 0;
          totalContentLength = 0;
        } else {
          // In case we got some other type
          try {
            contentStr = safeStringify(content);
            contentSize = contentStr.length;
            totalContentLength = contentSize;
          } catch (error) {
            contentStr = '[Error: could not serialize content]';
            contentSize = contentStr.length;
            totalContentLength = contentSize;
          }
        }

        return {
          content: contentStr,
          size: totalContentLength,
          position: startPosition,
          length: contentSize,
          isBinary: isBinaryFile,
          contentLength: totalContentLength,
        };
      } catch (error) {
        console.error('Error getting content directly:', error);

        // Fallback to branch access if direct objectId access fails
        try {
          // Get the pull request details to find the source branch
          const pullRequest = await gitClient.getPullRequestById(
            pullRequestId,
            repositoryId,
            projectName
          );

          if (!pullRequest || !pullRequest.sourceRefName) {
            throw new Error('Could not determine source branch for pull request');
          }

          // Extract branch name from ref (remove 'refs/heads/' prefix)
          const branchName = pullRequest.sourceRefName.replace(/^refs\/heads\//, '');

          // Use the getFileFromBranch method as a fallback
          console.log(`Falling back to branch access for ${filePath} using branch ${branchName}`);
          return await this.getFileFromBranch(
            repositoryId,
            filePath,
            branchName,
            startPosition,
            length,
            projectName
          );
        } catch (fallbackError) {
          console.error('Fallback to branch access also failed:', fallbackError);
          return {
            content: '',
            size: 0,
            position: startPosition,
            length: 0,
            error: `Failed to retrieve content for file: ${filePath}. Direct access and branch fallback both failed.`,
            isBinary: false,
            contentLength: 0,
          };
        }
      }
    } catch (error) {
      console.error('Error in getPullRequestFileContent:', error);
      return {
        content: '',
        size: 0,
        position: startPosition,
        length: 0,
        error: `Failed to retrieve content: ${error instanceof Error ? error.message : String(error)}`,
        isBinary: false,
        contentLength: 0,
      };
    }
  }

  /**
   * Get the complete content of a file from a pull request, automatically handling chunking
   * This simplifies access to large files by combining chunks internally
   */
  async getCompletePullRequestFileContent(
    repositoryId: string,
    pullRequestId: number,
    filePath: string,
    objectId: string,
    project?: string
  ): Promise<string> {
    // Check if this is a binary file before proceeding
    if (this.isBinaryFile(filePath)) {
      return `[Binary file - content cannot be displayed as text]`;
    }

    try {
      const content = await this.getCompleteFileContent((startPosition, length) =>
        this.getPullRequestFileContent(
          repositoryId,
          pullRequestId,
          filePath,
          objectId,
          startPosition,
          length,
          project
        )
      );
      return content;
    } catch (error) {
      console.error('Error retrieving complete pull request file content:', error);
      throw error;
    }
  }

  /**
   * Get the complete content of a file from a branch, automatically handling chunking
   * This simplifies access to large files by combining chunks internally
   */
  async getCompleteFileFromBranch(
    repositoryId: string,
    filePath: string,
    branchName: string,
    project?: string
  ): Promise<string> {
    // Check if this is a binary file before proceeding
    if (this.isBinaryFile(filePath)) {
      return `[Binary file - content cannot be displayed as text]`;
    }

    try {
      const content = await this.getCompleteFileContent((startPosition, length) =>
        this.getFileFromBranch(repositoryId, filePath, branchName, startPosition, length, project)
      );
      return content;
    } catch (error) {
      console.error('Error retrieving complete branch file content:', error);
      throw error;
    }
  }

  /**
   * Helper function to determine if a file is likely binary based on extension
   */
  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.ico',
      '.svg',
      '.pdf',
      '.doc',
      '.docx',
      '.ppt',
      '.pptx',
      '.xls',
      '.xlsx',
      '.zip',
      '.tar',
      '.gz',
      '.rar',
      '.7z',
      '.exe',
      '.dll',
      '.so',
      '.dylib',
      '.bin',
      '.dat',
      '.class',
    ];

    const extension = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    return binaryExtensions.includes(extension);
  }

  /**
   * Helper method to get a file's content from a specific branch
   * This is useful for accessing files in pull requests when direct object ID access fails
   */
  async getFileFromBranch(
    repositoryId: string,
    filePath: string,
    branchName: string,
    startPosition = 0,
    length = 100000,
    project?: string
  ): Promise<PullRequestFileContent> {
    try {
      const gitClient = await this.getGitApiClient();
      const projectName = project || this.defaultProject;

      if (!projectName) {
        throw new Error('Project name is required but not provided');
      }

      // Check if this is likely a binary file
      const isBinaryFile = this.isBinaryFile(filePath);

      try {
        // Attempt to get the item by path
        const gitItem = await gitClient.getItem(
          repositoryId,
          filePath,
          projectName,
          undefined, // version
          undefined, // versionOptions
          undefined, // versionType
          undefined, // includeContent
          undefined, // latestProcessedChange
          branchName, // versionDescriptor
          undefined // includeContentMetadata
        );

        if (!gitItem || !gitItem.objectId) {
          throw new Error(`File not found at path: ${filePath}`);
        }

        // Get the content with range
        const content = await gitClient.getItemContent(
          repositoryId,
          filePath,
          projectName,
          undefined, // version
          undefined, // versionOptions
          undefined, // versionType
          branchName, // versionDescriptor
          undefined, // download
          undefined, // includeContent
          undefined, // latestProcessedChange
          {
            startPosition: startPosition,
            endPosition: startPosition + length - 1,
          }
        );

        // Check if we got a Buffer
        let contentStr = '';
        let contentSize = 0;
        let totalContentLength = 0;

        if (Buffer.isBuffer(content)) {
          contentSize = content.length;

          // Attempt to get the total file size by requesting the file without content
          try {
            const fileInfo = await gitClient.getItem(
              repositoryId,
              filePath,
              projectName,
              undefined,
              undefined,
              undefined,
              undefined, // Don't request content
              undefined,
              branchName,
              true // includeContentMetadata
            );

            totalContentLength = fileInfo.contentMetadata?.contentLength || contentSize;
          } catch (error) {
            // If we can't get the total size, use the current chunk size
            totalContentLength = contentSize;
          }

          if (isBinaryFile) {
            contentStr = '[Binary content]';
          } else {
            try {
              contentStr = content.toString('utf8');
            } catch (error) {
              contentStr = '[Error converting content to string]';
            }
          }
        } else if (typeof content === 'string') {
          contentStr = content;
          contentSize = contentStr.length;
          totalContentLength = contentSize;
        } else if (content === null || content === undefined) {
          contentStr = '';
          contentSize = 0;
          totalContentLength = 0;
        } else {
          // In case we got some other type
          try {
            contentStr = safeStringify(content);
            contentSize = contentStr.length;
            totalContentLength = contentSize;
          } catch (error) {
            contentStr = '[Error: could not serialize content]';
            contentSize = contentStr.length;
            totalContentLength = contentSize;
          }
        }

        return {
          content: contentStr,
          size: totalContentLength,
          position: startPosition,
          length: contentSize,
          isBinary: isBinaryFile,
          contentLength: totalContentLength,
        };
      } catch (error) {
        // Log the error for debugging
        console.error('Error in getFileFromBranch:', error);

        // Return a structured error response
        return {
          content: '',
          size: 0,
          position: startPosition,
          length: 0,
          error: error instanceof Error ? error.message : String(error),
          isBinary: false,
          contentLength: 0,
        };
      }
    } catch (error) {
      console.error('Error in getFileFromBranch:', error);
      throw error;
    }
  }

  /**
   * Create a comment on a pull request
   */
  async createPullRequestComment(
    params: PullRequestCommentRequest
  ): Promise<PullRequestCommentResponse> {
    await this.initialize();

    if (!this.gitClient) {
      throw new Error('Git client not initialized');
    }

    const {
      repositoryId,
      pullRequestId,
      project,
      content,
      threadId,
      filePath,
      lineNumber,
      parentCommentId,
      status,
    } = params;

    // Use the provided project or fall back to the default project
    const projectName = project || this.defaultProject;

    if (!projectName) {
      throw new Error('Project name is required');
    }

    let commentResponse: PullRequestCommentResponse | null = null;

    try {
      // Case 1: Adding a comment to an existing thread
      if (threadId) {
        // Create comment on existing thread
        const comment = await this.gitClient.createComment(
          {
            content,
            parentCommentId,
          },
          repositoryId,
          pullRequestId,
          threadId,
          projectName
        );

        commentResponse = {
          id: comment.id || 0,
          content: comment.content || '',
          threadId,
          status: comment.status,
          author: comment.author,
          createdDate: comment.publishedDate,
          url: comment.url,
        };
      }
      // Case 2: Creating a new thread with a comment
      else {
        // Set up the new thread
        const threadContext: any = {};

        if (filePath) {
          // Comment on a file
          threadContext.filePath = filePath;

          // If line number is provided, set up position
          if (lineNumber) {
            threadContext.rightFileStart = {
              line: lineNumber,
              offset: 1,
            };
            threadContext.rightFileEnd = {
              line: lineNumber,
              offset: 1,
            };
          }
        }

        // Create a new thread with our comment
        const newThread = await this.gitClient.createThread(
          {
            comments: [
              {
                content,
                parentCommentId,
              },
            ],
            status,
            threadContext,
          },
          repositoryId,
          pullRequestId,
          projectName
        );

        // Extract the created comment from the thread
        const createdComment =
          newThread.comments && newThread.comments.length > 0 ? newThread.comments[0] : null;

        if (createdComment && newThread.id) {
          commentResponse = {
            id: createdComment.id || 0,
            content: createdComment.content || '',
            threadId: newThread.id,
            status: createdComment.status,
            author: createdComment.author,
            createdDate: createdComment.publishedDate,
            url: createdComment.url,
          };
        } else {
          throw new Error('Failed to create comment on pull request');
        }
      }

      return (
        commentResponse || {
          id: 0,
          content: '',
          threadId: threadId || 0,
          status: 'unknown',
        }
      );
    } catch (error) {
      console.error('Error creating pull request comment:', error);
      throw new Error(
        `Failed to create comment: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Helper function to truncate large response objects
   * @param obj The object to truncate
   * @param maxSize Maximum size in bytes (default 50KB)
   * @returns Truncated object with metadata
   */
  private truncateResponse(obj: any, maxSize: number = 50000): any {
    const stringified = safeStringify(obj);

    if (stringified.length <= maxSize) {
      return obj;
    }

    // For arrays, truncate to fewer items
    if (Array.isArray(obj)) {
      const truncated = obj.slice(
        0,
        Math.max(1, Math.floor(obj.length * (maxSize / stringified.length)))
      );
      return {
        items: truncated,
        totalCount: obj.length,
        isTruncated: true,
        truncatedCount: obj.length - truncated.length,
        message: `Response was truncated. Showing ${truncated.length} of ${obj.length} items.`,
      };
    }

    // For objects, try to keep essential fields and truncate nested content
    const truncated: any = {};
    let currentSize = 0;
    const essentialFields = ['id', 'name', 'url', 'project', 'state', 'createdBy', 'createdDate'];

    // First, keep all essential fields
    essentialFields.forEach(field => {
      if (obj[field] !== undefined) {
        truncated[field] = obj[field];
        currentSize += safeStringify(obj[field]).length;
      }
    });

    // Then add other fields until we reach size limit
    Object.entries(obj).forEach(([key, value]) => {
      if (!essentialFields.includes(key)) {
        const valueSize = safeStringify(value).length;
        if (currentSize + valueSize <= maxSize) {
          truncated[key] = value;
          currentSize += valueSize;
        }
      }
    });

    return {
      ...truncated,
      isTruncated: true,
      originalSize: stringified.length,
      truncatedSize: currentSize,
      message: 'Response was truncated to fit size limits. Essential information is preserved.',
    };
  }

  /**
   * Get test suites for a project and test plan
   */
  async getTestSuites(testPlanId: number, project?: string): Promise<any[]> {
    await this.initialize();

    try {
      if (!this.testPlanClient) {
        this.testPlanClient = await this.connection!.getTestPlanApi();
      }

      // Use provided project or default project from config
      const projectName = project || this.defaultProject;
      if (!projectName) {
        throw new Error('Project name is required but not provided in parameters or configuration');
      }

      console.log(`Fetching test suites for project ${projectName} and plan ${testPlanId}`);
      const testSuites = await this.testPlanClient.getTestSuitesForPlan(projectName, testPlanId);

      if (!testSuites) {
        console.log('No test suites returned from API');
        return [];
      }

      return this.truncateResponse(testSuites);
    } catch (error) {
      console.error('Error getting test suites:', error);
      throw error;
    }
  }

  /**
   * Get test suite by ID
   */
  async getTestSuite(
    project: string | undefined,
    testPlanId: number,
    testSuiteId: number
  ): Promise<any> {
    await this.initialize();

    try {
      if (!this.testPlanClient) {
        this.testPlanClient = await this.connection!.getTestPlanApi();
      }

      // Use provided project or default project from config
      const projectName = project || this.defaultProject;
      if (!projectName) {
        throw new Error('Project name is required but not provided in parameters or configuration');
      }

      console.log(
        `Fetching test suite ${testSuiteId} from project ${projectName} and plan ${testPlanId}`
      );
      const testSuite = await this.testPlanClient.getTestSuiteById(
        projectName,
        testPlanId,
        testSuiteId
      );

      if (!testSuite) {
        console.log('No test suite found with the specified ID');
        throw new Error(`Test suite ${testSuiteId} not found`);
      }

      return this.truncateResponse(testSuite);
    } catch (error) {
      console.error('Error getting test suite:', error);
      throw error;
    }
  }

  /**
   * Get test cases for a test suite
   */
  async getTestCases(
    project: string | undefined,
    testPlanId: number,
    testSuiteId: number
  ): Promise<any[]> {
    await this.initialize();

    try {
      if (!this.testPlanClient) {
        this.testPlanClient = await this.connection!.getTestPlanApi();
      }

      // Use provided project or default project from config
      const projectName = project || this.defaultProject;
      if (!projectName) {
        throw new Error('Project name is required but not provided in parameters or configuration');
      }

      console.log(
        `Fetching test cases for suite ${testSuiteId} in project ${projectName} and plan ${testPlanId}`
      );
      const testCases = await this.testPlanClient.getTestCaseList(
        projectName,
        testPlanId,
        testSuiteId
      );

      if (!testCases) {
        console.log('No test cases returned from API');
        return [];
      }

      return this.truncateResponse(testCases);
    } catch (error) {
      console.error('Error getting test cases:', error);
      throw error;
    }
  }

  /**
   * Get test plans for a project
   */
  async getTestPlans(project?: string): Promise<any[]> {
    await this.initialize();

    try {
      if (!this.testPlanClient) {
        this.testPlanClient = await this.connection!.getTestPlanApi();
      }

      // Use provided project or default project from config
      const projectName = project || this.defaultProject;
      if (!projectName) {
        throw new Error('Project name is required but not provided in parameters or configuration');
      }

      console.log(`Fetching test plans for project ${projectName}`);
      const testPlans = await this.testPlanClient.getTestPlans(projectName);

      if (!testPlans) {
        console.log('No test plans returned from API');
        return [];
      }

      return this.truncateResponse(testPlans);
    } catch (error) {
      console.error('Error getting test plans:', error);
      throw error;
    }
  }

  /**
   * Get test plan by ID
   */
  async getTestPlan(project: string | undefined, testPlanId: number): Promise<any> {
    await this.initialize();

    try {
      if (!this.testPlanClient) {
        this.testPlanClient = await this.connection!.getTestPlanApi();
      }

      // Use provided project or default project from config
      const projectName = project || this.defaultProject;
      if (!projectName) {
        throw new Error('Project name is required but not provided in parameters or configuration');
      }

      console.log(`Fetching test plan ${testPlanId} from project ${projectName}`);
      const testPlan = await this.testPlanClient.getTestPlanById(projectName, testPlanId);

      if (!testPlan) {
        console.log('No test plan found with the specified ID');
        throw new Error(`Test plan ${testPlanId} not found`);
      }

      return this.truncateResponse(testPlan);
    } catch (error) {
      console.error('Error getting test plan:', error);
      throw error;
    }
  }
}

// Export the class and create a singleton instance
export { AzureDevOpsService };
export const azureDevOpsService = new AzureDevOpsService();
