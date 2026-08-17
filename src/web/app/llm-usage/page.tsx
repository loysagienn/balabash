'use client';

// The LLM usage chart: token consumption of the main model, one row per
// request from /api/llm-requests. Hand-rolled SVG chart ported from the
// previous Balabash: two panels over a shared index-based X axis (one slot
// per request, equal spacing — createdAt is shown, not used as a scale).
// Token families live on incompatible scales, hence the two panels instead
// of a dual axis.

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import React, { useState } from 'react';
import { apiFetch } from '../../lib/api';
import { useAuthRedirect } from '../../lib/auth-gate';
import { formatDateTime } from '../../lib/format';
import type { LlmRequestItem, LlmRequestsResponse } from '../../../api/contract.ts';
import styles from './page.module.css';

// Chart chrome, tuned for the dark palette of globals.css.
const INK_SECONDARY = '#c7d0dc';
const INK_MUTED = '#8b98a9';
const GRIDLINE = '#242d3a';
const BASELINE = '#3a4759';
const POINT_RING = '#10141a';

type TokenKey = 'inputTokens' | 'cachedTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens';

type SeriesDef = { key: TokenKey; label: string; color: string };

// Categorical palette slots in fixed entity order, brightened for the dark
// surface (CVD-safe adjacency; low-contrast slots are relieved by
// end-of-line labels and the tooltip).
const TOP_SERIES: SeriesDef[] = [
  { key: 'inputTokens', label: 'input', color: '#5aa2f0' },
  { key: 'cachedTokens', label: 'cached', color: '#f28b54' },
  { key: 'cacheWriteTokens', label: 'cache write', color: '#34c98f' },
];

const BOTTOM_SERIES: SeriesDef[] = [
  { key: 'outputTokens', label: 'output', color: '#f0b429' },
  { key: 'reasoningTokens', label: 'reasoning', color: '#ef93b4' },
];

const REQUESTS_LIMIT = 100;

const WIDTH = 960;
const PAD_LEFT = 56;
const PAD_RIGHT = 150;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = 190;
const PAD_TOP = 12;
const TIME_AXIS_HEIGHT = 26;
const END_LABEL_GAP = 14;
const TOOLTIP_WIDTH = 320;

function formatTokens(value: number): string {
  if (value >= 1000) {
    const thousands = value / 1000;

    return `${thousands >= 100 ? Math.round(thousands) : Math.round(thousands * 10) / 10}k`;
  }

  return String(value);
}

