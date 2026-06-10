import {
  NormalizedWorkItemRelation,
  WorkItemLinkHyperlinkInput,
  WorkItemLinkInput,
  WorkItemLinkWorkItemInput,
  WorkItemRelation,
  WorkItemRelationsSummary,
} from './types.js';

/** Maps friendly link type names to Azure DevOps relation reference names */
export const LINK_TYPE_MAP: Record<string, string> = {
  Related: 'System.LinkTypes.Related',
  Parent: 'System.LinkTypes.Hierarchy-Reverse',
  Child: 'System.LinkTypes.Hierarchy-Forward',
  Predecessor: 'System.LinkTypes.Dependency-Reverse',
  Successor: 'System.LinkTypes.Dependency-Forward',
};

/** Reverse map from ADO rel names to friendly link type labels */
const REL_TO_LINK_TYPE: Record<string, string> = Object.fromEntries(
  Object.entries(LINK_TYPE_MAP).map(([friendly, rel]) => [rel, friendly])
);

/**
 * Extract the target work item ID from a relation URL
 */
export function extractWorkItemIdFromRelationUrl(url: string): number | null {
  const match = url.match(/\/workitems\/(\d+)(?:\?.*)?$/i);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Resolve a friendly or full Azure DevOps link type to a relation reference name
 */
export function resolveLinkType(linkType: string): string {
  if (linkType.startsWith('System.LinkTypes.')) {
    return linkType;
  }

  const resolved = LINK_TYPE_MAP[linkType];
  if (!resolved) {
    throw new Error(
      `Unknown link type "${linkType}". Supported values: Related, Parent, Child, Predecessor, Successor, or a full System.LinkTypes.* reference.`
    );
  }

  return resolved;
}

/**
 * Resolve a friendly link type label from an ADO relation reference name
 */
export function resolveFriendlyLinkType(rel: string): string | undefined {
  if (rel === 'Hyperlink') {
    return 'Hyperlink';
  }

  return REL_TO_LINK_TYPE[rel];
}

/**
 * Infer whether a link input refers to a work item link or external hyperlink
 */
export function inferLinkKind(input: WorkItemLinkInput): 'workItem' | 'hyperlink' {
  if (input.kind === 'hyperlink') {
    return 'hyperlink';
  }

  if ('targetId' in input && input.targetId !== undefined) {
    return 'workItem';
  }

  throw new Error(
    'Invalid link input: provide either kind "hyperlink" with url, or targetId with linkType.'
  );
}

/**
 * Validate that a hyperlink URL uses http or https
 */
export function validateHyperlinkUrl(url: string): void {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid hyperlink URL "${url}". URL must start with http:// or https://.`);
  }
}

/**
 * Normalize a raw Azure DevOps relation into a consistent MCP shape
 */
export function normalizeRelation(relation: WorkItemRelation): NormalizedWorkItemRelation {
  if (relation.rel === 'Hyperlink') {
    return {
      type: 'hyperlink',
      rel: relation.rel,
      url: relation.url,
      linkType: 'Hyperlink',
      attributes: relation.attributes,
    };
  }

  if (relation.rel.includes('Link') && relation.rel !== 'AttachedFile') {
    const targetId = extractWorkItemIdFromRelationUrl(relation.url) ?? undefined;

    return {
      type: 'workItem',
      rel: relation.rel,
      url: relation.url,
      targetId,
      linkType: resolveFriendlyLinkType(relation.rel),
      attributes: relation.attributes,
    };
  }

  return {
    type: 'other',
    rel: relation.rel,
    url: relation.url,
    attributes: relation.attributes,
  };
}

/**
 * Build a normalized relations summary from raw ADO relations
 */
export function buildRelationsSummary(
  relations: WorkItemRelation[] | undefined
): WorkItemRelationsSummary {
  const normalized = (relations ?? []).map(normalizeRelation);

  return {
    relations: normalized,
    workItemLinks: normalized.filter(relation => relation.type === 'workItem'),
    hyperlinks: normalized.filter(relation => relation.type === 'hyperlink'),
  };
}

/**
 * Build the relation value for an add-link JSON Patch operation
 */
export function buildLinkAddPatchValue(
  link: WorkItemLinkInput,
  organizationUrl: string
): WorkItemRelation {
  const kind = inferLinkKind(link);

  if (kind === 'hyperlink') {
    const hyperlinkLink = link as WorkItemLinkHyperlinkInput;
    validateHyperlinkUrl(hyperlinkLink.url);

    const value: WorkItemRelation = {
      rel: 'Hyperlink',
      url: hyperlinkLink.url,
    };

    if (hyperlinkLink.comment) {
      value.attributes = { comment: hyperlinkLink.comment };
    }

    return value;
  }

  const workItemLink = link as WorkItemLinkWorkItemInput;

  return {
    rel: resolveLinkType(workItemLink.linkType),
    url: `${organizationUrl.replace(/\/$/, '')}/_apis/wit/workitems/${workItemLink.targetId}`,
  };
}

/**
 * Find the relation index to remove for a given link input
 */
export function findRelationIndexForRemoval(
  relations: WorkItemRelation[],
  link: WorkItemLinkInput
): number {
  const kind = inferLinkKind(link);

  if (kind === 'hyperlink') {
    const hyperlinkLink = link as WorkItemLinkHyperlinkInput;
    validateHyperlinkUrl(hyperlinkLink.url);
    return relations.findIndex(
      relation => relation.rel === 'Hyperlink' && relation.url === hyperlinkLink.url
    );
  }

  const workItemLink = link as WorkItemLinkWorkItemInput;
  const rel = resolveLinkType(workItemLink.linkType);
  return relations.findIndex(relation => {
    if (relation.rel !== rel) {
      return false;
    }

    const targetId = extractWorkItemIdFromRelationUrl(relation.url);
    return targetId === workItemLink.targetId;
  });
}

/**
 * Check whether a hyperlink URL already exists on the work item
 */
export function hasDuplicateHyperlink(
  relations: WorkItemRelation[] | undefined,
  url: string
): boolean {
  return (relations ?? []).some(relation => relation.rel === 'Hyperlink' && relation.url === url);
}

/**
 * Reject hyperlink inputs for create/update flows that must use dedicated link tools
 */
export function assertWorkItemLinksOnly(links: WorkItemLinkInput[] | undefined): void {
  if (!links?.length) {
    return;
  }

  for (const link of links) {
    if (inferLinkKind(link) === 'hyperlink') {
      throw new Error(
        'Hyperlinks cannot be managed via create/update work item. Use add_work_item_links / remove_work_item_links instead.'
      );
    }
  }
}
