/**
 * Engram Campaign Data Benchmark - Runner
 * Runs 30 recall queries against Engram and scores retrieval quality.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// --- Config ---
const ENGRAM_BASE = process.env.ENGRAM_BASE ?? 'http://localhost:3001';
const API_KEY = process.env.ENGRAM_API_KEY ?? '';
const USER_ID = process.env.ENGRAM_USER_ID ?? 'user_123';

if (!API_KEY) {
  console.error('Set ENGRAM_API_KEY before running this benchmark helper.');
  process.exit(1);
}
const DATA_FILE = path.join(__dirname, '../benchmark-data.json');
const OUTPUT_FILE = path.join(__dirname, '../benchmark-results.json');
const DELAY_MS = 200;

const headers = {
  'X-AM-API-Key': API_KEY,
  'X-AM-User-ID': USER_ID,
  'Content-Type': 'application/json',
};

// --- Types ---
interface StoredCampaign {
  id: string;
  clientId: string;
  clientName: string;
  campaignType: 'newsletter' | 'appeal' | 'event' | 're-engage';
  campaignName: string;
  sendDate: string;
  sendDay: string;
  sendTime: string;
  segment: string;
  subjectLine: string;
  subjectStyle: string;
  audienceSize: number;
  openRate: number;
  clickRate: number;
  conversionRate: number | null;
  revenue: number | null;
  avgGift: number | null;
  isQ4: boolean;
  isTueThu: boolean;
  is11am: boolean;
  formatAId: string | null;
  formatBId: string | null;
  formatAContent: string;
  formatBContent: string;
}

interface BenchmarkData {
  generatedAt: string;
  clientAverages: Record<string, Record<string, number>>;
  campaigns: StoredCampaign[];
}

interface QueryDef {
  id: string;
  category: 'semantic_basic' | 'semantic_cross_client' | 'client_specific';
  description: string;
  query: string;
  relevantFilter: (c: StoredCampaign) => boolean;
  clientFilter?: string; // clientId — if set, check client isolation
}

interface RecallResult {
  id: string;
  content: string;
  score: number;
  metadata?: Record<string, unknown>;
  tags?: string[];
}

interface QueryResult {
  queryId: string;
  category: string;
  description: string;
  query: string;
  formatAResults: RecallResult[];
  formatBResults: RecallResult[];
  relevantCount: number;
  formatA: {
    p5: number;
    p10: number;
    clientIsolation: number | null;
    hits5: number;
    hits10: number;
    returnedIds: string[];
  };
  formatB: {
    p5: number;
    p10: number;
    clientIsolation: number | null;
    hits5: number;
    hits10: number;
    returnedIds: string[];
  };
}

interface BenchmarkResults {
  runAt: string;
  totalQueries: number;
  metadataFilteringSupported: boolean;
  metadataFilteringNote: string;
  formatA: {
    meanP5: number;
    meanP10: number;
    meanClientIsolation: number;
    grade: string;
    queryCount: number;
  };
  formatB: {
    meanP5: number;
    meanP10: number;
    meanClientIsolation: number;
    grade: string;
    queryCount: number;
  };
  queries: QueryResult[];
  summary: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function grade(meanP5: number): string {
  if (meanP5 >= 0.8) return 'A';
  if (meanP5 >= 0.6) return 'B';
  if (meanP5 >= 0.4) return 'C';
  return 'D';
}

// --- Recall ---
async function recall(query: string, limit: number, filter?: Record<string, unknown>): Promise<RecallResult[]> {
  try {
    const body: Record<string, unknown> = {
      query,
      limit,
      userId: USER_ID,
      multiQuery: { enabled: false }, // Use raw vector+BM25 path for consistent scoring
    };
    if (filter) body.filter = filter;

    const res = await axios.post(`${ENGRAM_BASE}/v1/recall`, body, { headers });
    const memories: RecallResult[] = (res.data?.memories || res.data?.results || []).map((m: Record<string, unknown>) => ({
      id: (m.id as string) || '',
      content: ((m.raw as string) || (m.content as string)) || '',
      score: (m.score as number) || 0,
      metadata: (m.metadata as Record<string, unknown>) || {},
      tags: (m.tags as string[]) || [],
    }));

    return memories;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Recall failed: ${msg}`);
    return [];
  }
}

// --- Define 30 Queries ---
function buildQueries(campaigns: StoredCampaign[]): QueryDef[] {
  // Pre-compute some useful sets
  const appealCampaigns = campaigns.filter(c => c.campaignType === 'appeal');
  const highOpenRate = campaigns.filter(c => c.openRate > 0.28);
  const q4Appeals = campaigns.filter(c => c.campaignType === 'appeal' && c.isQ4);
  const tueThuSends = campaigns.filter(c => c.isTueThu);
  const highRevenue = campaigns.filter(c => c.revenue !== null && c.revenue > 50000).sort((a, b) => (b.revenue! - a.revenue!));
  const reEngageCampaigns = campaigns.filter(c => c.campaignType === 're-engage');
  const newsletterCampaigns = campaigns.filter(c => c.campaignType === 'newsletter');
  const eventCampaigns = campaigns.filter(c => c.campaignType === 'event');

  // Per-client
  const byClient: Record<string, StoredCampaign[]> = {};
  for (const c of campaigns) {
    if (!byClient[c.clientId]) byClient[c.clientId] = [];
    byClient[c.clientId].push(c);
  }

  const prfb = byClient['powell-river-food-bank'] || [];
  const wcwt = byClient['west-coast-wildlife-trust'] || [];
  const syf = byClient['sunrise-youth-foundation'] || [];
  const phm = byClient['pacific-hope-medical'] || [];
  const acv = byClient['arts-council-vancouver'] || [];

  return [
    // NOTE: Queries use client names + campaign-specific terms to distinguish
    // from Beaux's existing memories (which are about software projects, not nonprofits).
    // Generic "campaign/newsletter" queries overlap with his work on Generosity Catalyst.

    // === CATEGORY 1: Semantic Basic (10 queries) ===
    {
      id: 'q01',
      category: 'semantic_basic',
      description: 'Find all appeal campaigns',
      query: 'Food Bank Wildlife Trust Youth Foundation Medical appeal donation year-end conversion revenue average gift',
      relevantFilter: c => c.campaignType === 'appeal',
    },
    {
      id: 'q02',
      category: 'semantic_basic',
      description: 'Find all newsletter campaigns',
      query: 'Food Bank Wildlife Trust Youth Foundation newsletter monthly community open rate click rate sent contacts',
      relevantFilter: c => c.campaignType === 'newsletter',
    },
    {
      id: 'q03',
      category: 'semantic_basic',
      description: 'Find all event campaigns',
      query: 'Annual Gala Community Breakfast Walk-a-thon event invitation conversion tickets audience',
      relevantFilter: c => c.campaignType === 'event',
    },
    {
      id: 'q04',
      category: 'semantic_basic',
      description: 'Find all re-engagement campaigns',
      query: 'lapsed donors win-back re-engagement inactive donors Food Bank Wildlife Youth Foundation Medical Council',
      relevantFilter: c => c.campaignType === 're-engage',
    },
    {
      id: 'q05',
      category: 'semantic_basic',
      description: 'Find campaigns with high open rates (>28%)',
      query: 'open rate above average outperforms client average Powell River Wildlife Sunrise Pacific Arts',
      relevantFilter: c => c.openRate > 0.28,
    },
    {
      id: 'q06',
      category: 'semantic_basic',
      description: 'Find Q4 year-end campaigns',
      query: 'Year-End Appeal 2025 Q4 December giving season nonprofit fundraising',
      relevantFilter: c => c.isQ4 && c.campaignType === 'appeal',
    },
    {
      id: 'q07',
      category: 'semantic_basic',
      description: 'Find Tuesday or Thursday sends',
      query: 'sent Tuesday Thursday open rate bonus Food Bank Wildlife Youth Medical Arts',
      relevantFilter: c => c.isTueThu,
    },
    {
      id: 'q08',
      category: 'semantic_basic',
      description: 'Find campaigns with urgency subject line style',
      query: 'urgency deadline subject line close the gap help us before midnight appeal',
      relevantFilter: c => c.subjectStyle === 'urgency' || c.subjectStyle === 'deadline',
    },
    {
      id: 'q09',
      category: 'semantic_basic',
      description: 'Find high-revenue campaigns',
      query: 'revenue above average highest revenue appeal event Powell River Wildlife Sunrise Pacific Arts',
      relevantFilter: c => c.revenue !== null && c.revenue > 30000,
    },
    {
      id: 'q10',
      category: 'semantic_basic',
      description: 'Find campaigns with conversion rates above 10%',
      query: 'conversion rate above average donors converted average gift nonprofit Food Bank Wildlife Youth',
      relevantFilter: c => c.conversionRate !== null && c.conversionRate > 0.10,
    },

    // === CATEGORY 2: Semantic Cross-Client (10 queries) ===
    {
      id: 'q11',
      category: 'semantic_cross_client',
      description: 'Find all West Coast Wildlife Trust campaigns',
      query: 'West Coast Wildlife Trust campaign email sent open rate click rate',
      relevantFilter: c => c.clientId === 'west-coast-wildlife-trust',
    },
    {
      id: 'q12',
      category: 'semantic_cross_client',
      description: 'Find all Powell River Food Bank campaigns',
      query: 'Powell River Food Bank campaign email sent open rate click rate',
      relevantFilter: c => c.clientId === 'powell-river-food-bank',
    },
    {
      id: 'q13',
      category: 'semantic_cross_client',
      description: 'Find all Sunrise Youth Foundation campaigns',
      query: 'Sunrise Youth Foundation campaign email sent contacts open rate click rate',
      relevantFilter: c => c.clientId === 'sunrise-youth-foundation',
    },
    {
      id: 'q14',
      category: 'semantic_cross_client',
      description: 'Find all Pacific Hope Medical campaigns',
      query: 'Pacific Hope Medical campaign email sent contacts open rate click rate',
      relevantFilter: c => c.clientId === 'pacific-hope-medical',
    },
    {
      id: 'q15',
      category: 'semantic_cross_client',
      description: 'Find all Arts Council Vancouver campaigns',
      query: 'Arts Council Vancouver campaign email sent contacts open rate click rate',
      relevantFilter: c => c.clientId === 'arts-council-vancouver',
    },
    {
      id: 'q16',
      category: 'semantic_cross_client',
      description: 'Compare appeal performance across all clients',
      query: 'appeal conversion revenue average gift Powell River Wildlife Sunrise Pacific Arts',
      relevantFilter: c => c.campaignType === 'appeal',
    },
    {
      id: 'q17',
      category: 'semantic_cross_client',
      description: 'Find small nonprofit campaigns',
      query: 'Powell River Food Bank Sunrise Youth Foundation small nonprofit open rate click rate',
      relevantFilter: c => c.clientId === 'powell-river-food-bank' || c.clientId === 'sunrise-youth-foundation',
    },
    {
      id: 'q18',
      category: 'semantic_cross_client',
      description: 'Find campaigns with 11am send time',
      query: '11am send time peak engagement nonprofit campaign open rate',
      relevantFilter: c => c.is11am,
    },
    {
      id: 'q19',
      category: 'semantic_cross_client',
      description: 'Find Giving Tuesday campaigns',
      query: 'Giving Tuesday 2025 nonprofit campaign conversion revenue',
      relevantFilter: c => c.campaignName.toLowerCase().includes('giving tuesday'),
    },
    {
      id: 'q20',
      category: 'semantic_cross_client',
      description: 'Find spring appeal campaigns',
      query: 'Spring Appeal 2025 nonprofit fundraising conversion revenue',
      relevantFilter: c => c.campaignName.toLowerCase().includes('spring') && c.campaignType === 'appeal',
    },

    // === CATEGORY 3: Client-Specific (10 queries) ===
    {
      id: 'q21',
      category: 'client_specific',
      description: 'Powell River Food Bank: all campaigns',
      query: 'Powell River Food Bank campaign open rate click rate sent contacts donors',
      relevantFilter: c => c.clientId === 'powell-river-food-bank',
      clientFilter: 'powell-river-food-bank',
    },
    {
      id: 'q22',
      category: 'client_specific',
      description: 'West Coast Wildlife Trust: appeal campaigns',
      query: 'West Coast Wildlife Trust appeal donation conversion revenue average gift',
      relevantFilter: c => c.clientId === 'west-coast-wildlife-trust' && c.campaignType === 'appeal',
      clientFilter: 'west-coast-wildlife-trust',
    },
    {
      id: 'q23',
      category: 'client_specific',
      description: 'Sunrise Youth Foundation: all campaigns',
      query: 'Sunrise Youth Foundation campaign newsletter appeal event open rate click rate sent',
      relevantFilter: c => c.clientId === 'sunrise-youth-foundation',
      clientFilter: 'sunrise-youth-foundation',
    },
    {
      id: 'q24',
      category: 'client_specific',
      description: 'Pacific Hope Medical: high revenue campaigns',
      query: 'Pacific Hope Medical revenue appeal event conversion average gift donors',
      relevantFilter: c => c.clientId === 'pacific-hope-medical' && c.revenue !== null && c.revenue > 50000,
      clientFilter: 'pacific-hope-medical',
    },
    {
      id: 'q25',
      category: 'client_specific',
      description: 'Arts Council Vancouver: event campaigns',
      query: 'Arts Council Vancouver Annual Gala Breakfast Walk-a-thon event conversion',
      relevantFilter: c => c.clientId === 'arts-council-vancouver' && c.campaignType === 'event',
      clientFilter: 'arts-council-vancouver',
    },
    {
      id: 'q26',
      category: 'client_specific',
      description: 'Powell River Food Bank: year-end appeal campaigns',
      query: 'Powell River Food Bank Year-End Appeal 2025 Q4 December conversion revenue',
      relevantFilter: c => c.clientId === 'powell-river-food-bank' && c.isQ4 && c.campaignType === 'appeal',
      clientFilter: 'powell-river-food-bank',
    },
    {
      id: 'q27',
      category: 'client_specific',
      description: 'West Coast Wildlife Trust: newsletter campaigns',
      query: 'West Coast Wildlife Trust newsletter monthly open rate click rate contacts sent',
      relevantFilter: c => c.clientId === 'west-coast-wildlife-trust' && c.campaignType === 'newsletter',
      clientFilter: 'west-coast-wildlife-trust',
    },
    {
      id: 'q28',
      category: 'client_specific',
      description: 'Pacific Hope Medical: re-engagement campaigns',
      query: 'Pacific Hope Medical lapsed donors win-back re-engagement conversion',
      relevantFilter: c => c.clientId === 'pacific-hope-medical' && c.campaignType === 're-engage',
      clientFilter: 'pacific-hope-medical',
    },
    {
      id: 'q29',
      category: 'client_specific',
      description: 'Sunrise Youth Foundation: campaigns above average open rate',
      query: 'Sunrise Youth Foundation open rate above client average outperforms',
      relevantFilter: c => {
        if (c.clientId !== 'sunrise-youth-foundation') return false;
        const syfCampaigns = campaigns.filter(x => x.clientId === 'sunrise-youth-foundation');
        const avgOpen = syfCampaigns.reduce((s, x) => s + x.openRate, 0) / syfCampaigns.length;
        return c.openRate > avgOpen;
      },
      clientFilter: 'sunrise-youth-foundation',
    },
    {
      id: 'q30',
      category: 'client_specific',
      description: 'Arts Council Vancouver: campaigns with conversion data',
      query: 'Arts Council Vancouver conversion rate revenue average gift donors event appeal',
      relevantFilter: c => c.clientId === 'arts-council-vancouver' && c.conversionRate !== null,
      clientFilter: 'arts-council-vancouver',
    },
  ];
}

// --- Score a set of results ---
function scoreResults(
  results: RecallResult[],
  relevantIds: Set<string>,
  clientIdsForFilter?: Set<string>,  // All IDs (A or B) for the target client
): { p5: number; p10: number; clientIsolation: number | null; hits5: number; hits10: number; returnedIds: string[] } {
  const returnedIds = results.map(r => r.id);
  const top5 = results.slice(0, 5);
  const top10 = results.slice(0, 10);

  let hits5 = 0;
  let hits10 = 0;

  for (const r of top5) {
    if (relevantIds.has(r.id)) hits5++;
  }
  for (const r of top10) {
    if (relevantIds.has(r.id)) hits10++;
  }

  const p5 = top5.length > 0 ? hits5 / Math.min(5, top5.length) : 0;
  const p10 = top10.length > 0 ? hits10 / Math.min(10, top10.length) : 0;

  // Client isolation: among top 10, what fraction are from the correct client?
  let clientIsolation: number | null = null;
  if (clientIdsForFilter) {
    const correctClient = top10.filter(r => clientIdsForFilter.has(r.id));
    clientIsolation = top10.length > 0 ? correctClient.length / top10.length : 0;
  }

  return { p5, p10, clientIsolation, hits5, hits10, returnedIds };
}

// --- Test metadata filtering ---
async function testMetadataFiltering(campaigns: StoredCampaign[]): Promise<{ supported: boolean; note: string }> {
  // Engram API does not store metadata/tags fields (they're accepted but ignored).
  // Test if the recall endpoint supports any filter param at all.
  const appealIds = new Set(campaigns.filter(c => c.campaignType === 'appeal' && c.formatAId).map(c => c.formatAId!));

  try {
    const res = await axios.post(
      `${ENGRAM_BASE}/v1/recall`,
      {
        query: 'appeal donation fundraising',
        limit: 10,
        userId: USER_ID,
        filter: { layer: 'TASK' },
      },
      { headers }
    );

    const memories = res.data?.memories || res.data?.results || [];
    const allTask = memories.every((m: Record<string, unknown>) => m.layer === 'TASK');

    if (memories.length > 0 && allTask) {
      return { supported: true, note: `Layer filter works — got ${memories.length} results, all TASK layer` };
    } else if (memories.length > 0) {
      return { supported: false, note: `Filter param accepted but layer filter not applied — mixed layers returned` };
    } else {
      return { supported: false, note: `Filter accepted but returned 0 results — likely ignored` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { supported: false, note: `Filter param rejected: ${msg}` };
  }
}

// --- Main ---
async function main() {
  console.log('🏁 Engram Campaign Benchmark - Runner');
  console.log('=====================================');

  // Load benchmark data
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ benchmark-data.json not found at ${DATA_FILE}`);
    console.error('   Run data-generator.ts first.');
    process.exit(1);
  }

  const data: BenchmarkData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  const campaigns = data.campaigns;

  const aCount = campaigns.filter(c => c.formatAId !== null).length;
  const bCount = campaigns.filter(c => c.formatBId !== null).length;
  console.log(`✅ Loaded ${campaigns.length} campaigns (${aCount} Format A, ${bCount} Format B IDs)`);

  // Build queries
  const queries = buildQueries(campaigns);
  console.log(`📋 Running ${queries.length} benchmark queries...\n`);

  // Test metadata filtering
  console.log('🔬 Testing metadata filtering support...');
  const metaFilter = await testMetadataFiltering(campaigns);
  console.log(`   ${metaFilter.supported ? '✅' : '⚠️ '} ${metaFilter.note}\n`);
  await sleep(DELAY_MS);

  const queryResults: QueryResult[] = [];

  // Build lookup sets for format A and B IDs (all benchmark memories)
  const allFormatAIds = new Set(campaigns.filter(c => c.formatAId).map(c => c.formatAId!));
  const allFormatBIds = new Set(campaigns.filter(c => c.formatBId).map(c => c.formatBId!));

  for (const q of queries) {
    console.log(`[${q.id}] ${q.description}`);

    // Compute relevant IDs for both formats
    const relevantCampaigns = campaigns.filter(q.relevantFilter);
    const relevantAIds = new Set(relevantCampaigns.filter(c => c.formatAId).map(c => c.formatAId!));
    const relevantBIds = new Set(relevantCampaigns.filter(c => c.formatBId).map(c => c.formatBId!));

    // Single recall — large limit + disable multiQuery for raw vector results
    // Our 200 benchmark memories have 0 retrievals; established memories have high usage scores
    // Disable multiQuery to avoid its topK cap and use raw vector+BM25 path
    const raw = await recall(q.query, 1000);
    await sleep(DELAY_MS);

    // Separate format A and format B results (by ID membership)
    const formatAResults = raw.filter(r => allFormatAIds.has(r.id)).slice(0, 10);
    const formatBResults = raw.filter(r => allFormatBIds.has(r.id)).slice(0, 10);

    // Build client-specific ID sets for isolation scoring
    let clientAIds: Set<string> | undefined;
    let clientBIds: Set<string> | undefined;
    if (q.clientFilter) {
      const clientCampaigns = campaigns.filter(c => c.clientId === q.clientFilter);
      clientAIds = new Set(clientCampaigns.filter(c => c.formatAId).map(c => c.formatAId!));
      clientBIds = new Set(clientCampaigns.filter(c => c.formatBId).map(c => c.formatBId!));
    }

    const aScore = scoreResults(formatAResults, relevantAIds, clientAIds);
    const bScore = scoreResults(formatBResults, relevantBIds, clientBIds);

    console.log(`   Relevant: ${relevantCampaigns.length} | A P@5: ${(aScore.p5 * 100).toFixed(0)}% (${aScore.hits5}/5) | B P@5: ${(bScore.p5 * 100).toFixed(0)}% (${bScore.hits5}/5)`);

    queryResults.push({
      queryId: q.id,
      category: q.category,
      description: q.description,
      query: q.query,
      formatAResults: formatAResults.slice(0, 10),
      formatBResults: formatBResults.slice(0, 10),
      relevantCount: relevantCampaigns.length,
      formatA: aScore,
      formatB: bScore,
    });
  }

  // Aggregate scores
  const aP5s = queryResults.map(r => r.formatA.p5);
  const bP5s = queryResults.map(r => r.formatB.p5);
  const aP10s = queryResults.map(r => r.formatA.p10);
  const bP10s = queryResults.map(r => r.formatB.p10);

  const aMeanP5 = aP5s.reduce((s, v) => s + v, 0) / aP5s.length;
  const bMeanP5 = bP5s.reduce((s, v) => s + v, 0) / bP5s.length;
  const aMeanP10 = aP10s.reduce((s, v) => s + v, 0) / aP10s.length;
  const bMeanP10 = bP10s.reduce((s, v) => s + v, 0) / bP10s.length;

  const aClientQueries = queryResults.filter(r => r.formatA.clientIsolation !== null);
  const bClientQueries = queryResults.filter(r => r.formatB.clientIsolation !== null);

  const aMeanCI = aClientQueries.length > 0
    ? aClientQueries.reduce((s, r) => s + (r.formatA.clientIsolation ?? 0), 0) / aClientQueries.length
    : 0;
  const bMeanCI = bClientQueries.length > 0
    ? bClientQueries.reduce((s, r) => s + (r.formatB.clientIsolation ?? 0), 0) / bClientQueries.length
    : 0;

  const aGrade = grade(aMeanP5);
  const bGrade = grade(bMeanP5);

  const results: BenchmarkResults = {
    runAt: new Date().toISOString(),
    totalQueries: queries.length,
    metadataFilteringSupported: metaFilter.supported,
    metadataFilteringNote: metaFilter.note,
    formatA: {
      meanP5: parseFloat(aMeanP5.toFixed(4)),
      meanP10: parseFloat(aMeanP10.toFixed(4)),
      meanClientIsolation: parseFloat(aMeanCI.toFixed(4)),
      grade: aGrade,
      queryCount: queryResults.length,
    },
    formatB: {
      meanP5: parseFloat(bMeanP5.toFixed(4)),
      meanP10: parseFloat(bMeanP10.toFixed(4)),
      meanClientIsolation: parseFloat(bMeanCI.toFixed(4)),
      grade: bGrade,
      queryCount: queryResults.length,
    },
    queries: queryResults,
    summary: `Format A: Grade ${aGrade} (P@5=${(aMeanP5 * 100).toFixed(1)}%, P@10=${(aMeanP10 * 100).toFixed(1)}%, CI=${(aMeanCI * 100).toFixed(1)}%) | Format B: Grade ${bGrade} (P@5=${(bMeanP5 * 100).toFixed(1)}%, P@10=${(bMeanP10 * 100).toFixed(1)}%, CI=${(bMeanCI * 100).toFixed(1)}%)`,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

  // Print summary
  console.log('\n');
  console.log('═══════════════════════════════════════════════════');
  console.log('  BENCHMARK RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`\n  Format A (raw prose):`);
  console.log(`    Grade:              ${aGrade}`);
  console.log(`    Mean P@5:           ${(aMeanP5 * 100).toFixed(1)}%`);
  console.log(`    Mean P@10:          ${(aMeanP10 * 100).toFixed(1)}%`);
  console.log(`    Client Isolation:   ${(aMeanCI * 100).toFixed(1)}%`);
  console.log(`\n  Format B (pre-computed insights):`);
  console.log(`    Grade:              ${bGrade}`);
  console.log(`    Mean P@5:           ${(bMeanP5 * 100).toFixed(1)}%`);
  console.log(`    Mean P@10:          ${(bMeanP10 * 100).toFixed(1)}%`);
  console.log(`    Client Isolation:   ${(bMeanCI * 100).toFixed(1)}%`);
  console.log(`\n  Metadata Filtering:  ${metaFilter.supported ? 'SUPPORTED ✅' : 'NOT SUPPORTED ⚠️'}`);
  console.log(`    ${metaFilter.note}`);
  console.log(`\n  Results saved to:    ${OUTPUT_FILE}`);
  console.log('═══════════════════════════════════════════════════\n');

  // Per-category breakdown
  const categories = ['semantic_basic', 'semantic_cross_client', 'client_specific'];
  for (const cat of categories) {
    const catQueries = queryResults.filter(r => r.category === cat);
    const catAP5 = catQueries.reduce((s, r) => s + r.formatA.p5, 0) / catQueries.length;
    const catBP5 = catQueries.reduce((s, r) => s + r.formatB.p5, 0) / catQueries.length;
    console.log(`  ${cat.replace(/_/g, ' ').padEnd(25)} A P@5: ${(catAP5 * 100).toFixed(1)}%  B P@5: ${(catBP5 * 100).toFixed(1)}%`);
  }
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