function formatExact(value: number | null): string {
  return value === null ? '—' : value.toLocaleString('ru-RU');
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(date: Date): string {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** 0..top inclusive with a 1/2/5 step, ~4 gridlines; top >= rawMax. */
function buildTicks(rawMax: number): number[] {
  const step0 = Math.max(rawMax, 1) / 4;
  const magnitude = Math.pow(10, Math.floor(Math.log10(step0)));
  const normalized = step0 / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const top = Math.max(Math.ceil(rawMax / step), 1) * step;
  const ticks: number[] = [];

  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(value);
  }

  return ticks;
}

/** Vertically de-overlap end-of-line labels while keeping them in the plot band. */
function spreadLabels(entries: { y: number }[], minY: number, maxY: number) {
  const sorted = [...entries].sort((a, b) => a.y - b.y);

  for (let i = 0; i < sorted.length; i++) {
    const floor = i === 0 ? minY : sorted[i - 1]!.y + END_LABEL_GAP;

    sorted[i]!.y = Math.max(sorted[i]!.y, floor);
  }

  for (let i = sorted.length - 1; i >= 0; i--) {
    const ceiling = i === sorted.length - 1 ? maxY : sorted[i + 1]!.y - END_LABEL_GAP;

    sorted[i]!.y = Math.min(sorted[i]!.y, ceiling);
  }
}

type PanelProps = {
  title: string;
  series: SeriesDef[];
  requests: LlmRequestItem[];
  xForIndex: (index: number) => number;
  hoverIndex: number | null;
  showTimeAxis: boolean;
};

function Panel({ title, series, requests, xForIndex, hoverIndex, showTimeAxis }: PanelProps) {
  const height = PAD_TOP + PLOT_HEIGHT + (showTimeAxis ? TIME_AXIS_HEIGHT : 14);
  const baselineY = PAD_TOP + PLOT_HEIGHT;

  const rawMax = Math.max(1, ...requests.flatMap(item => series.map(s => item[s.key] ?? 0)));
  const ticks = buildTicks(rawMax);
  const scaleMax = ticks[ticks.length - 1]!;
  const yForValue = (value: number) => baselineY - (value / scaleMax) * PLOT_HEIGHT;

  const paths = series.map(s => {
    let path = '';
    let previousMissing = true;

    requests.forEach((item, index) => {
      const value = item[s.key];

      if (value === null) {
        previousMissing = true;

        return;
      }

      path += `${previousMissing ? 'M' : 'L'}${xForIndex(index).toFixed(1)},${yForValue(value).toFixed(1)}`;
      previousMissing = false;
    });

    return { series: s, path };
  });

  const endLabels = series
    .map(s => {
      const lastIndex = requests.findLastIndex(item => item[s.key] !== null);

      return lastIndex === -1 ? null : { series: s, y: yForValue(requests[lastIndex]![s.key] as number) };
    })
    .filter(entry => entry !== null);

  spreadLabels(endLabels, PAD_TOP + 4, baselineY - 2);

  const timeTickIndexes = showTimeAxis
    ? [...new Set([0, 1, 2, 3, 4].map(i => Math.round((i * (requests.length - 1)) / 4)))]
    : [];

  return (
    <div>
      <div className={styles.panelHeader}>
        <span className={styles.panelTitle}>{title}</span>
        {series.map(s => (
          <span key={s.key} className={styles.legendItem}>
            <span className={styles.legendChip} style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg width={WIDTH} height={height} style={{ display: 'block' }}>
        {ticks.map(tick => (
          <g key={tick}>
            <line
              x1={PAD_LEFT}
              x2={PAD_LEFT + PLOT_WIDTH}
              y1={yForValue(tick)}
              y2={yForValue(tick)}
              stroke={tick === 0 ? BASELINE : GRIDLINE}
              strokeWidth={1}
            />
            <text
              x={PAD_LEFT - 8}
              y={yForValue(tick) + 3.5}
              textAnchor="end"
              style={{ fontSize: 11, fill: INK_MUTED, fontVariantNumeric: 'tabular-nums' }}
            >
              {formatTokens(tick)}
            </text>
          </g>
        ))}

        {requests.map((item, index) =>
          item.status === 'request_failed' ? (
            <text
              key={item.id}
              x={xForIndex(index)}
              y={baselineY - 4}
              textAnchor="middle"
              style={{ fontSize: 10, fill: INK_MUTED }}
            >
              ✕
            </text>
          ) : null,
        )}

        {paths.map(({ series: s, path }) => (
          <path key={s.key} d={path} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
        ))}

        {endLabels.map(({ series: s, y }) => (
          <g key={s.key}>
            <rect x={PAD_LEFT + PLOT_WIDTH + 10} y={y - 5} width={9} height={9} rx={3} fill={s.color} />
            <text x={PAD_LEFT + PLOT_WIDTH + 24} y={y + 3.5} style={{ fontSize: 11, fill: INK_SECONDARY }}>
              {s.label}
            </text>
          </g>
        ))}

        {hoverIndex !== null && (
          <g>
            <line
              x1={xForIndex(hoverIndex)}
              x2={xForIndex(hoverIndex)}
              y1={PAD_TOP}
              y2={baselineY}
              stroke={INK_MUTED}
              strokeWidth={1}
            />
            {series.map(s => {
              const value = requests[hoverIndex]![s.key];

              return value === null ? null : (
                <circle
                  key={s.key}
                  cx={xForIndex(hoverIndex)}
                  cy={yForValue(value)}
                  r={4}
                  fill={s.color}
                  stroke={POINT_RING}
                  strokeWidth={2}
                />
              );
            })}
          </g>
        )}

        {timeTickIndexes.map(index => (
          <text
            key={index}
            x={xForIndex(index)}
            y={baselineY + 18}
            textAnchor="middle"
            style={{ fontSize: 11, fill: INK_MUTED, fontVariantNumeric: 'tabular-nums' }}
          >
            {formatTime(requests[index]!.createdAt)}
          </text>
        ))}
      </svg>
    </div>
  );
}

function TooltipRow({ label, value, chip }: { label: string; value: React.ReactNode; chip?: string }) {
  return (
    <div className={styles.tooltipRow}>
      <span className={styles.tooltipLabel}>
        {chip && <span className={styles.tooltipChip} style={{ background: chip }} />}
        {label}
      </span>
      <span className={styles.tooltipValue}>{value}</span>
    </div>
  );
}

function Tooltip({ item, x }: { item: LlmRequestItem; x: number }) {
  const left = x + 14 + TOOLTIP_WIDTH > WIDTH ? x - TOOLTIP_WIDTH - 14 : x + 14;
  const allSeries = [...TOP_SERIES, ...BOTTOM_SERIES];

  return (
    <div className={styles.tooltip} style={{ left, width: TOOLTIP_WIDTH }}>
      <TooltipRow label="время" value={formatDateTime(item.createdAt)} />
      <TooltipRow label="model" value={`${item.provider} / ${item.model}`} />
      <TooltipRow label="status" value={item.status} />
      {item.error !== null && <TooltipRow label="error" value={<span className={styles.tooltipError}>{item.error}</span>} />}
      {item.serviceTier !== null && <TooltipRow label="service tier" value={item.serviceTier} />}
      {item.durationMs !== null && <TooltipRow label="duration" value={`${item.durationMs.toLocaleString('ru-RU')} ms`} />}
      {item.iteration !== null && <TooltipRow label="iteration" value={item.iteration} />}
      {item.lastSeq !== null && <TooltipRow label="last seq" value={String(item.lastSeq)} />}
      <div className={styles.tooltipDivider} />
      {allSeries.map(s => (
        <TooltipRow key={s.key} label={s.label} chip={s.color} value={formatExact(item[s.key])} />
      ))}
      <TooltipRow label="total" value={formatExact(item.totalTokens)} />
      <div className={styles.tooltipDivider} />
      {item.responseId !== null && <TooltipRow label="response id" value={item.responseId} />}
      {item.previousResponseId !== null && <TooltipRow label="prev response id" value={item.previousResponseId} />}
    </div>
  );
}

export default function LlmUsagePage() {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const requestsQuery = useQuery({
    queryKey: ['llm-requests'],
    queryFn: () => apiFetch<LlmRequestsResponse>(`/api/llm-requests?limit=${REQUESTS_LIMIT}`),
  });

  const unauthorized = useAuthRedirect(requestsQuery.error);

  const requests = requestsQuery.data?.requests;

  const body = () => {
    if (unauthorized || requestsQuery.isPending) {
      return <p className={styles.dim}>Загрузка…</p>;
    }

    if (requestsQuery.error) {
      return <p className={styles.error}>Не удалось загрузить данные: {requestsQuery.error.message}</p>;
    }

    if (!requests || requests.length === 0) {
      return <p className={styles.dim}>Запросов пока нет.</p>;
    }

    const count = requests.length;
    const step = count > 1 ? PLOT_WIDTH / (count - 1) : 0;
    const xForIndex = (index: number) => (count > 1 ? PAD_LEFT + index * step : PAD_LEFT + PLOT_WIDTH / 2);

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const index = count > 1 ? Math.round((x - PAD_LEFT) / step) : 0;

      setHoverIndex(Math.max(0, Math.min(count - 1, index)));
    };

    return (
      <>
        <p className={styles.hint}>
          Последние {count} запросов, по порядку без временной шкалы. ✕ — упавший запрос.
        </p>
        <div className={styles.chartScroll}>
          <div className={styles.chart} onMouseMove={handleMouseMove} onMouseLeave={() => setHoverIndex(null)}>
            <Panel
              title="Input tokens"
              series={TOP_SERIES}
              requests={requests}
              xForIndex={xForIndex}
              hoverIndex={hoverIndex}
              showTimeAxis={false}
            />
            <Panel
              title="Output tokens"
              series={BOTTOM_SERIES}
              requests={requests}
              xForIndex={xForIndex}
              hoverIndex={hoverIndex}
              showTimeAxis={true}
            />
            {hoverIndex !== null && <Tooltip item={requests[hoverIndex]!} x={xForIndex(hoverIndex)} />}
          </div>
        </div>
      </>
    );
  };

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>LLM запросы</h1>
        <Link className={styles.back} href="/">
          ← Треды
        </Link>
      </header>
      {body()}
    </main>
  );
}
