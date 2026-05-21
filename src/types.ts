/**
 * Type definitions for the Azure DevOps MCP Server
 */

// Azure DevOps Team Project
export interface TeamProject {
  id: string;
  name: string;
  description?: string;
  url?: string;
  state?: string;
  revision?: number;
  visibility?: string;
  lastUpdateTime?: string;
}

// Azure DevOps Work Item
export interface WorkItem {
  id: number;
  rev?: number;
  fields?: Record<string, any>;
  relations?: WorkItemRelation[];
  url?: string;
}

// Azure DevOps Work Item Relation
export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: Record<string, any>;
}

// Azure DevOps Work Item Link (Extended from WorkItemRelation)
export interface WorkItemLink extends WorkItemRelation {
  targetId: number; // The ID of the target work item
  title?: string; // Optional title of the target work item
}

// Azure DevOps Git Repository
export interface GitRepository {
  id: string;
  name: string;
  url?: string;
  project?: {
    id: string;
    name: string;
  };
  defaultBranch?: string;
  size?: number;
  remoteUrl?: string;
  webUrl?: string;
}

// Azure DevOps Pull Request
export interface GitPullRequest {
  pullRequestId: number;
  repoId: string;
  repository?: GitRepository;
  creationDate?: string;
  title?: string;
  description?: string;
  sourceRefName?: string;
  targetRefName?: string;
  status?: string;
  createdBy?: {
    displayName?: string;
    id?: string;
    uniqueName?: string;
  };
  lastMergeSourceCommit?: {
    commitId?: string;
  };
  lastMergeTargetCommit?: {
    commitId?: string;
  };
  url?: string;
}

// Azure DevOps Pull Request Comment Thread
export interface GitPullRequestCommentThread {
  id: number;
  pullRequestThreadContext?: {
    changeTrackingId?: number;
    iterationContext?: {
      firstComparingIteration?: number;
      secondComparingIteration?: number;
    };
  };
  status?: string;
  threadContext?: {
    filePath?: string;
    rightFileStart?: {
      line?: number;
      offset?: number;
    };
    rightFileEnd?: {
      line?: number;
      offset?: number;
    };
  };
  comments?: {
    id?: number;
    parentCommentId?: number;
    content?: string;
    publishedDate?: string;
    lastUpdatedDate?: string;
    author?: {
      displayName?: string;
      id?: string;
      uniqueName?: string;
    };
  }[];
}

// Azure DevOps API Clients
export interface ApiClients {
  projectClient: any;
  workItemClient: any;
  gitClient: any;
  testPlanClient: any;
}

// Work Item Attachment
export interface WorkItemAttachment {
  id?: string;
  url: string;
  name: string;
  comment?: string;
  resourceSize?: number;
  contentType?: string;
  content?: string | Buffer; // May include actual content in base64 or binary
}

// Pull Request Change
export interface PullRequestChange {
  changeId: string;
  item?: {
    objectId?: string;
    originalObjectId?: string;
    path?: string;
    contentMetadata?: {
      fileName?: string;
      extension?: string;
    };
    isFolder?: boolean;
  };
  changeType?: string; // Add, Edit, Delete
  originalContent?: string; // Content before change
  modifiedContent?: string; // Content after change
  originalContentSize?: number; // Size of original file in bytes
  modifiedContentSize?: number; // Size of modified file in bytes
  originalContentPreview?: string; // Preview of content for large files
  modifiedContentPreview?: string; // Preview of content for large files
  isBinary?: boolean; // Whether the file is binary
  isFolder?: boolean; // Whether the item is a folder
}

export interface PullRequestChanges {
  changeEntries: PullRequestChange[];
  totalCount: number;
}

// New interfaces for PR comments
export interface PullRequestCommentRequest {
  repositoryId: string;
  pullRequestId: number;
  project: string;
  threadId?: number; // If adding to existing thread
  filePath?: string; // If commenting on a file
  lineNumber?: number; // If commenting on a specific line
  parentCommentId?: number; // If replying to a specific comment
  content: string; // The comment text
  status?: string; // Optional status (e.g., 'active', 'fixed')
}

export interface PullRequestCommentResponse {
  id: number;
  content: string;
  threadId: number;
  status?: string;
  author?: {
    displayName?: string;
    id?: string;
  };
  createdDate?: string;
  url?: string;
}

/**
 * Response type for file content retrieval in pull requests
 */
export interface PullRequestFileContent {
  content: string;
  size: number;
  position: number;
  length: number;
  error?: string;
  isBinary?: boolean;
  contentLength?: number; // Total content length for the file
}

// Work Item Comment
export interface WorkItemComment {
  id: number;
  workItemId: number;
  text: string;
  createdBy: {
    displayName: string;
    id: string;
    uniqueName: string;
  };
  createdDate: string;
  modifiedDate?: string;
  mentions?: {
    id: string;
    displayName: string;
    uniqueName: string;
  }[];
  reactions?: {
    type: string;
    count: number;
    users: {
      id: string;
      displayName: string;
    }[];
  }[];
}

// Work Item Comments Response
export interface WorkItemCommentsResponse {
  totalCount: number;
  count: number;
  comments: WorkItemComment[];
  error?: string; // Optional error message if something went wrong
}

/** JSON Patch operation for Azure DevOps work item create/update */
export interface WorkItemJsonPatchOperation {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

/** Request payload for creating a work item */
export interface WorkItemCreateRequest {
  project?: string;
  type: string;
  title: string;
  description?: string;
  state?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string;
  parentId?: number;
  fields?: Record<string, unknown>;
}

/** Request payload for updating a work item */
export interface WorkItemUpdateRequest {
  id: number;
  project?: string;
  title?: string;
  description?: string;
  state?: string;
  assignedTo?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string;
  fields?: Record<string, unknown>;
}
