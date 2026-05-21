/**
 * ENG-134: OpenAPI spec validation for the recall endpoint's structured
 * response format. Loads api-spec.json from the repo root and asserts the
 * new parameter, schemas, and references are wired up correctly.
 */
import * as fs from 'fs';
import * as path from 'path';

describe('api-spec.json — recall structured response (ENG-134)', () => {
  let spec: any;

  beforeAll(() => {
    // __dirname → src/memory/dto when running under ts-jest; api-spec.json is at the repo root.
    const specPath = path.resolve(__dirname, '..', '..', '..', 'api-spec.json');
    const raw = fs.readFileSync(specPath, 'utf-8');
    spec = JSON.parse(raw); // throws on malformed JSON — implicit validation
  });

  it('is valid OpenAPI 3.0 with paths and components.schemas', () => {
    expect(spec.openapi).toMatch(/^3\.0/);
    expect(spec.paths).toBeDefined();
    expect(spec.components?.schemas).toBeDefined();
  });

  describe('/v1/memories/query POST', () => {
    let op: any;

    beforeAll(() => {
      op = spec.paths['/v1/memories/query']?.post;
      expect(op).toBeDefined();
    });

    it('declares the response_format query parameter with allowed values', () => {
      const param = op.parameters.find(
        (p: any) => p.name === 'response_format',
      );
      expect(param).toBeDefined();
      expect(param.in).toBe('query');
      expect(param.required).toBe(false);
      expect(param.schema.enum).toEqual(
        expect.arrayContaining(['legacy', 'structured', 'json_v2']),
      );
      expect(param.schema.default).toBe('legacy');
    });

    it('documents the Accept header alternative', () => {
      const accept = op.parameters.find(
        (p: any) => p.name === 'Accept' && p.in === 'header',
      );
      expect(accept).toBeDefined();
      expect(accept.schema.example).toContain('application/vnd.engram.v2+json');
    });

    it('declares both response shapes via oneOf', () => {
      const json = op.responses['201'].content['application/json'];
      expect(json.schema.oneOf).toBeDefined();
      const refs = json.schema.oneOf.map((s: any) => s.$ref);
      expect(refs).toEqual(
        expect.arrayContaining([
          '#/components/schemas/QueryResult',
          '#/components/schemas/StructuredQueryResult',
        ]),
      );
    });

    it('exposes the v2 media type directly', () => {
      const v2 =
        op.responses['201'].content['application/vnd.engram.v2+json'];
      expect(v2).toBeDefined();
      expect(v2.schema.$ref).toBe(
        '#/components/schemas/StructuredQueryResult',
      );
    });

    it('documents X-Response-Format response header', () => {
      const hdrs = op.responses['201'].headers;
      expect(hdrs['X-Response-Format']).toBeDefined();
      expect(hdrs['X-Response-Format'].schema.enum).toContain('json_v2');
    });
  });

  describe('schemas', () => {
    it('defines StructuredMemoryItem with the five typed fields', () => {
      const s = spec.components.schemas.StructuredMemoryItem;
      expect(s).toBeDefined();
      expect(s.required).toEqual(
        expect.arrayContaining([
          'id',
          'fact',
          'source_session',
          'confidence',
          'timestamp',
          'memory_type',
        ]),
      );
      expect(s.properties.fact.type).toBe('string');
      expect(s.properties.source_session.nullable).toBe(true);
      expect(s.properties.confidence.type).toBe('number');
      expect(s.properties.confidence.nullable).toBe(true);
      expect(s.properties.timestamp.format).toBe('date-time');
      expect(s.properties.memory_type.nullable).toBe(true);
    });

    it('defines StructuredQueryResult with format=json_v2 discriminator', () => {
      const s = spec.components.schemas.StructuredQueryResult;
      expect(s).toBeDefined();
      expect(s.required).toEqual(
        expect.arrayContaining([
          'recallId',
          'memories',
          'queryTokens',
          'latencyMs',
          'format',
        ]),
      );
      expect(s.properties.format.enum).toEqual(['json_v2']);
      expect(s.properties.memories.items.$ref).toBe(
        '#/components/schemas/StructuredMemoryItem',
      );
    });

    it('defines a QueryResult legacy schema for backward compat', () => {
      const s = spec.components.schemas.QueryResult;
      expect(s).toBeDefined();
      expect(s.required).toEqual(
        expect.arrayContaining([
          'recallId',
          'memories',
          'queryTokens',
          'latencyMs',
        ]),
      );
      // legacy explicitly omits the `format` discriminator
      expect(s.required).not.toContain('format');
    });

    it('has no broken $refs in the new schemas', () => {
      const collectRefs = (node: any, out: string[]) => {
        if (!node || typeof node !== 'object') return;
        if (typeof node.$ref === 'string') out.push(node.$ref);
        for (const v of Object.values(node)) collectRefs(v, out);
      };
      const refs: string[] = [];
      collectRefs(spec.components.schemas.StructuredQueryResult, refs);
      collectRefs(spec.components.schemas.StructuredMemoryItem, refs);
      collectRefs(spec.components.schemas.QueryResult, refs);
      for (const ref of refs) {
        expect(ref).toMatch(/^#\/components\/schemas\//);
        const name = ref.replace('#/components/schemas/', '');
        expect(spec.components.schemas[name]).toBeDefined();
      }
    });
  });
});
