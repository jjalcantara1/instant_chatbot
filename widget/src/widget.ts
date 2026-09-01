/**
 * Instant Site Chat embeddable widget.
 *
 * Everything lives inside a shadow root: this gets pasted into pages with
 * hostile global CSS (`* { box-sizing: content-box }`, body font-size
 * overrides, z-index wars), and none of that may reach in, nor may these
 * styles leak out.
 */

interface Source { n: number; url: string; title: string; headingPath: string }

(function bootstrap(): void {
  const script = (document.currentScript as HTMLScriptElement | null)
    ?? document.querySelector<HTMLScriptElement>('script[data-session]');

  const sessionId = script?.dataset['session'] ?? '';
  if (!sessionId) {
    console.error('[kleio] widget needs a data-session attribute');
    return;
  }

  // The API is wherever this script came from.
  const apiOrigin = (() => {
    try { return new URL(script?.src ?? '').origin; }
    catch { return window.location.origin; }
  })();

  const CONTACT = 'https://kleiosoftware.com/book-a-call';

  const host = document.createElement('div');
  host.setAttribute('data-kleio-sitechat', '');
  // The host element itself is positioned; everything else is inside the shadow root.
  host.style.cssText = 'position:fixed;bottom:0;right:0;z-index:2147483000;';
  document.body.appendChild(host);

  const root = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    :host {
      all: initial;
      font-family: Archivo, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.5;
      /* It sits on someone else's page, so the panel is white, not warm paper. */
      --bg: #ffffff;
      --paper: #F7F5F1;
      --fg: #17150F;
      --muted: #6B665C;
      --rule: #DCD7CD;
      --accent: #5B2A86;
      --card: #FDFCFA;
    }
    @media (prefers-color-scheme: dark) {
      :host {
        --bg: #161c24; --paper: #161c24; --fg: #e6ecf2; --muted: #9aa7b3;
        --rule: #2c3742; --accent: #b79ce0; --card: #1e262f;
      }
    }
    .wrap { position: fixed; bottom: 24px; right: 24px; display: flex; flex-direction: column;
            align-items: flex-end; gap: 12px; }
    button { font: inherit; cursor: pointer; }

    /* The launcher circle is the only radius anywhere in the design. */
    .launcher {
      width: 52px; height: 52px; border-radius: 50%; border: 1px solid var(--fg);
      background: var(--paper); color: var(--accent); display: grid; place-items: center;
    }
    .launcher:hover { border-color: var(--accent); color: var(--accent); }

    .panel {
      width: min(370px, calc(100vw - 32px));
      height: min(480px, calc(100vh - 110px));
      background: var(--bg); color: var(--fg);
      border: 1px solid var(--fg); border-radius: 0;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .panel[hidden] { display: none; }

    header { padding: 13px 15px; border-bottom: 1px solid var(--rule);
             display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .title { font-size: 13.5px; font-weight: 600; }
    .sub { margin-top: 3px; font-size: 11px; color: var(--muted); }
    .x { background: none; border: 0; color: var(--muted); font-size: 17px; line-height: 1; padding: 2px 6px; }
    .x:hover { color: var(--accent); }

    .log { flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column; gap: 10px; }
    /* The question is plain text, not a reversed-out bubble. */
    .msg-user { font-size: 12.5px; color: var(--muted); margin-top: 6px; }
    .msg-user:first-child { margin-top: 0; }
    .msg-bot { font-size: 14.5px; line-height: 1.6; white-space: pre-wrap; text-wrap: pretty; }
    .err { color: #9B2C1E; font-size: 13px; }
    .empty { color: var(--muted); font-size: 13px; }

    /* Sources are footnote rows under a hairline, not bordered chips. */
    .notes { margin-top: 16px; border-top: 1px solid var(--rule); padding-top: 10px;
             display: flex; flex-direction: column; gap: 8px; }
    .note { display: flex; gap: 10px; align-items: baseline; }
    .note-n { font-family: ui-monospace, Menlo, monospace; font-size: 10.5px; color: var(--accent); }
    .note-a { font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; color: var(--fg);
              text-decoration: underline; text-decoration-color: var(--accent);
              text-underline-offset: 3px; overflow: hidden; text-overflow: ellipsis;
              white-space: nowrap; min-width: 0; }
    sup { color: var(--accent); font-size: 10px; top: -0.8em; position: relative; }

    form { padding: 0 15px 14px; }
    .field { border-top: 1px solid var(--rule); padding-top: 12px; display: flex;
             align-items: flex-end; justify-content: space-between; gap: 14px; }
    input { flex: 1; font: inherit; font-size: 14.5px; line-height: 1; min-width: 0;
            background: transparent; color: var(--fg);
            border: 0; border-bottom: 2px solid var(--fg); padding: 0 0 8px; }
    input:disabled { opacity: .6; }
    .send { border: 0; border-bottom: 2px solid var(--accent); background: transparent;
            color: var(--accent); font-size: 13.5px; font-weight: 500; padding: 0 0 8px; }
    .send:disabled { opacity: .4; cursor: default; }
    :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

    .notice { padding: 20px 16px; text-align: center; color: var(--muted); font-size: 13px; }
    .notice a { color: var(--accent); }

    @keyframes pop { from { opacity: 0; } }
    .panel:not([hidden]) { animation: pop .14s ease-out; }
    @media (prefers-reduced-motion: reduce) { .panel:not([hidden]) { animation: none; } }
  `;
  root.appendChild(style);

  const wrap = document.createElement('div');
  wrap.className = 'wrap';
  wrap.innerHTML = `
    <div class="panel" hidden role="dialog" aria-modal="false" aria-label="Chat about this site">
      <header>
        <div>
          <div class="title">Ask about this site</div>
          <div class="sub"></div>
        </div>
        <button class="x" aria-label="Close chat">&times;</button>
      </header>
      <div class="log" role="log" aria-live="polite">
        <div class="empty">Ask a question about this site.</div>
      </div>
      <form>
        <div class="field">
          <input type="text" placeholder="Ask something" aria-label="Ask about this site" maxlength="1000" />
          <button class="send" type="submit">ask</button>
        </div>
      </form>
    </div>
    <button class="launcher" aria-label="Open chat" aria-expanded="false">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20.5l1.6-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z"/>
      </svg>
    </button>
  `;
  root.appendChild(wrap);

  const panel = root.querySelector('.panel') as HTMLDivElement;
  const launcher = root.querySelector('.launcher') as HTMLButtonElement;
  const closeBtn = root.querySelector('.x') as HTMLButtonElement;
  const log = root.querySelector('.log') as HTMLDivElement;
  const form = root.querySelector('form') as HTMLFormElement;
  const input = root.querySelector('input') as HTMLInputElement;
  const send = root.querySelector('.send') as HTMLButtonElement;
  const sub = root.querySelector('.sub') as HTMLDivElement;

  let expired = false;
  let busy = false;

  const el = (tag: string, cls?: string, text?: string): HTMLElement => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const scroll = (): void => { log.scrollTop = log.scrollHeight; };

  function showNotice(html: string): void {
    log.innerHTML = '';
    const n = el('div', 'notice');
    n.innerHTML = html;
    log.appendChild(n);
    input.disabled = true;
    send.disabled = true;
  }

  // Session state decides whether this is a working widget or an expiry notice.
  void (async () => {
    try {
      const res = await fetch(`${apiOrigin}/api/sessions/${sessionId}`);
      if (res.status === 410 || res.status === 404) {
        expired = true;
        showNotice(`This demo session has expired.<br><a href="${CONTACT}" target="_blank" rel="noopener">Talk to Kleio</a> about a permanent one.`);
        return;
      }
      const body = await res.json() as { domain?: string; pageCount?: number };
      if (body.domain) sub.textContent = `${body.pageCount ?? 0} pages from ${body.domain}`;
    } catch {
      // Leave the widget usable; a send will surface the real problem.
    }
  })();

  function renderAnswer(container: HTMLElement, text: string): void {
    container.textContent = '';
    for (const part of text.split(/(\[\d{1,2}\])/g)) {
      const m = /^\[(\d{1,2})\]$/.exec(part);
      if (m) container.appendChild(el('sup', undefined, m[1] as string));
      else container.appendChild(document.createTextNode(part));
    }
  }

  async function ask(question: string): Promise<void> {
    if (!question.trim() || busy || expired) return;
    busy = true;
    input.value = '';
    input.disabled = true;
    send.disabled = true;

    const emptyState = log.querySelector('.empty');
    if (emptyState) emptyState.remove();

    log.appendChild(el('div', 'msg-user', question));
    const bot = el('div', 'msg-bot');
    log.appendChild(bot);
    scroll();

    let answer = '';
    try {
      const res = await fetch(`${apiOrigin}/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: question }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { message?: string };
        bot.className = 'err';
        bot.textContent = body.message ?? 'That did not go through. Try again in a moment.';
        return;
      }

      const reader = res.body?.getReader();
      if (!reader) { bot.className = 'err'; bot.textContent = 'No response from the server.'; return; }

      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (frame: string): void => {
        let event = 'message';
        const data: string[] = [];
        for (const line of frame.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length === 0) return;
        let payload: unknown;
        try { payload = JSON.parse(data.join('\n')); } catch { return; }

        if (event === 'token') {
          answer += (payload as { text: string }).text;
          renderAnswer(bot, answer);
          scroll();
        } else if (event === 'sources') {
          const sources = (payload as { sources: Source[] }).sources;
          if (sources.length === 0) return;
          const notes = el('div', 'notes');
          for (const s of sources) {
            const row = el('div', 'note');
            row.appendChild(el('span', 'note-n', String(s.n)));
            const a = el('a', 'note-a') as HTMLAnchorElement;
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.title = s.title;
            let path = s.url;
            try { path = new URL(s.url).pathname || '/'; } catch { /* keep the raw url */ }
            a.textContent = `${path} ↗`;
            row.appendChild(a);
            notes.appendChild(row);
          }
          bot.appendChild(notes);
          scroll();
        } else if (event === 'error') {
          const e = el('div', 'err', (payload as { message: string }).message);
          bot.appendChild(e);
          scroll();
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buffer.indexOf('\n\n')) !== -1) {
          handle(buffer.slice(0, i));
          buffer = buffer.slice(i + 2);
        }
      }
      if (buffer.trim()) handle(buffer);
    } catch {
      bot.className = 'err';
      bot.textContent = 'The connection dropped. Try again.';
    } finally {
      busy = false;
      input.disabled = expired;
      send.disabled = expired;
      input.focus();
    }
  }

  // --- open / close, focus management ---

  function open(): void {
    panel.hidden = false;
    launcher.setAttribute('aria-expanded', 'true');
    input.focus();
    document.addEventListener('keydown', onKeydown, true);
  }

  function close(): void {
    panel.hidden = true;
    launcher.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown, true);
    // Always the launcher. Reading document.activeElement does not work here:
    // while focus is inside the shadow root the document reports the host
    // element, which is not focusable, so restoring it would drop focus to the
    // top of the host page.
    launcher.focus();
  }

  function focusables(): HTMLElement[] {
    return Array.from(
      panel.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]:not([tabindex="-1"])'),
    ).filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (panel.hidden) return;
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;

    // Trap focus inside the open panel.
    const items = focusables();
    if (items.length === 0) return;
    const first = items[0] as HTMLElement;
    const last = items[items.length - 1] as HTMLElement;
    const active = root.activeElement as HTMLElement | null;

    if (e.shiftKey && (active === first || active === null)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  launcher.addEventListener('click', () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener('click', close);
  form.addEventListener('submit', (e) => { e.preventDefault(); void ask(input.value); });
})();
