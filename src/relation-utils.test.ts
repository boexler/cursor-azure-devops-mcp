import { describe, expect, it } from 'vitest';
import {
  assertWorkItemLinksOnly,
  buildLinkAddPatchValue,
  buildRelationsSummary,
  findRelationIndexForRemoval,
  hasDuplicateHyperlink,
  inferLinkKind,
  normalizeRelation,
  validateHyperlinkUrl,
} from './relation-utils.js';
import { WorkItemRelation } from './types.js';

describe('inferLinkKind', () => {
  it('defaults to workItem when targetId and linkType are provided', () => {
    expect(inferLinkKind({ targetId: 207, linkType: 'Parent' })).toBe('workItem');
  });

  it('returns hyperlink when kind is hyperlink', () => {
    expect(
      inferLinkKind({
        kind: 'hyperlink',
        url: 'https://gitlab.example.com/mr/18',
      })
    ).toBe('hyperlink');
  });
});

describe('validateHyperlinkUrl', () => {
  it('accepts http and https URLs', () => {
    expect(() => validateHyperlinkUrl('https://example.com')).not.toThrow();
    expect(() => validateHyperlinkUrl('http://example.com')).not.toThrow();
  });

  it('rejects invalid URLs', () => {
    expect(() => validateHyperlinkUrl('ftp://example.com')).toThrow(/http:\/\/ or https:\/\//);
    expect(() => validateHyperlinkUrl('not-a-url')).toThrow(/http:\/\/ or https:\/\//);
  });
});

describe('normalizeRelation', () => {
  it('normalizes work item links', () => {
    const relation: WorkItemRelation = {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: 'https://dev.azure.com/org/_apis/wit/workitems/207',
      attributes: { comment: 'parent link' },
    };

    expect(normalizeRelation(relation)).toEqual({
      type: 'workItem',
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: relation.url,
      targetId: 207,
      linkType: 'Parent',
      attributes: { comment: 'parent link' },
    });
  });

  it('normalizes hyperlinks', () => {
    const relation: WorkItemRelation = {
      rel: 'Hyperlink',
      url: 'https://gitlab.example.com/mr/18',
      attributes: { comment: 'MR' },
    };

    expect(normalizeRelation(relation)).toEqual({
      type: 'hyperlink',
      rel: 'Hyperlink',
      url: relation.url,
      linkType: 'Hyperlink',
      attributes: { comment: 'MR' },
    });
  });

  it('normalizes other relations such as attachments', () => {
    const relation: WorkItemRelation = {
      rel: 'AttachedFile',
      url: 'https://dev.azure.com/org/_apis/wit/attachments/1',
    };

    expect(normalizeRelation(relation)).toEqual({
      type: 'other',
      rel: 'AttachedFile',
      url: relation.url,
      attributes: undefined,
    });
  });
});

describe('buildRelationsSummary', () => {
  it('splits work item links and hyperlinks', () => {
    const relations: WorkItemRelation[] = [
      {
        rel: 'System.LinkTypes.Related',
        url: 'https://dev.azure.com/org/_apis/wit/workitems/10',
      },
      {
        rel: 'Hyperlink',
        url: 'https://gitlab.example.com/mr/18',
      },
      {
        rel: 'AttachedFile',
        url: 'https://dev.azure.com/org/_apis/wit/attachments/1',
      },
    ];

    const summary = buildRelationsSummary(relations);

    expect(summary.relations).toHaveLength(3);
    expect(summary.workItemLinks).toHaveLength(1);
    expect(summary.hyperlinks).toHaveLength(1);
    expect(summary.hyperlinks[0].url).toBe('https://gitlab.example.com/mr/18');
  });
});

describe('buildLinkAddPatchValue', () => {
  it('builds a hyperlink patch value', () => {
    expect(
      buildLinkAddPatchValue(
        {
          kind: 'hyperlink',
          url: 'https://gitlab.example.com/mr/18',
          comment: 'Review',
        },
        'https://dev.azure.com/org'
      )
    ).toEqual({
      rel: 'Hyperlink',
      url: 'https://gitlab.example.com/mr/18',
      attributes: { comment: 'Review' },
    });
  });

  it('builds a work item link patch value', () => {
    expect(
      buildLinkAddPatchValue({ targetId: 207, linkType: 'Parent' }, 'https://dev.azure.com/org/')
    ).toEqual({
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: 'https://dev.azure.com/org/_apis/wit/workitems/207',
    });
  });
});

describe('findRelationIndexForRemoval', () => {
  const relations: WorkItemRelation[] = [
    {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: 'https://dev.azure.com/org/_apis/wit/workitems/207',
    },
    {
      rel: 'Hyperlink',
      url: 'https://gitlab.example.com/mr/18',
    },
  ];

  it('finds work item link indices', () => {
    expect(
      findRelationIndexForRemoval(relations, {
        targetId: 207,
        linkType: 'Parent',
      })
    ).toBe(0);
  });

  it('finds hyperlink indices by exact URL', () => {
    expect(
      findRelationIndexForRemoval(relations, {
        kind: 'hyperlink',
        url: 'https://gitlab.example.com/mr/18',
      })
    ).toBe(1);
  });

  it('returns -1 when relation is missing', () => {
    expect(
      findRelationIndexForRemoval(relations, {
        kind: 'hyperlink',
        url: 'https://gitlab.example.com/mr/99',
      })
    ).toBe(-1);
  });
});

describe('hasDuplicateHyperlink', () => {
  it('detects duplicate hyperlink URLs', () => {
    const relations: WorkItemRelation[] = [
      {
        rel: 'Hyperlink',
        url: 'https://gitlab.example.com/mr/18',
      },
    ];

    expect(hasDuplicateHyperlink(relations, 'https://gitlab.example.com/mr/18')).toBe(true);
    expect(hasDuplicateHyperlink(relations, 'https://gitlab.example.com/mr/19')).toBe(false);
  });
});

describe('assertWorkItemLinksOnly', () => {
  it('allows work item links', () => {
    expect(() => assertWorkItemLinksOnly([{ targetId: 207, linkType: 'Parent' }])).not.toThrow();
  });

  it('rejects hyperlinks for create/update flows', () => {
    expect(() =>
      assertWorkItemLinksOnly([
        {
          kind: 'hyperlink',
          url: 'https://gitlab.example.com/mr/18',
        },
      ])
    ).toThrow(/add_work_item_links/);
  });
});
