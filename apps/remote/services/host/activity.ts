export function hasBusyMarker(pane: string): boolean {
  // Like Workbench's session rail, use a full status row, not a quoted word in
  // ordinary prose. Codex keeps this marker during quiet tool/model waits.
  return /^[ \t]*(?:[•·][ \t]*)?working[ \t]*\([^\r\n)]*\b(?:esc|ctrl\+c|ctrl-c)[ \t]+to[ \t]+(?:interrupt|cancel)\b[^\r\n)]*\)[ \t]*\r?$/im.test(pane)
    || /^[ \t]*⏵⏵[^\r\n]*\b(?:esc|ctrl\+c|ctrl-c)[ \t]+to[ \t]+(?:interrupt|cancel)\b[^\r\n]*\r?$/im.test(pane);
}
export function agentActivity(harnessId: string | undefined, pane: string, recent: boolean): 'working' | 'recent' | 'idle' {
  if (hasBusyMarker(pane)) return 'working';
  return harnessId !== 'codex' && recent ? 'recent' : 'idle';
}
export function recentActivity(output: string, now = Date.now()): Set<string> {
  const cutoff = Math.floor((now - 2000) / 1000);
  const latest = Math.ceil(now / 1000);
  return new Set(output.split('\n').flatMap(line => {
    const [name, timestamp, dead, extra] = line.split('|');
    const seconds = Number(timestamp);
    return name && dead === '0' && extra === undefined && /^\d+$/.test(timestamp || '') && Number.isSafeInteger(seconds) &&
      seconds >= cutoff && seconds <= latest ? [name] : [];
  }));
}
