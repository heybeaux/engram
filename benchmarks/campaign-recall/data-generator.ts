/**
 * Engram Campaign Data Benchmark - Data Generator
 * Generates 100 synthetic nonprofit email campaigns and stores them in Engram
 * as Format A (raw prose) and Format B (pre-computed insights).
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// --- Config ---
const ENGRAM_BASE = 'http://localhost:3001';
const API_KEY = 'engram_gv9r6c4vesomlekojvkne';
const USER_ID = 'Beaux';
const OUTPUT_FILE = path.join(__dirname, '../benchmark-data.json');
const DELAY_MS = 300;

const headers = {
  'X-AM-API-Key': API_KEY,
  'X-AM-User-ID': USER_ID,
  'Content-Type': 'application/json',
};

// --- Types ---
interface Client {
  id: string;
  name: string;
  sector: string;
  size: 'small' | 'medium' | 'large';
  donorCount: number;
  audienceVariance: number;
}

interface Campaign {
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
}

interface StoredCampaign extends Campaign {
  formatAId: string | null;
  formatBId: string | null;
  formatAContent: string;
  formatBContent: string;
}

// --- Clients ---
const CLIENTS: Client[] = [
  { id: 'powell-river-food-bank', name: 'Powell River Food Bank', sector: 'food bank', size: 'small', donorCount: 3000, audienceVariance: 200 },
  { id: 'west-coast-wildlife-trust', name: 'West Coast Wildlife Trust', sector: 'environmental', size: 'medium', donorCount: 8000, audienceVariance: 500 },
  { id: 'sunrise-youth-foundation', name: 'Sunrise Youth Foundation', sector: 'youth services', size: 'small', donorCount: 2000, audienceVariance: 150 },
  { id: 'pacific-hope-medical', name: 'Pacific Hope Medical', sector: 'health', size: 'large', donorCount: 15000, audienceVariance: 1000 },
  { id: 'arts-council-vancouver', name: 'Arts Council Vancouver', sector: 'arts/culture', size: 'medium', donorCount: 5000, audienceVariance: 300 },
];

// --- Helpers ---
function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Date helpers
function generateDates(): { date: string; day: string; time: string; isQ4: boolean; isTueThu: boolean; is11am: boolean }[] {
  const dates = [];
  // Generate 20 evenly-ish spaced dates over 18 months (Sept 2024 - March 2026)
  const start = new Date('2024-09-01');
  const end = new Date('2026-03-15');
  const totalMs = end.getTime() - start.getTime();

  const times = ['09:00', '10:00', '11:00', '12:00', '13:00', '14:00'];
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  for (let i = 0; i < 20; i++) {
    const offset = (totalMs / 20) * i + rand(0, totalMs / 25);
    const d = new Date(start.getTime() + offset);
    // Snap to a weekday
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);

    const dayName = days[d.getDay() - 1];
    const time = times[Math.floor(Math.random() * times.length)];
    const month = d.getMonth() + 1; // 1-indexed

    dates.push({
      date: d.toISOString().split('T')[0],
      day: dayName,
      time,
      isQ4: month >= 10 && month <= 12,
      isTueThu: dayName === 'Tuesday' || dayName === 'Thursday',
      is11am: time === '11:00',
    });
  }

  return dates.sort((a, b) => a.date.localeCompare(b.date));
}

// Subject line templates
const SUBJECT_TEMPLATES: Record<string, { styles: string[]; templates: string[] }> = {
  newsletter: {
    styles: ['informational', 'storytelling', 'update'],
    templates: [
      'Your {month} update from {client}',
      'What we accomplished together this month',
      'Stories from the front lines — {month} edition',
      'Inside {client}: {month} highlights',
      'How your support made a difference this {month}',
    ],
  },
  appeal: {
    styles: ['urgency', 'impact', 'personal', 'deadline'],
    templates: [
      'Can you help us close the gap?',
      'We need your help by {date}',
      'Your gift today means {impact}',
      'Only {days} days left to make a difference',
      'Will you match this gift?',
      'Double your impact before midnight',
    ],
  },
  event: {
    styles: ['invitation', 'excitement', 'last-chance'],
    templates: [
      "You're invited: {event} benefiting {client}",
      'Join us for an unforgettable evening',
      'Last chance — seats are filling fast',
      'Our biggest event of the year is almost here',
    ],
  },
  're-engage': {
    styles: ['miss-you', 'update', 'comeback'],
    templates: [
      'We miss you, {first_name}',
      'A lot has changed since we last spoke',
      'We wanted you to know about this',
      'Has {client} made a difference for you?',
      'Coming back? Here is what you missed',
    ],
  },
};

// Campaign name templates
const CAMPAIGN_NAMES: Record<string, string[]> = {
  newsletter: [
    'January Newsletter {year}',
    'February Newsletter {year}',
    'March Newsletter {year}',
    'April Newsletter {year}',
    'May Newsletter {year}',
    'June Newsletter {year}',
    'July Newsletter {year}',
    'August Newsletter {year}',
    'September Newsletter {year}',
    'October Newsletter {year}',
    'November Newsletter {year}',
    'December Newsletter {year}',
    'Q1 Community Update {year}',
    'Q2 Community Update {year}',
    'Q3 Community Update {year}',
    'Q4 Community Update {year}',
    'Summer Update {year}',
    'Winter Update {year}',
    'Spring Newsletter {year}',
    'Fall Newsletter {year}',
  ],
  appeal: [
    'Year-End Appeal {year}',
    'Spring Appeal {year}',
    'Giving Tuesday {year}',
    'Emergency Appeal {year}',
    'Anniversary Appeal {year}',
  ],
  event: [
    'Annual Gala {year}',
    'Community Breakfast {year}',
    'Walk-a-thon {year}',
  ],
  're-engage': [
    'Lapsed Donor Re-engagement {year}',
    'Win-Back Campaign {year}',
  ],
};

const SEGMENTS: Record<string, string[]> = {
  newsletter: ['all_donors', 'active_donors', 'newsletter_subscribers'],
  appeal: ['all_donors', 'major_donors', 'mid_level_donors', 'lapsed_donors'],
  event: ['event_attendees', 'major_donors', 'active_donors'],
  're-engage': ['lapsed_donors', 'inactive_12_months', 'inactive_24_months'],
};

function pickSubjectLine(type: string, clientName: string, month: string, year: string): { line: string; style: string } {
  const t = SUBJECT_TEMPLATES[type] || SUBJECT_TEMPLATES.newsletter;
  const style = t.styles[Math.floor(Math.random() * t.styles.length)];
  let template = t.templates[Math.floor(Math.random() * t.templates.length)];
  template = template
    .replace('{client}', clientName)
    .replace('{month}', month)
    .replace('{year}', year)
    .replace('{date}', 'Dec 31')
    .replace('{days}', String(randInt(3, 14)))
    .replace('{impact}', 'everything')
    .replace('{event}', 'our Annual Gala')
    .replace('{first_name}', 'friend');
  return { line: template, style };
}

// --- Campaign generation ---
function generateCampaigns(): Campaign[] {
  const campaigns: Campaign[] = [];

  for (const client of CLIENTS) {
    const dates = generateDates();

    // Types: 10 newsletter, 5 appeal, 3 event, 2 re-engage
    const typeSchedule: Array<Campaign['campaignType']> = [
      ...Array(10).fill('newsletter'),
      ...Array(5).fill('appeal'),
      ...Array(3).fill('event'),
      ...Array(2).fill('re-engage'),
    ];

    const nameCounters: Record<string, number> = {};

    for (let i = 0; i < 20; i++) {
      const type = typeSchedule[i];
      const d = dates[i];
      const dateObj = new Date(d.date);
      const month = dateObj.toLocaleString('en-US', { month: 'long' });
      const year = String(dateObj.getFullYear());

      // Pick campaign name
      const namePool = CAMPAIGN_NAMES[type] || CAMPAIGN_NAMES.newsletter;
      nameCounters[type] = (nameCounters[type] || 0) + 1;
      const nameIdx = (nameCounters[type] - 1) % namePool.length;
      const campaignName = namePool[nameIdx]
        .replace('{year}', year)
        .replace('{month}', month);

      // Pick segment
      const segPool = SEGMENTS[type] || SEGMENTS.newsletter;
      const segment = segPool[Math.floor(Math.random() * segPool.length)];

      // Subject line
      const { line: subjectLine, style: subjectStyle } = pickSubjectLine(type, client.name, month, year);

      // Audience size
      const audienceSize = Math.round(client.donorCount * rand(0.6, 1.0));

      // Performance by type
      let openRate: number;
      let clickRate: number;
      let conversionRate: number | null = null;
      let revenue: number | null = null;
      let avgGift: number | null = null;

      if (type === 'newsletter') {
        openRate = rand(0.18, 0.28);
        clickRate = rand(0.02, 0.04);
      } else if (type === 'appeal') {
        openRate = rand(0.15, 0.25);
        clickRate = rand(0.03, 0.06);
        conversionRate = rand(0.05, 0.15);
        avgGift = rand(25, 200);
        revenue = Math.round(audienceSize * conversionRate * avgGift);
        avgGift = Math.round(avgGift);
      } else if (type === 'event') {
        openRate = rand(0.20, 0.35);
        clickRate = rand(0.05, 0.10);
        conversionRate = rand(0.10, 0.25);
        avgGift = rand(50, 500);
        revenue = Math.round(audienceSize * conversionRate * avgGift);
        avgGift = Math.round(avgGift);
      } else {
        // re-engage
        openRate = rand(0.10, 0.18);
        clickRate = rand(0.01, 0.03);
        conversionRate = rand(0.02, 0.08);
        avgGift = rand(15, 75);
        revenue = Math.round(audienceSize * conversionRate * avgGift);
        avgGift = Math.round(avgGift);
      }

      // Apply variances
      if (d.isTueThu) openRate += 0.03;
      if (d.isQ4 && type === 'appeal') {
        const multiplier = rand(1.20, 1.40);
        openRate *= multiplier;
        clickRate *= multiplier;
        if (conversionRate) conversionRate = Math.min(conversionRate * multiplier, 0.30);
      }
      if (d.is11am) openRate += 0.005;

      // Cap rates
      openRate = Math.min(openRate, 0.60);
      clickRate = Math.min(clickRate, 0.20);

      // Recompute revenue after variance
      if (conversionRate !== null && avgGift !== null) {
        revenue = Math.round(audienceSize * conversionRate * avgGift);
      }

      const campaign: Campaign = {
        id: `${client.id}__${toSlug(campaignName)}__${d.date}`,
        clientId: client.id,
        clientName: client.name,
        campaignType: type,
        campaignName,
        sendDate: d.date,
        sendDay: d.day,
        sendTime: d.time,
        segment,
        subjectLine,
        subjectStyle,
        audienceSize,
        openRate: parseFloat(openRate.toFixed(4)),
        clickRate: parseFloat(clickRate.toFixed(4)),
        conversionRate: conversionRate ? parseFloat(conversionRate.toFixed(4)) : null,
        revenue,
        avgGift,
        isQ4: d.isQ4,
        isTueThu: d.isTueThu,
        is11am: d.is11am,
      };

      campaigns.push(campaign);
    }
  }

  return campaigns;
}

// --- Client averages ---
function computeClientAverages(campaigns: Campaign[]): Record<string, Record<string, number>> {
  const byClient: Record<string, Campaign[]> = {};
  for (const c of campaigns) {
    if (!byClient[c.clientId]) byClient[c.clientId] = [];
    byClient[c.clientId].push(c);
  }

  const avgs: Record<string, Record<string, number>> = {};
  for (const [clientId, clientCampaigns] of Object.entries(byClient)) {
    const openRates = clientCampaigns.map(c => c.openRate);
    const clickRates = clientCampaigns.map(c => c.clickRate);
    const convRates = clientCampaigns.filter(c => c.conversionRate !== null).map(c => c.conversionRate!);
    const revenues = clientCampaigns.filter(c => c.revenue !== null).map(c => c.revenue!);
    const avgGifts = clientCampaigns.filter(c => c.avgGift !== null).map(c => c.avgGift!);

    avgs[clientId] = {
      avgOpenRate: parseFloat((openRates.reduce((a, b) => a + b, 0) / openRates.length).toFixed(4)),
      avgClickRate: parseFloat((clickRates.reduce((a, b) => a + b, 0) / clickRates.length).toFixed(4)),
      avgConvRate: convRates.length > 0 ? parseFloat((convRates.reduce((a, b) => a + b, 0) / convRates.length).toFixed(4)) : 0,
      avgRevenue: revenues.length > 0 ? Math.round(revenues.reduce((a, b) => a + b, 0) / revenues.length) : 0,
      avgGift: avgGifts.length > 0 ? Math.round(avgGifts.reduce((a, b) => a + b, 0) / avgGifts.length) : 0,
    };
  }

  return avgs;
}

// --- Format A (raw prose) ---
function formatA(c: Campaign): string {
  const parts = [
    `Campaign "${c.campaignName}" for ${c.clientName}.`,
    `Sent ${new Date(c.sendDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} (${c.sendDay}) at ${c.sendTime} to ${c.audienceSize.toLocaleString()} contacts (${c.segment.replace(/_/g, ' ')} segment).`,
    `Open rate: ${(c.openRate * 100).toFixed(1)}%. Click rate: ${(c.clickRate * 100).toFixed(1)}%.`,
  ];

  if (c.conversionRate !== null) {
    parts.push(`Conversion rate: ${(c.conversionRate * 100).toFixed(1)}%.`);
  }
  if (c.revenue !== null) {
    parts.push(`Revenue: $${c.revenue.toLocaleString()}.`);
  }
  if (c.avgGift !== null) {
    parts.push(`Average gift: $${c.avgGift}.`);
  }

  parts.push(`Subject line: "${c.subjectLine}" (${c.subjectStyle} style).`);

  return parts.join('\n');
}

// --- Format B (pre-computed insights) ---
function formatB(c: Campaign, clientAvgs: Record<string, Record<string, number>>): string {
  const avgs = clientAvgs[c.clientId];
  const openDiff = ((c.openRate - avgs.avgOpenRate) * 100).toFixed(1);
  const clickDiff = ((c.clickRate - avgs.avgClickRate) * 100).toFixed(1);
  const openDir = c.openRate >= avgs.avgOpenRate ? 'above' : 'below';
  const clickDir = c.clickRate >= avgs.avgClickRate ? 'above' : 'below';

  const lines = [
    `Campaign "${c.campaignName}" for ${c.clientName} (${c.clientId.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')} — ${c.campaignType}).`,
    ``,
    `Send profile: ${new Date(c.sendDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })} (${c.sendDay}) at ${c.sendTime}. Audience: ${c.audienceSize.toLocaleString()} contacts (${c.segment.replace(/_/g, ' ')} segment).`,
    ``,
    `Performance:`,
    `- Open rate: ${(c.openRate * 100).toFixed(1)}% — ${Math.abs(parseFloat(openDiff)).toFixed(1)} points ${openDir} client average (${(avgs.avgOpenRate * 100).toFixed(1)}%)`,
    `- Click rate: ${(c.clickRate * 100).toFixed(1)}% — ${Math.abs(parseFloat(clickDiff)).toFixed(1)} points ${clickDir} client average (${(avgs.avgClickRate * 100).toFixed(1)}%)`,
  ];

  if (c.conversionRate !== null && avgs.avgConvRate > 0) {
    const convDiff = ((c.conversionRate - avgs.avgConvRate) * 100).toFixed(1);
    const convDir = c.conversionRate >= avgs.avgConvRate ? 'above' : 'below';
    lines.push(`- Conversion rate: ${(c.conversionRate * 100).toFixed(1)}% — ${Math.abs(parseFloat(convDiff)).toFixed(1)} points ${convDir} client average (${(avgs.avgConvRate * 100).toFixed(1)}%)`);
  }

  if (c.revenue !== null) {
    const revDiff = c.revenue - avgs.avgRevenue;
    const revDir = revDiff >= 0 ? 'above' : 'below';
    lines.push(`- Revenue: $${c.revenue.toLocaleString()} — $${Math.abs(revDiff).toLocaleString()} ${revDir} client average ($${avgs.avgRevenue.toLocaleString()})`);
  }

  if (c.avgGift !== null) {
    lines.push(`- Average gift: $${c.avgGift} (client avg: $${avgs.avgGift})`);
  }

  lines.push(`- Subject line: "${c.subjectLine}" (${c.subjectStyle} style)`);
  lines.push(``);

  // Context flags
  const flags: string[] = [];
  if (c.isTueThu) flags.push(`Tuesday/Thursday send (+3pt open rate bonus applied)`);
  if (c.isQ4 && c.campaignType === 'appeal') flags.push(`Q4 appeal (seasonal boost: +20-40% lift applied)`);
  if (c.is11am) flags.push(`11am send time (peak engagement window)`);
  if (flags.length > 0) {
    lines.push(`Context: ${flags.join('; ')}.`);
    lines.push(``);
  }

  // Insights
  const insights: string[] = [];
  if (parseFloat(openDiff) >= 3) insights.push(`Open rate outperforms client average by ${openDiff} points — strong subject line or send-time alignment`);
  else if (parseFloat(openDiff) <= -3) insights.push(`Open rate underperforms client average by ${Math.abs(parseFloat(openDiff)).toFixed(1)} points — consider subject line testing`);

  if (parseFloat(clickDiff) >= 1) insights.push(`Click rate above average — good content-to-CTA alignment`);
  else if (parseFloat(clickDiff) <= -1) insights.push(`Click rate below average — CTA placement or content relevance may need review`);

  if (c.campaignType === 'appeal' && c.conversionRate !== null && c.conversionRate > 0.12) {
    insights.push(`High conversion rate (${(c.conversionRate * 100).toFixed(1)}%) — this copy/segment combination is a strong performer`);
  }

  if (c.isTueThu && parseFloat(openDiff) >= 3) {
    insights.push(`Tuesday/Thursday + ${c.sendTime} is the strongest send-time combination for ${c.clientName}`);
  }

  if (insights.length > 0) {
    lines.push(`Insights:`);
    for (const insight of insights) lines.push(`- ${insight}`);
    lines.push(``);
  }

  // Recommendation
  const recs: string[] = [];
  if (c.campaignType === 'appeal' && c.revenue !== null && c.revenue > avgs.avgRevenue * 1.2) {
    recs.push(`Replicate this appeal structure for next ${c.isQ4 ? 'Q4' : 'season'} — above-average revenue performance`);
  }
  if (c.campaignType === 'newsletter' && c.clickRate > avgs.avgClickRate * 1.3) {
    recs.push(`This content format drove higher-than-average clicks — use as template for future newsletters`);
  }
  if (c.campaignType === 're-engage' && c.conversionRate && c.conversionRate > avgs.avgConvRate * 1.2) {
    recs.push(`Re-engagement subject "${c.subjectLine}" had above-average conversion — A/B test similar framing`);
  }

  if (recs.length > 0) {
    lines.push(`Recommendation: ${recs.join(' | ')}`);
  }

  return lines.join('\n');
}

// --- Store to Engram ---
async function storeMemory(content: string, _campaign: Campaign, _format: 'A' | 'B'): Promise<string | null> {
  // Note: Engram API accepts tags/metadata fields but silently ignores them (not stored in DB).
  // Content is stored in `raw` field. Source must be a valid enum value.
  // We track format A/B via IDs stored in benchmark-data.json.
  try {
    const res = await axios.post(
      `${ENGRAM_BASE}/v1/memories`,
      {
        content,
        layer: 'TASK',
        source: 'AGENT_OBSERVATION',
        importance: 0.7,
      },
      { headers }
    );
    return res.data?.id || res.data?.memory?.id || null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ Failed to store memory: ${msg}`);
    return null;
  }
}

// --- Main ---
async function main() {
  console.log('🚀 Engram Campaign Benchmark - Data Generator');
  console.log('=============================================');

  // Check Engram health
  try {
    const health = await axios.get(`${ENGRAM_BASE}/v1/health`, { headers });
    console.log(`✅ Engram healthy — ${health.data.dependencies?.database?.memoryCount} memories in DB`);
  } catch {
    console.error('❌ Engram not reachable at', ENGRAM_BASE);
    process.exit(1);
  }

  // Generate campaigns
  console.log('\n📊 Generating 100 synthetic campaigns...');
  const campaigns = generateCampaigns();
  console.log(`  Generated ${campaigns.length} campaigns across ${CLIENTS.length} clients`);

  // Compute client averages
  const clientAvgs = computeClientAverages(campaigns);
  console.log('  Computed client performance averages');

  // Build format A and B content
  const stored: StoredCampaign[] = campaigns.map(c => ({
    ...c,
    formatAId: null,
    formatBId: null,
    formatAContent: formatA(c),
    formatBContent: formatB(c, clientAvgs),
  }));

  // Store Format A
  console.log('\n📝 Storing Format A (raw prose) — 100 memories...');
  let aCount = 0;
  for (const c of stored) {
    process.stdout.write(`  [A] ${++aCount}/100 ${c.clientName} — ${c.campaignName}...`);
    c.formatAId = await storeMemory(c.formatAContent, c, 'A');
    console.log(c.formatAId ? ` ✓ ${c.formatAId.slice(0, 8)}` : ' ✗');
    await sleep(DELAY_MS);
  }

  // Store Format B
  console.log('\n📝 Storing Format B (pre-computed insights) — 100 memories...');
  let bCount = 0;
  for (const c of stored) {
    process.stdout.write(`  [B] ${++bCount}/100 ${c.clientName} — ${c.campaignName}...`);
    c.formatBId = await storeMemory(c.formatBContent, c, 'B');
    console.log(c.formatBId ? ` ✓ ${c.formatBId.slice(0, 8)}` : ' ✗');
    await sleep(DELAY_MS);
  }

  // Save output
  const output = {
    generatedAt: new Date().toISOString(),
    clientAverages: clientAvgs,
    campaigns: stored,
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));

  const aSuccess = stored.filter(c => c.formatAId !== null).length;
  const bSuccess = stored.filter(c => c.formatBId !== null).length;

  console.log('\n✅ Done!');
  console.log(`  Format A stored: ${aSuccess}/100`);
  console.log(`  Format B stored: ${bSuccess}/100`);
  console.log(`  Output saved to: ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
