/**
 * Pure digest rendering. Email HTML uses inline styles and tables only (no
 * remote images, no CSS classes) so it renders the same in Gmail, Outlook
 * and Apple Mail. Plain text and a ≤5-line WhatsApp-style summary come from
 * the same data.
 */

export type DigestTile = { label: string; value: string; change: string | null; direction: 'up' | 'down' | 'flat' | null; good: boolean | null };
export type DigestRow = { cells: string[] };

export type DigestData = {
  title: string;
  workspaceName: string;
  periodLabel: string;
  tiles: DigestTile[];
  tables: Array<{ title: string; headers: string[]; rows: DigestRow[] }>;
  actions: string[];
  link: string;
  unsubscribeLink: string;
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const INK = '#1a1110';
const MUTED = '#645853';
const LINE = '#f0e2d8';

function changeText(t: DigestTile): string {
  if (!t.change) return '';
  const arrow = t.direction === 'up' ? '▲' : t.direction === 'down' ? '▼' : '■';
  // Direction is carried by the arrow AND the word, never by colour alone.
  const word = t.good === null ? '' : t.good ? ' (better)' : ' (worse)';
  return `${arrow} ${t.change}${word}`;
}

export function renderDigestHtml(d: DigestData): string {
  const e = escapeHtml;
  const tiles = d.tiles
    .map(
      (t) => `<td style="padding:10px 12px;border:1px solid ${LINE};vertical-align:top;width:${Math.floor(100 / Math.max(1, d.tiles.length))}%">
  <div style="font-size:11px;color:${MUTED};text-transform:uppercase;letter-spacing:.04em">${e(t.label)}</div>
  <div style="font-size:20px;font-weight:600;color:${INK};margin-top:2px">${e(t.value)}</div>
  <div style="font-size:11px;color:${MUTED};margin-top:2px">${e(changeText(t))}</div>
</td>`,
    )
    .join('');
  const tables = d.tables
    .map(
      (tb) => `<h3 style="font-size:13px;color:${INK};margin:20px 0 6px">${e(tb.title)}</h3>
<table role="table" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:12px">
<tr>${tb.headers.map((h) => `<th align="left" style="padding:6px 8px;border-bottom:1px solid ${LINE};color:${MUTED};font-weight:500">${e(h)}</th>`).join('')}</tr>
${tb.rows.map((r) => `<tr>${r.cells.map((c) => `<td style="padding:6px 8px;border-bottom:1px solid ${LINE};color:${INK}">${e(c)}</td>`).join('')}</tr>`).join('\n')}
</table>`,
    )
    .join('\n');
  const actions = d.actions.length
    ? `<h3 style="font-size:13px;color:${INK};margin:20px 0 6px">Suggested actions</h3><ol style="margin:0;padding-left:18px;font-size:12px;color:${INK}">${d.actions.map((a) => `<li style="margin:3px 0">${e(a)}</li>`).join('')}</ol>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:640px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<tr><td style="padding:20px 16px">
<div style="font-size:12px;color:${MUTED}">${e(d.workspaceName)} · ${e(d.periodLabel)}</div>
<h2 style="font-size:18px;color:${INK};margin:4px 0 14px">${e(d.title)}</h2>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;width:100%"><tr>${tiles}</tr></table>
${tables}
${actions}
<p style="margin:22px 0 0;font-size:12px"><a href="${e(d.link)}" style="color:#2a78d6">Open the full report</a></p>
<p style="margin:14px 0 0;font-size:11px;color:${MUTED}">You get this because you manage a team in ${e(d.workspaceName)}. <a href="${e(d.unsubscribeLink)}" style="color:${MUTED}">Mute this digest</a></p>
</td></tr></table></body></html>`;
}

export function renderDigestText(d: DigestData): string {
  const lines = [`${d.title} — ${d.workspaceName} — ${d.periodLabel}`, ''];
  for (const t of d.tiles) lines.push(`${t.label}: ${t.value}${t.change ? `  (${changeText(t)})` : ''}`);
  for (const tb of d.tables) {
    lines.push('', tb.title);
    for (const r of tb.rows) lines.push(`  ${r.cells.join(' | ')}`);
  }
  if (d.actions.length) {
    lines.push('', 'Suggested actions');
    d.actions.forEach((a, i) => lines.push(`  ${i + 1}. ${a}`));
  }
  lines.push('', `Full report: ${d.link}`, `Mute: ${d.unsubscribeLink}`);
  return lines.join('\n');
}

/** ≤5 lines for WhatsApp (hook only — no WhatsApp provider exists yet). */
export function renderDigestShort(d: DigestData): string {
  const head = `${d.title} (${d.periodLabel})`;
  const tiles = d.tiles.slice(0, 3).map((t) => `${t.label}: ${t.value}${t.change ? ` ${changeText(t)}` : ''}`);
  return [head, ...tiles, d.link].slice(0, 5).join('\n');
}
