import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  applySemanticPatch,
  assertLiveAllowed,
  flagApprovalRequest,
  flagPatchRequest,
  getFlagRequest,
  holdoutSetupInstructions,
  LaunchDarklyClient,
  LIVE_ENV_FLAG,
  LIVE_ENV_VALUE,
  parseLdFlag,
  reassignedShare,
  REDACTED_TOKEN,
  rolloutUnitsByArm,
  rolloutWeightsForFlag,
  SEMANTIC_PATCH_CONTENT_TYPE,
  type LdFlag,
  type SemanticInstruction,
} from '../src/launchdarkly.js';

const DOC = JSON.parse(readFileSync(new URL('./fixtures/launchdarkly-doc-examples.json', import.meta.url), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const IMAGE: LdFlag = parseLdFlag(JSON.parse(readFileSync(new URL('../fixtures/flags/suite-default-model-create-image.json', import.meta.url), 'utf8')));
const IMAGE_ARMS = ['nano-banana-pro', 'gpt-image-2-5', 'nano-banana-2', 'gpt-image-2'];

// ---------------------------------------------------------------------------
// Schema of a semantic-patch body as documented (see test/fixtures/launchdarkly-doc-examples.json).
// ---------------------------------------------------------------------------
const weights = z.record(z.string().min(1), z.number().int().min(0).max(100_000));
const rolloutFields = {
  rolloutWeights: weights,
  rolloutBucketBy: z.string().optional(),
  rolloutContextKind: z.string().optional(),
};
const clause = z.strictObject({
  contextKind: z.string(),
  attribute: z.string(),
  op: z.string().regex(/^[a-z][a-zA-Z]*$/), // "The op must be lower-case" (camelCase names such as segmentMatch)
  negate: z.boolean(),
  values: z.array(z.union([z.string(), z.number(), z.boolean()])),
});
const instruction = z.union([
  z.strictObject({ kind: z.literal('updateFallthroughVariationOrRollout'), ...rolloutFields }),
  z.strictObject({ kind: z.literal('updateFallthroughVariationOrRollout'), variationId: z.string() }),
  z.strictObject({ kind: z.literal('updateRuleVariationOrRollout'), ruleId: z.string().min(1), ...rolloutFields }),
  z.strictObject({ kind: z.literal('updateRuleVariationOrRollout'), ruleId: z.string().min(1), variationId: z.string() }),
  z.strictObject({ kind: z.literal('addRule'), clauses: z.array(clause).min(1), beforeRuleId: z.string().optional(), ...rolloutFields }),
]);
const SemanticPatchBody = z.strictObject({
  environmentKey: z.string().min(1),
  comment: z.string().optional(),
  instructions: z.array(instruction).min(1),
});
const ApprovalBody = z.strictObject({
  description: z.string().min(1),
  instructions: z.array(z.looseObject({ kind: z.string() })).min(1),
  comment: z.string().optional(),
  notifyMemberIds: z.array(z.string()).optional(),
  notifyTeamKeys: z.array(z.string()).optional(),
});

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('documented shapes (anchor)', () => {
  it('the schema accepts the verbatim LaunchDarkly doc examples', () => {
    for (const key of ['updateFallthroughVariationOrRollout', 'updateRuleVariationOrRollout', 'addRule']) {
      const parsed = SemanticPatchBody.safeParse(DOC[key]);
      expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    const { _note, ...approval } = DOC.approvalRequestForFlag;
    expect(ApprovalBody.safeParse(approval).success).toBe(true);
  });
});

describe('flag snapshot helpers', () => {
  it('reads the current fallthrough and rule rollouts by arm (units of 1/1000 %)', () => {
    const env = IMAGE.environments.production!;
    const ft = rolloutUnitsByArm(IMAGE, env.fallthrough, IMAGE_ARMS);
    expect([...ft.units.entries()]).toEqual([
      ['nano-banana-pro', 40_000],
      ['gpt-image-2-5', 20_000],
      ['nano-banana-2', 20_000],
      ['gpt-image-2', 20_000],
    ]);
    expect(ft.unmanagedUnits).toBe(0);
    expect(ft.isExperiment).toBe(false);
  });

  it('treats a single served variation as 100% on that arm and flags LaunchDarkly experiments', () => {
    const single = rolloutUnitsByArm(IMAGE, { variation: 1 }, IMAGE_ARMS);
    expect(single.units.get('gpt-image-2-5')).toBe(100_000);
    const exp = rolloutUnitsByArm(
      IMAGE,
      { rollout: { variations: [{ variation: 0, weight: 50_000 }, { variation: 1, weight: 50_000 }], seed: 123, experimentAllocation: { defaultVariation: 0, canReshuffle: false } } },
      IMAGE_ARMS,
    );
    expect(exp.isExperiment).toBe(true);
  });

  it('counts weight on variations the allocator does not manage', () => {
    const r = rolloutUnitsByArm(IMAGE, IMAGE.environments.production!.fallthrough, ['gpt-image-2-5', 'gpt-image-2']);
    expect(r.unmanagedUnits).toBe(60_000);
  });

  it('writes EVERY variation id explicitly (0 for unmanaged) and requires a 100000 total', () => {
    const w = rolloutWeightsForFlag(IMAGE, new Map([['gpt-image-2-5', 60_000], ['gpt-image-2', 40_000]]));
    expect(Object.keys(w).sort()).toEqual(IMAGE.variations.map((v) => v._id).sort());
    expect(w['5b1e0c3a-6f2d-4c1b-9e7a-0a0000000001']).toBe(0);
    expect(sum(w)).toBe(100_000);
    expect(() => rolloutWeightsForFlag(IMAGE, new Map([['gpt-image-2-5', 99_999]]))).toThrow(/100000/);
    expect(() => rolloutWeightsForFlag(IMAGE, new Map([['not-an-arm', 100_000]]))).toThrow(/variation/);
  });
});

describe('semantic patch request', () => {
  const instructions: SemanticInstruction[] = [
    {
      kind: 'updateFallthroughVariationOrRollout',
      rolloutWeights: rolloutWeightsForFlag(IMAGE, new Map([['nano-banana-pro', 30_000], ['gpt-image-2-5', 30_000], ['nano-banana-2', 20_000], ['gpt-image-2', 20_000]])),
      rolloutBucketBy: 'key',
      rolloutContextKind: 'user',
    },
    {
      kind: 'updateRuleVariationOrRollout',
      ruleId: '9d7c1a20-0b4e-4f6a-8c11-1a0000000002',
      rolloutWeights: rolloutWeightsForFlag(IMAGE, new Map([['nano-banana-pro', 30_000], ['gpt-image-2-5', 30_000], ['nano-banana-2', 20_000], ['gpt-image-2', 20_000]])),
      rolloutBucketBy: 'key',
      rolloutContextKind: 'user',
    },
  ];

  it('is a PATCH to /api/v2/flags/{project}/{flag} with the semantic-patch content type', () => {
    const req = flagPatchRequest({ projectKey: 'default', flagKey: IMAGE.key, environmentKey: 'production', instructions, comment: 'why' });
    expect(req.method).toBe('PATCH');
    expect(req.url).toBe('https://app.launchdarkly.com/api/v2/flags/default/suite-default-model-create-image');
    expect(req.headers['Content-Type']).toBe(SEMANTIC_PATCH_CONTENT_TYPE);
    expect(req.headers['Content-Type']).toBe(DOC.headers['Content-Type']);
    expect(req.headers['LD-API-Version']).toBe(DOC.headers['LD-API-Version']);
    expect(req.headers.Authorization).toBe(REDACTED_TOKEN);
    const body = SemanticPatchBody.parse(req.body);
    expect(body.environmentKey).toBe('production');
    expect(body.comment).toBe('why');
    for (const ins of body.instructions) if ('rolloutWeights' in ins) expect(sum(ins.rolloutWeights)).toBe(100_000);
  });

  it('url-encodes keys and can ask LaunchDarkly to validate only (?dryRun=true)', () => {
    const req = flagPatchRequest({ projectKey: 'my proj', flagKey: IMAGE.key, environmentKey: 'production', instructions, comment: 'x', validateOnly: true });
    expect(req.url).toBe('https://app.launchdarkly.com/api/v2/flags/my%20proj/suite-default-model-create-image?dryRun=true');
  });

  it('builds the flag-specific approval request (rollout changes need this endpoint)', () => {
    const req = flagApprovalRequest({
      projectKey: 'default',
      flagKey: IMAGE.key,
      environmentKey: 'production',
      instructions,
      description: 'Daily default-model allocation',
      comment: 'why',
      notifyTeamKeys: ['growth-data'],
    });
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://app.launchdarkly.com/api/v2/projects/default/flags/suite-default-model-create-image/environments/production/approval-requests');
    expect(req.headers['Content-Type']).toBe('application/json');
    const body = ApprovalBody.parse(req.body);
    expect(body.instructions).toEqual(instructions);
    expect('environmentKey' in (req.body as object)).toBe(false);
  });

  it('reads flags with an explicit env filter', () => {
    const req = getFlagRequest({ projectKey: 'default', flagKey: IMAGE.key, environmentKey: 'production' });
    expect(req.method).toBe('GET');
    expect(req.url).toBe('https://app.launchdarkly.com/api/v2/flags/default/suite-default-model-create-image?env=production');
  });
});

describe('re-bucketing estimate', () => {
  it('measures the share of the bucket range whose variation changes', () => {
    expect(reassignedShare([50_000, 50_000], [50_000, 50_000])).toBe(0);
    // LaunchDarkly's own example: A 50% -> 70% moves buckets 50,001-70,000.
    expect(reassignedShare([50_000, 50_000], [70_000, 30_000])).toBeCloseTo(0.2, 12);
    // Moving weight between the first and the last arm shifts every boundary in between.
    expect(reassignedShare([25_000, 25_000, 25_000, 25_000], [35_000, 25_000, 25_000, 15_000])).toBeCloseTo(0.3, 12);
  });
});

describe('LaunchDarkly emulator (applies our instructions to a snapshot)', () => {
  it('round-trips a daily patch and bumps the environment version', () => {
    const w = new Map([['nano-banana-pro', 30_000], ['gpt-image-2-5', 30_000], ['nano-banana-2', 20_000], ['gpt-image-2', 20_000]]);
    const next = applySemanticPatch(IMAGE, 'production', [
      { kind: 'updateFallthroughVariationOrRollout', rolloutWeights: rolloutWeightsForFlag(IMAGE, w), rolloutBucketBy: 'key', rolloutContextKind: 'user' },
    ]);
    expect(rolloutUnitsByArm(next, next.environments.production!.fallthrough, IMAGE_ARMS).units).toEqual(w);
    expect(next.environments.production!.version).toBe(29);
    // The input snapshot is not mutated.
    expect(IMAGE.environments.production!.version).toBe(28);
  });

  it('rejects unknown variation ids, bad totals and unknown rules (all-or-nothing like LaunchDarkly)', () => {
    expect(() => applySemanticPatch(IMAGE, 'production', [{ kind: 'updateFallthroughVariationOrRollout', rolloutWeights: { nope: 100_000 } }])).toThrow();
    expect(() =>
      applySemanticPatch(IMAGE, 'production', [{ kind: 'updateFallthroughVariationOrRollout', rolloutWeights: { '5b1e0c3a-6f2d-4c1b-9e7a-0a0000000001': 10 } }]),
    ).toThrow(/100000/);
    expect(() =>
      applySemanticPatch(IMAGE, 'production', [
        { kind: 'updateRuleVariationOrRollout', ruleId: 'missing', rolloutWeights: rolloutWeightsForFlag(IMAGE, new Map([['gpt-image-2', 100_000]])) },
      ]),
    ).toThrow(/rule/);
  });
});

describe('one-time setup (holdout + segment rules)', () => {
  it('adds the holdout rule with a uniform rollout, then the segment rules, all behind existing rules', () => {
    const bare: LdFlag = { ...IMAGE, environments: { production: { ...IMAGE.environments.production!, rules: [] } } };
    const ins = holdoutSetupInstructions({
      flag: bare,
      environmentKey: 'production',
      arms: IMAGE_ARMS,
      holdoutClause: { contextKind: 'user', attribute: 'key', op: 'matches', values: ['[0-5]$'], negate: false },
      ruleClauses: [[{ contextKind: 'user', attribute: 'country', op: 'in', values: ['US'], negate: false }]],
      initialUnits: new Map([['nano-banana-pro', 40_000], ['gpt-image-2-5', 20_000], ['nano-banana-2', 20_000], ['gpt-image-2', 20_000]]),
      rolloutContextKind: 'user',
      rolloutBucketBy: 'key',
    });
    expect(ins.map((i) => i.kind)).toEqual(['addRule', 'addRule']);
    const holdout = ins[0]! as Extract<SemanticInstruction, { kind: 'addRule' }>;
    expect(Object.values(holdout.rolloutWeights)).toEqual([25_000, 25_000, 25_000, 25_000]);
    expect(holdout.clauses[0]!.op).toBe('matches');
    expect(SemanticPatchBody.safeParse({ environmentKey: 'production', instructions: ins }).success).toBe(true);
    const applied = applySemanticPatch(bare, 'production', ins);
    expect(applied.environments.production!.rules.length).toBe(2);
    expect(applied.environments.production!.rules[0]!.clauses[0]!.attribute).toBe('key');
  });

  it('is idempotent: rules that already exist are not added again', () => {
    const ins = holdoutSetupInstructions({
      flag: IMAGE,
      environmentKey: 'production',
      arms: IMAGE_ARMS,
      holdoutClause: { contextKind: 'user', attribute: 'key', op: 'matches', values: ['[0-5]$'], negate: false },
      ruleClauses: [[{ contextKind: 'user', attribute: 'country', op: 'in', values: ['US'], negate: false }]],
      initialUnits: new Map([['nano-banana-pro', 25_000], ['gpt-image-2-5', 25_000], ['nano-banana-2', 25_000], ['gpt-image-2', 25_000]]),
      rolloutContextKind: 'user',
      rolloutBucketBy: 'key',
    });
    expect(ins).toEqual([]);
  });
});

describe('client safety', () => {
  const req = flagPatchRequest({ projectKey: 'default', flagKey: IMAGE.key, environmentKey: 'production', instructions: [{ kind: 'updateFallthroughVariationOrRollout', variationId: 'x' }], comment: 'c' });

  it('dry-run prints the request and never touches the network', async () => {
    const lines: string[] = [];
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new LaunchDarklyClient({ mode: 'dry-run', log: (s) => lines.push(s) });
    const result = await client.submit(req);
    expect(result).toEqual({ mode: 'dry-run', request: req });
    expect(lines.join('\n')).toContain('"kind": "updateFallthroughVariationOrRollout"');
    expect(lines.join('\n')).toContain('DRY RUN');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('live mode refuses without the explicit environment switch, token and transport', () => {
    expect(() => assertLiveAllowed({})).toThrow(new RegExp(LIVE_ENV_FLAG));
    expect(() => assertLiveAllowed({ [LIVE_ENV_FLAG]: 'true', LD_API_TOKEN: 't' })).toThrow(new RegExp(LIVE_ENV_VALUE));
    expect(() => assertLiveAllowed({ [LIVE_ENV_FLAG]: LIVE_ENV_VALUE })).toThrow(/LD_API_TOKEN/);
    expect(() => new LaunchDarklyClient({ mode: 'live', env: {} })).toThrow(new RegExp(LIVE_ENV_FLAG));
    expect(() => new LaunchDarklyClient({ mode: 'live', env: { [LIVE_ENV_FLAG]: LIVE_ENV_VALUE, LD_API_TOKEN: 't' } })).toThrow(/transport/);
  });
});
