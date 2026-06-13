/**
 * @fileoverview `faostat_list_domains` — the entry-point tool. Reads the live
 * FAOSTAT bulk manifest for the full domain catalog and annotates each entry
 * with local mirror status (indexed? row count? last sync?). Every other query
 * keys on a domain code discovered here.
 * @module mcp-server/tools/definitions/list-domains
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { getServerConfig } from '@/config/server-config.js';
import { getFaostatMirror } from '@/services/faostat-mirror/index.js';
import {
  fetchManifest,
  parseFileRows,
  parseFileSizeBytes,
} from '@/services/faostat-mirror/manifest.js';

export const listDomainsTool = tool('faostat_list_domains', {
  title: 'faostat-mcp-server: list domains',
  description:
    'Discover FAOSTAT statistical domains (production, trade, food balances, food security, land use, agri-emissions, prices, value) with their codes, descriptions, last-update date, upstream row count, and local index status. Every query keys on a domain code from here. The `indexed` flag tells you which domains are queryable right now; un-indexed domains exist in the catalog but must be added to FAOSTAT_DOMAINS and re-synced before faostat_query_observations can read them.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },

  enrichment: {
    totalCount: z.number().describe('Total domains in the FAOSTAT catalog.'),
    indexedCount: z.number().describe('Domains currently indexed in the local mirror.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when a topic filter matched nothing or no domains are indexed yet.'),
  },

  input: z.object({
    topic: z
      .string()
      .optional()
      .describe(
        'Case-insensitive substring filter over domain code, name, and topic (e.g. "trade", "emissions", "QCL"). Omit to list the full catalog.',
      ),
    indexed_only: z
      .boolean()
      .default(false)
      .describe('When true, return only domains indexed in the local mirror (queryable now).'),
  }),

  output: z.object({
    domains: z
      .array(
        z
          .object({
            code: z.string().describe('Domain code — the key for every query (e.g. "QCL").'),
            name: z.string().describe('Human-readable domain name.'),
            topic: z.string().optional().describe('FAOSTAT topic grouping, when provided.'),
            description: z.string().optional().describe('Domain description, when provided.'),
            last_update: z
              .string()
              .describe('Upstream last-update date (ISO 8601) from the manifest.'),
            upstream_row_count: z
              .number()
              .optional()
              .describe('Row count reported by the manifest for the full domain.'),
            file_size_in_bytes: z
              .number()
              .optional()
              .describe('Compressed ZIP size in bytes, parsed from the manifest size string.'),
            indexed: z
              .boolean()
              .describe(
                'True when this domain is in the local mirror selection (FAOSTAT_DOMAINS).',
              ),
            index_ready: z
              .boolean()
              .describe(
                'True when the local mirror for this domain has completed an initial sync.',
              ),
            indexed_row_count: z
              .number()
              .optional()
              .describe(
                'Rows in the local mirror for this domain (present when indexed and synced).',
              ),
            indexed_last_sync: z
              .string()
              .optional()
              .describe('ISO 8601 timestamp of the last completed local sync (when synced).'),
          })
          .describe('One FAOSTAT domain with catalog metadata and local mirror status.'),
      )
      .describe('Matching domains, sorted by code.'),
  }),

  async handler(input, ctx) {
    const mirror = getFaostatMirror();
    const datasets = await fetchManifest(getServerConfig().bulkBaseUrl, ctx.signal);
    ctx.log.info('Fetched FAOSTAT manifest', { datasetCount: datasets.length });

    const topic = input.topic?.trim().toLowerCase();
    const selected = new Set(mirror.selectedDomains());

    const matched = datasets.filter((d) => {
      if (topic) {
        const hay = `${d.DatasetCode} ${d.DatasetName} ${d.Topic ?? ''}`.toLowerCase();
        if (!hay.includes(topic)) return false;
      }
      if (input.indexed_only && !selected.has(d.DatasetCode.toUpperCase())) return false;
      return true;
    });

    const domains = await Promise.all(
      matched
        .slice()
        .sort((a, b) => a.DatasetCode.localeCompare(b.DatasetCode))
        .map(async (d) => {
          const code = d.DatasetCode.toUpperCase();
          const indexed = selected.has(code);
          const status = indexed ? await mirror.status(code) : undefined;
          const upstreamRows = parseFileRows(d.FileRows);
          const sizeBytes = parseFileSizeBytes(d.FileSize);
          return {
            code,
            name: d.DatasetName,
            ...(d.Topic ? { topic: d.Topic } : {}),
            ...(d.DatasetDescription ? { description: d.DatasetDescription } : {}),
            last_update: d.DateUpdate,
            ...(upstreamRows !== null ? { upstream_row_count: upstreamRows } : {}),
            ...(sizeBytes !== null ? { file_size_in_bytes: sizeBytes } : {}),
            indexed,
            index_ready: status?.ready ?? false,
            ...(status?.total !== undefined ? { indexed_row_count: status.total } : {}),
            ...(status?.completedAt ? { indexed_last_sync: status.completedAt } : {}),
          };
        }),
    );

    ctx.enrich.total(datasets.length);
    ctx.enrich({ indexedCount: selected.size });
    if (domains.length === 0) {
      ctx.enrich.notice(
        topic
          ? `No domains matched topic "${input.topic}". Omit the topic filter to see the full catalog.`
          : 'No domains matched. Omit indexed_only to see the full catalog.',
      );
    } else if (selected.size === 0) {
      ctx.enrich.notice(
        'No domains are indexed yet. Set FAOSTAT_DOMAINS and run the mirror init script before querying observations.',
      );
    }

    return { domains };
  },

  format: (result) => {
    if (result.domains.length === 0) {
      return [{ type: 'text', text: '_No matching domains._' }];
    }
    const lines: string[] = [`**${result.domains.length} domain(s):**\n`];
    for (const d of result.domains) {
      lines.push(`### ${d.code} — ${d.name}`);
      if (d.topic) lines.push(`- Topic: ${d.topic}`);
      if (d.description) lines.push(`- ${d.description}`);
      lines.push(`- Last update: ${d.last_update}`);
      if (d.upstream_row_count !== undefined)
        lines.push(`- Upstream rows: ${d.upstream_row_count.toLocaleString()}`);
      lines.push(
        `- ZIP size: ${d.file_size_in_bytes !== undefined ? `${d.file_size_in_bytes} bytes (${(d.file_size_in_bytes / 1e6).toFixed(1)} MB)` : 'unknown'}`,
      );
      lines.push(
        `- Indexed: ${d.indexed ? 'yes' : 'no'} | Index ready: ${d.index_ready ? 'yes' : 'no'}`,
      );
      if (d.indexed && d.index_ready) {
        lines.push(
          `- Local rows: ${d.indexed_row_count?.toLocaleString() ?? '?'} (synced ${d.indexed_last_sync ?? 'unknown'})`,
        );
      } else if (!d.indexed) {
        lines.push('- Add to FAOSTAT_DOMAINS and re-sync to query this domain.');
      }
      lines.push('');
    }
    return [{ type: 'text', text: lines.join('\n').trimEnd() }];
  },
});
