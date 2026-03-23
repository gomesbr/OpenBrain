export function renderAppHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenBrain 360</title>
  <script src="https://cdn.jsdelivr.net/npm/echarts@5.5.0/dist/echarts.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/cytoscape@3.31.0/dist/cytoscape.min.js"></script>
  <style>
    :root {
      --bg: #07111f;
      --panel: #0b1f38;
      --panel-soft: #0d2847;
      --text: #dfe8f4;
      --muted: #8ca3bf;
      --line: #1f3b60;
      --accent: #46c0ff;
      --ok: #39d98a;
      --warn: #f5ad42;
      --danger: #ff6b6b;
      --shadow: 0 8px 24px rgba(0,0,0,0.28);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", sans-serif;
      color: var(--text);
      background:
        radial-gradient(circle at 10% 10%, rgba(70, 192, 255, 0.14), transparent 45%),
        radial-gradient(circle at 90% 90%, rgba(57, 217, 138, 0.10), transparent 45%),
        linear-gradient(180deg, #06101d, #050c16 70%);
      min-height: 100vh;
    }
    #loginPage, #appPage { min-height: 100vh; }
    #loginPage {
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .login-card {
      width: min(420px, 100%);
      background: rgba(8, 24, 43, 0.94);
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 24px;
      box-shadow: var(--shadow);
    }
    .login-card h1 {
      margin: 0 0 8px;
      font-size: 28px;
      letter-spacing: 0.4px;
    }
    .login-card p {
      margin: 0 0 20px;
      color: var(--muted);
      font-size: 14px;
    }
    input, select, button, textarea {
      font: inherit;
      color: var(--text);
      background: #0a1b31;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px 12px;
    }
    button {
      background: linear-gradient(180deg, #12375f, #102f50);
      border-color: #2b537f;
      cursor: pointer;
      font-weight: 600;
    }
    button:hover { filter: brightness(1.08); }
    .error { color: var(--danger); font-size: 13px; min-height: 18px; }

    #appPage { display: none; }
    .layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      min-height: 100vh;
    }
    .rail {
      border-right: 1px solid var(--line);
      padding: 16px 12px;
      background: linear-gradient(180deg, rgba(9, 28, 49, 0.92), rgba(7, 20, 36, 0.98));
    }
    .brand {
      font-size: 18px;
      font-weight: 800;
      margin: 6px 8px 16px;
    }
    .nav-btn {
      width: 100%;
      text-align: left;
      margin: 0 0 8px;
      background: #0b213b;
      border: 1px solid var(--line);
      color: var(--text);
      border-radius: 10px;
    }
    .nav-btn.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(70,192,255,0.5);
      background: #0f2e4f;
    }
    .content {
      display: grid;
      grid-template-rows: auto 1fr;
      min-width: 0;
    }
    .topbar {
      border-bottom: 1px solid var(--line);
      padding: 12px 16px;
      display: grid;
      grid-template-columns: 1fr auto auto auto auto auto;
      gap: 8px;
      align-items: center;
      position: sticky;
      top: 0;
      z-index: 10;
      backdrop-filter: blur(10px);
      background: rgba(7, 20, 36, 0.86);
    }
    .panel-wrap {
      padding: 14px;
      display: grid;
      gap: 12px;
      align-content: start;
      overflow: auto;
    }
    .panel {
      background: rgba(12, 35, 60, 0.78);
      border: 1px solid var(--line);
      border-radius: 12px;
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .panel h3, .panel h4 { margin: 0 0 8px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 12px;
    }
    .metric {
      background: #0b2440;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 10px;
    }
    .metric b { font-size: 24px; display: block; margin-top: 4px; }
    .chart {
      min-height: 320px;
      width: 100%;
    }
    .graph {
      min-height: 580px;
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
    }
    .people-panel {
      min-height: calc(100vh - 220px);
      display: grid;
      grid-template-rows: auto 1fr;
    }
    .network-shell {
      display: grid;
      grid-template-columns: minmax(300px, 360px) minmax(0, 1fr) minmax(280px, 340px);
      gap: 16px;
      min-height: calc(100vh - 220px);
      align-items: start;
    }
    .network-rail,
    .network-canvas,
    .network-detail {
      border: 1px solid #d5e3ee;
      border-radius: 22px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(245,250,255,0.94));
      box-shadow: 0 18px 48px rgba(16, 39, 66, 0.12);
      min-width: 0;
    }
    .network-rail,
    .network-detail {
      padding: 16px;
      display: grid;
      gap: 12px;
      align-content: start;
    }
    .network-canvas {
      position: relative;
      overflow: hidden;
      padding: 16px;
      display: grid;
      grid-template-rows: auto auto minmax(520px, 1fr) auto;
      gap: 12px;
    }
    .network-canvas::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        radial-gradient(circle at 18% 16%, rgba(152, 205, 255, 0.18), transparent 20%),
        radial-gradient(circle at 82% 14%, rgba(116, 214, 190, 0.12), transparent 18%),
        radial-gradient(circle at 52% 82%, rgba(255, 199, 122, 0.12), transparent 22%),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240' viewBox='0 0 240 240'%3E%3Cg fill='none' stroke='%2396aec8' stroke-opacity='0.14' stroke-width='1'%3E%3Cpath d='M24 40h36v36H24z'/%3E%3Cpath d='M160 36h52v52h-52z'/%3E%3Ccircle cx='72' cy='152' r='18'/%3E%3Ccircle cx='186' cy='168' r='12'/%3E%3Cpath d='M60 58l30 34M90 92l44-18M72 170l32-24M176 120l24 28'/%3E%3C/g%3E%3C/svg%3E");
      opacity: 0.26;
      z-index: 0;
    }
    .network-shell h3,
    .network-shell h4 { color: #15324a; }
    .network-control-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .network-control-grid input,
    .network-control-grid select,
    .network-control-grid button {
      width: 100%;
    }
    .network-rail input,
    .network-rail select,
    .network-rail button,
    .network-detail button {
      border-radius: 14px;
      border: 1px solid #d6e4ef;
      background: linear-gradient(180deg, #ffffff, #f4f9fd);
      color: #1b3852;
      box-shadow: 0 10px 22px rgba(27, 57, 89, 0.08);
    }
    .network-rail button,
    .network-detail button {
      font-weight: 600;
    }
    .network-rail input::placeholder {
      color: #86a1bb;
    }
    .network-chat-thread {
      border: 1px solid #d9e7f2;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.98), rgba(247,251,255,0.95));
      padding: 12px;
      min-height: 240px;
      max-height: 340px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .network-chat-bubble {
      border: 1px solid #d9e6f2;
      border-radius: 18px;
      padding: 10px 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      color: #1d3953;
      box-shadow: 0 10px 22px rgba(26, 55, 88, 0.08);
    }
    .network-chat-bubble.user {
      align-self: flex-end;
      background: linear-gradient(180deg, #eef7ff, #e7f4ff);
      border-color: #c2dbf0;
    }
    .network-chat-bubble.agent {
      align-self: flex-start;
      background: linear-gradient(180deg, #ffffff, #f6fbff);
      border-color: #d8e7f5;
    }
    .network-suggestion-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .network-suggestion {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid #d1e3f3;
      background: rgba(255,255,255,0.92);
      color: #214261;
      font-size: 12px;
      cursor: pointer;
      box-shadow: 0 8px 16px rgba(34, 74, 112, 0.08);
    }
    .network-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
    }
    .network-summary {
      position: relative;
      z-index: 1;
      border: 1px solid #d9e6f2;
      border-radius: 16px;
      background: rgba(255,255,255,0.9);
      padding: 12px 14px;
      color: #3f6487;
      font-size: 13px;
      line-height: 1.45;
    }
    .network-graph {
      position: relative;
      z-index: 1;
      min-height: 760px;
      border: 1px solid #d9e8f2;
      border-radius: 24px;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.86), rgba(245,250,255,0.92) 48%, rgba(238,246,252,0.96)),
        linear-gradient(180deg, rgba(255,255,255,0.92), rgba(243,248,252,0.96));
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.9);
    }
    .network-hover-card {
      position: absolute;
      z-index: 3;
      max-width: 260px;
      pointer-events: none;
      border-radius: 18px;
      border: 1px solid rgba(214, 227, 240, 0.95);
      background: rgba(255,255,255,0.96);
      box-shadow: 0 18px 36px rgba(30, 61, 95, 0.14);
      padding: 12px 14px;
      color: #1f3b56;
      display: grid;
      gap: 6px;
      backdrop-filter: blur(12px);
    }
    .network-hover-title {
      font-size: 13px;
      font-weight: 700;
      color: #1a3550;
    }
    .network-hover-body {
      color: #5f7c99;
      font-size: 12px;
      line-height: 1.45;
    }
    .network-mini {
      min-height: 180px;
      border: 1px solid #d9e8f2;
      border-radius: 18px;
      background: linear-gradient(180deg, rgba(255,255,255,0.9), rgba(246,250,255,0.96));
    }
    .network-detail-section {
      border: 1px solid #dce8f2;
      border-radius: 18px;
      background: rgba(255,255,255,0.92);
      padding: 14px;
      display: grid;
      gap: 10px;
      box-shadow: 0 10px 26px rgba(27, 55, 88, 0.08);
    }
    .network-evidence-panel {
      position: relative;
      z-index: 1;
      border: 1px solid #dce8f2;
      border-radius: 20px;
      background: rgba(255,255,255,0.94);
      padding: 14px;
      display: grid;
      gap: 10px;
      box-shadow: 0 10px 26px rgba(27, 55, 88, 0.08);
    }
    .network-evidence-list {
      display: grid;
      gap: 10px;
      max-height: 220px;
      overflow: auto;
    }
    .network-evidence-item {
      border: 1px solid #dce8f2;
      border-radius: 14px;
      background: linear-gradient(180deg, #ffffff, #f8fbfe);
      padding: 12px;
      display: grid;
      gap: 6px;
      color: #183552;
      box-shadow: 0 8px 18px rgba(27, 55, 88, 0.06);
    }
    .network-evidence-meta {
      color: #5f7c99;
      font-size: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .network-evidence-context {
      color: #61788d;
      font-size: 12px;
      line-height: 1.45;
      display: grid;
      gap: 4px;
    }
    .network-detail-section:first-of-type {
      margin-top: 4px;
    }
    .network-detail-list {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: #5c7997;
      line-height: 1.45;
    }
    .network-save-list {
      display: grid;
      gap: 6px;
      max-height: 220px;
      overflow: auto;
    }
    .network-save-item {
      border: 1px solid #d8e5ef;
      border-radius: 14px;
      background: #fdfefe;
      padding: 10px;
      display: grid;
      gap: 6px;
      font-size: 12px;
    }
    .network-chip-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
    }
    .network-chip {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 6px 12px;
      border: 1px solid #d7e5ef;
      font-size: 12px;
      background: rgba(255,255,255,0.86);
      color: #31506f;
      box-shadow: 0 8px 18px rgba(31, 63, 98, 0.08);
    }
    .network-detail-title {
      font-size: 20px;
      font-weight: 700;
      color: #17324a;
    }
    .network-muted {
      color: #4f6f8d;
      font-size: 12px;
      line-height: 1.45;
    }
    .timeline-item {
      padding: 10px 0;
      border-bottom: 1px solid #1f3b60;
    }
    .timeline-domain {
      font-weight: 700;
      text-transform: capitalize;
      margin-right: 6px;
    }
    .timeline-chip {
      display: inline-block;
      margin-right: 6px;
      padding: 2px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 12px;
      color: #9fc3e8;
      text-transform: capitalize;
      background: rgba(15, 46, 79, 0.55);
    }
    .hidden { display: none !important; }
    .badge {
      display: inline-flex;
      border-radius: 999px;
      padding: 3px 10px;
      border: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
      margin-right: 6px;
    }
    .badge.mode-private { border-color: var(--ok); color: var(--ok); }
    .badge.mode-share_safe { border-color: var(--warn); color: var(--warn); }
    .badge.mode-demo { border-color: var(--danger); color: var(--danger); }
    .muted { color: var(--muted); }
    .ask-answer { white-space: pre-wrap; line-height: 1.5; color: var(--text); }
    .ask-graph-suggestion {
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(10, 26, 45, 0.55);
    }
    .ask-graph-btn {
      border: 1px solid var(--accent);
      border-radius: 999px;
      padding: 8px 14px;
      background: #0f2e4f;
      color: var(--text);
      cursor: pointer;
      font-weight: 600;
    }
    .ask-graph-btn:hover {
      background: #12365a;
    }
    .ask-tabs {
      display: inline-flex;
      gap: 8px;
      margin: 6px 0 10px;
    }
    .ask-tab-btn {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #0b213b;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
    }
    .ask-tab-btn.active {
      border-color: var(--accent);
      color: var(--text);
      background: #0f2e4f;
    }
    .ask-debug-flow {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 10px;
      max-height: 520px;
      overflow: auto;
    }
    .ask-debug-swim {
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-width: max-content;
    }
    .ask-debug-lane-row {
      display: grid;
      gap: 8px;
      position: sticky;
      top: 0;
      z-index: 2;
      background: #081627;
      padding-bottom: 6px;
    }
    .ask-debug-lane {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b2036;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ask-debug-row {
      display: grid;
      gap: 8px;
      align-items: start;
    }
    .ask-debug-cell {
      min-height: 4px;
    }
    .ask-debug-bubble {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b2036;
      padding: 8px;
      line-height: 1.4;
    }
    .ask-debug-bubble.request { border-color: #2a7db7; }
    .ask-debug-bubble.response { border-color: #267a64; }
    .ask-debug-bubble.internal { border-color: #2a3e57; }
    .ask-debug-bubble pre {
      margin: 6px 0 0;
      white-space: pre-wrap;
      max-height: 220px;
      overflow: auto;
      font-size: 12px;
    }
    .ask-debug-connector-cell {
      min-height: 20px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .ask-debug-arrow {
      margin: 0;
      color: var(--muted);
      white-space: pre;
      line-height: 1;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
      user-select: none;
    }
    .ask-debug-meta {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .ask-loading {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      min-height: 20px;
      margin: 8px 0 0;
    }
    .spinner {
      width: 14px;
      height: 14px;
      border: 2px solid #284868;
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .evidence {
      margin-top: 8px;
      border-top: 1px dashed var(--line);
      padding-top: 8px;
    }
    .ask-shell {
      display: grid;
      grid-template-columns: minmax(0, 2.4fr) minmax(320px, 1fr);
      gap: 12px;
      min-height: calc(100vh - 210px);
    }
    .ask-workspace-panel {
      min-height: 100%;
    }
    .ask-chat-panel {
      display: grid;
      grid-template-rows: auto 1fr auto;
      min-height: 100%;
    }
    .ask-chat-thread {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 10px;
      overflow: auto;
      min-height: 520px;
      max-height: calc(100vh - 320px);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .ask-chat-bubble {
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 8px 10px;
      line-height: 1.45;
      white-space: pre-wrap;
      max-width: 100%;
    }
    .ask-chat-bubble.user {
      align-self: flex-end;
      background: #103154;
      border-color: #2d6594;
    }
    .ask-chat-bubble.agent {
      align-self: flex-start;
      background: #0b2036;
      border-color: #2a3e57;
    }
    .ask-chat-input-wrap {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      margin-top: 10px;
    }
    .ask-chat-note {
      font-size: 12px;
      color: var(--muted);
      margin-bottom: 8px;
    }
    .evo-shell {
      display: grid;
      gap: 12px;
    }
    .evo-topbar {
      display: grid;
      grid-template-columns: minmax(320px, 1fr) minmax(220px, auto) auto auto;
      gap: 8px;
      align-items: center;
    }
    .evo-select-wrap {
      display: grid;
      gap: 6px;
    }
    .evo-select-note {
      font-size: 12px;
      color: var(--muted);
    }
    .evo-tabs {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .evo-tab-btn {
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #0b213b;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
    }
    .evo-tab-btn.active {
      border-color: var(--accent);
      color: var(--text);
      background: #0f2e4f;
    }
    .evo-kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }
    .evo-kpi {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b2036;
      padding: 10px;
    }
    .evo-kpi .label {
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .evo-kpi .value {
      margin-top: 4px;
      font-size: 18px;
      font-weight: 700;
    }
    .evo-grid-2 {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      gap: 12px;
    }
    .evo-grid-2-rail {
      display: grid;
      grid-template-columns: minmax(0, 1.6fr) minmax(320px, 1fr);
      gap: 12px;
    }
    .evo-lineage {
      min-height: 360px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
    }
    .evo-runtime-strip {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 10px;
    }
    .preloop-shell {
      display: grid;
      grid-template-columns: minmax(220px, 300px) minmax(0, 1fr) minmax(260px, 320px);
      gap: 12px;
      align-items: start;
    }
    .preloop-queue-list {
      max-height: 460px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 8px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .preloop-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b2036;
      padding: 8px;
      cursor: pointer;
      font-size: 12px;
    }
    .preloop-item.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(70,192,255,0.5);
    }
    .preloop-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 10px;
      min-height: 420px;
      min-width: 0;
    }
    .preloop-actions {
      display: grid;
      gap: 8px;
    }
    .preloop-glossary {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }
    .preloop-glossary-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b2036;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .preloop-filter-grid {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }
    .preloop-count-blocks {
      display: grid;
      gap: 8px;
      margin-bottom: 10px;
    }
    .preloop-count-block {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .preloop-stage-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(240px, 1fr));
      gap: 10px;
      margin-bottom: 10px;
      align-items: start;
    }
    @media (max-width: 1080px) {
      .preloop-stage-grid {
        grid-template-columns: repeat(2, minmax(240px, 1fr));
      }
    }
    @media (max-width: 760px) {
      .preloop-stage-grid {
        grid-template-columns: minmax(0, 1fr);
      }
    }
    .preloop-stage-card {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: linear-gradient(180deg, #0b2036, #09192c);
      padding: 12px;
      box-shadow: var(--shadow);
    }
    .preloop-stage-card.ready {
      border-color: rgba(57, 217, 138, 0.55);
      box-shadow: inset 0 0 0 1px rgba(57, 217, 138, 0.18), var(--shadow);
    }
    .preloop-stage-card.blocked {
      border-color: rgba(245, 173, 66, 0.4);
    }
    .preloop-stage-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 10px;
    }
    .preloop-stage-title {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .preloop-stage-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 72px;
      border-radius: 999px;
      border: 1px solid var(--line);
      padding: 4px 10px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .preloop-stage-badge.ready {
      color: var(--ok);
      border-color: rgba(57, 217, 138, 0.55);
      background: rgba(57, 217, 138, 0.08);
    }
    .preloop-stage-badge.blocked {
      color: var(--warn);
      border-color: rgba(245, 173, 66, 0.45);
      background: rgba(245, 173, 66, 0.08);
    }
    .preloop-stage-group {
      margin-top: 10px;
    }
    .preloop-stage-group:first-of-type {
      margin-top: 0;
    }
    .preloop-stage-group-title {
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .preloop-stage-metric-list {
      display: grid;
      gap: 6px;
    }
    .preloop-stage-metric {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
      font-size: 12px;
      line-height: 1.35;
    }
    .preloop-stage-metric strong {
      font-size: 13px;
      font-weight: 700;
    }
    .preloop-stage-blockers {
      margin-top: 10px;
      border-top: 1px solid rgba(31, 59, 96, 0.8);
      padding-top: 10px;
      display: grid;
      gap: 6px;
      font-size: 12px;
      line-height: 1.35;
      color: var(--muted);
    }
    .preloop-stage-blocker {
      padding-left: 10px;
      position: relative;
    }
    .preloop-stage-blocker::before {
      content: "";
      position: absolute;
      left: 0;
      top: 7px;
      width: 4px;
      height: 4px;
      border-radius: 50%;
      background: var(--warn);
    }
    .preloop-section {
      margin-top: 12px;
    }
    .preloop-section:first-of-type {
      margin-top: 0;
    }
    .preloop-section-title {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .preloop-evidence-list {
      display: grid;
      gap: 8px;
    }
    .preloop-evidence-card {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b2036;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .preloop-decision-group {
      display: grid;
      gap: 6px;
    }
    .preloop-button-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .preloop-choice-btn {
      padding: 8px 12px;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: #0b213b;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
    }
    .preloop-choice-btn.active {
      border-color: var(--accent);
      color: var(--text);
      background: #11385e;
    }
    .preloop-bottom {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
      align-items: center;
      margin-top: 12px;
    }
    .ontology-shell {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    .ontology-column {
      display: grid;
      gap: 12px;
      min-width: 0;
    }
    .ontology-list {
      max-height: 420px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 8px;
      display: grid;
      gap: 8px;
    }
    .ontology-item {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b2036;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .ontology-item.active {
      border-color: var(--accent);
      box-shadow: inset 0 0 0 1px rgba(70,192,255,0.45);
    }
    .ontology-toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 10px;
    }
    .ontology-filters {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .ontology-stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 8px;
    }
    .ontology-stat {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #0b2036;
      padding: 10px;
      font-size: 12px;
      line-height: 1.45;
    }
    .ontology-matrix-list {
      display: grid;
      gap: 8px;
    }
    .ontology-matrix-scroll {
      margin-top: 10px;
      max-height: 520px;
      overflow: auto;
      padding-right: 4px;
    }
    .ontology-pagination {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 10px;
    }
    .ontology-pagination-meta {
      color: var(--muted);
      font-size: 12px;
    }
    .ontology-pagination-actions {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ontology-matrix-group {
      display: grid;
      gap: 8px;
      margin-bottom: 12px;
    }
    .ontology-matrix-group:last-child {
      margin-bottom: 0;
    }
    .ontology-matrix-group-title {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .ontology-matrix-group-grid {
      display: grid;
      gap: 8px;
    }
    .ontology-matrix-item {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: #081627;
      padding: 10px;
      display: grid;
      gap: 8px;
      min-width: 0;
    }
    .ontology-matrix-head {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 8px;
      flex-wrap: wrap;
    }
    .ontology-matrix-title {
      font-weight: 700;
      line-height: 1.35;
    }
    .ontology-status-badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 12px;
      white-space: nowrap;
      background: #0b2036;
    }
    .ontology-status-badge.supported {
      border-color: #2d7f60;
      color: #9fe5c4;
    }
    .ontology-status-badge.unsupported {
      border-color: #7a5c2a;
      color: #f0ce89;
    }
    .ontology-status-badge.mixed {
      border-color: #2d6594;
      color: #9fd1ff;
    }
    .ontology-matrix-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
    .ontology-matrix-stat {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b2036;
      padding: 8px;
      font-size: 12px;
      line-height: 1.35;
    }
    .ontology-matrix-rationale {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .ontology-list-block {
      display: grid;
      gap: 6px;
      margin-top: 8px;
      font-size: 12px;
      line-height: 1.45;
    }
    .ontology-list-item {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #0b2036;
      padding: 8px;
    }
    .ontology-empty {
      color: var(--muted);
      font-size: 12px;
      padding: 8px 0;
    }
    .ontology-pill-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 8px;
    }
    .ontology-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #0b2036;
      padding: 6px 10px;
      font-size: 12px;
    }
    .runctl-actions {
      display: inline-flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .runctl-log {
      margin-top: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #081627;
      padding: 10px;
      min-height: 220px;
      max-height: 360px;
      overflow: auto;
      white-space: pre-wrap;
      font-size: 12px;
      line-height: 1.4;
    }
    details { border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
    summary { cursor: pointer; color: var(--accent); }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      .rail { border-right: 0; border-bottom: 1px solid var(--line); }
      .topbar { grid-template-columns: 1fr 1fr; }
      .ask-shell { grid-template-columns: 1fr; }
      .ask-chat-panel { order: -1; }
      .ask-chat-thread { min-height: 360px; max-height: 50vh; }
      .evo-grid-2,
      .evo-grid-2-rail,
      .network-shell,
      .preloop-shell,
      .ontology-shell {
        grid-template-columns: 1fr;
      }
      .preloop-bottom {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <section id="loginPage">
    <div class="login-card">
      <h1>OpenBrain 360</h1>
      <p>Personal memory cockpit. Login is required on every open/refresh.</p>
      <form id="loginForm">
        <input id="passwordInput" type="password" placeholder="Password" required style="width:100%; margin-bottom:10px;" />
        <button type="submit" style="width:100%;">Login</button>
      </form>
      <div class="error" id="loginError"></div>
    </div>
  </section>

  <section id="appPage">
    <div class="layout">
      <aside class="rail">
        <div class="brand">OpenBrain 360</div>
        <button class="nav-btn active" data-module="brief">Brief</button>
        <button class="nav-btn" data-module="ask">Ask</button>
        <button class="nav-btn" data-module="evolution">Evolution</button>
        <button class="nav-btn" data-module="network">Network</button>
        <button class="nav-btn" data-module="behavior">Behavior</button>
        <button class="nav-btn" data-module="timeline">Timeline</button>
        <button class="nav-btn" data-module="insights">Insights</button>
        <button class="nav-btn" data-module="ops">Ops</button>
        <button class="nav-btn" data-module="settings">Settings</button>
      </aside>
      <main class="content">
        <div class="topbar">
          <input id="globalQuestion" placeholder="Ask anything about your memory..." />
          <select id="timeframeSelect">
            <option value="7d">7d</option>
            <option value="30d" selected>30d</option>
            <option value="90d">90d</option>
            <option value="365d">365d</option>
            <option value="all">all</option>
          </select>
          <select id="privacyModeSelect">
            <option value="private">Private</option>
            <option value="share_safe">Share-Safe</option>
            <option value="demo">Demo</option>
          </select>
          <button id="askButton">Ask</button>
          <div id="askLoading" class="ask-loading hidden"><span class="spinner"></span><span>Processing question...</span></div>
          <button id="lockButton">Lock</button>
        </div>
        <div class="panel-wrap">
          <section id="module-brief">
            <div class="panel">
              <h3>Daily Brief <span id="modeBadge" class="badge mode-private">private</span></h3>
              <div class="grid" id="briefMetrics"></div>
            </div>
            <div class="panel"><div id="briefChart" class="chart"></div></div>
          </section>

          <section id="module-ask" class="hidden">
            <div class="ask-shell">
              <div class="panel ask-workspace-panel">
                <h3>Ask Workspace</h3>
                <div class="ask-tabs">
                  <button id="askTabAnswer" class="ask-tab-btn active" type="button">Answer</button>
                  <button id="askTabDebug" class="ask-tab-btn" type="button">Agent Debug Mode</button>
                </div>
                <div id="askPanelAnswer">
                  <div class="ask-answer" id="askAnswer">Ask a question in the right chat panel.</div>
                  <div id="askGraphSuggestion" class="ask-graph-suggestion hidden">
                    <div id="askGraphSuggestionText" class="muted">See this answer in graph mode.</div>
                    <button id="askShowGraphButton" class="ask-graph-btn" type="button">Show graph</button>
                  </div>
                  <details class="evidence">
                    <summary>Evidence</summary>
                    <div id="askEvidence" class="muted">No evidence yet.</div>
                  </details>
                </div>
                <div id="askPanelDebug" class="hidden">
                  <div id="askDebugSummary" class="muted">Run a question to view agent orchestration flow.</div>
                  <div id="askDebugFlow" class="ask-debug-flow muted">No debug steps yet.</div>
                </div>
              </div>
              <div class="panel ask-chat-panel">
                <h3>Chat</h3>
                <div id="askChatNote" class="ask-chat-note">Ask here. If clarification is needed, answer the follow-up to continue.</div>
                <div id="askChatThread" class="ask-chat-thread">
                  <div class="ask-chat-bubble agent">I am ready. Ask a question.</div>
                </div>
                <div class="ask-chat-input-wrap">
                  <input id="askChatInput" placeholder="Type your question..." />
                  <button id="askChatSend" type="button">Send</button>
                </div>
              </div>
            </div>
          </section>

          <section id="module-evolution" class="hidden">
            <div class="evo-shell">
              <div class="panel">
                <div class="evo-topbar">
                  <div class="evo-select-wrap">
                    <select id="evoExperimentSelect"></select>
                    <div id="evoExperimentMeta" class="evo-select-note">No experiment loaded.</div>
                  </div>
                  <input id="evoExperimentSearch" placeholder="Filter experiments..." />
                  <button id="evoUseLatest" type="button">Use Latest</button>
                  <button id="evoRefreshAll" type="button">Refresh</button>
                </div>
                <div class="evo-tabs" style="margin-top:10px;">
                  <button id="evoTabOverview" class="evo-tab-btn active" type="button">Overview</button>
                  <button id="evoTabOntology" class="evo-tab-btn" type="button">Ontology Review</button>
                  <button id="evoTabPreloop" class="evo-tab-btn" type="button">Pre-Loop Calibration</button>
                  <button id="evoTabRunControl" class="evo-tab-btn" type="button">Run Control</button>
                </div>
              </div>

              <div id="evoPanelOverview" class="panel">
                <h3>Strategy Evolution</h3>
                <div id="evoKpiGrid" class="evo-kpi-grid"></div>
                <div class="evo-grid-2" style="margin-top:12px;">
                  <div class="panel"><h4>Performance Frontier</h4><div id="evoFrontierChart" class="chart"></div></div>
                  <div class="panel"><h4>Learning Velocity</h4><div id="evoVelocityChart" class="chart"></div></div>
                </div>
                <div class="evo-grid-2" style="margin-top:12px;">
                  <div class="panel"><h4>Failure Distribution</h4><div id="evoFailuresChart" class="chart"></div></div>
                  <div class="panel"><h4>Component Heatmap</h4><div id="evoHeatmapChart" class="chart"></div></div>
                </div>
                <div class="evo-grid-2-rail" style="margin-top:12px;">
                  <div class="panel">
                    <h4>Hypothesis + Diversity</h4>
                    <div class="evo-grid-2">
                      <div><div id="evoHypothesisChart" class="chart"></div></div>
                      <div><div id="evoDiversityChart" class="chart"></div></div>
                    </div>
                  </div>
                  <div class="panel">
                    <h4>Lineage + Selected</h4>
                    <div id="evoLineageGraph" class="evo-lineage"></div>
                    <div id="evoStrategyDetail" class="muted" style="margin-top:10px;">Select a frontier point to inspect details.</div>
                  </div>
                </div>
                <div class="panel" style="margin-top:12px;">
                  <h4>Coverage + Runtime Health</h4>
                  <div id="evoCoverageSummary" class="muted" style="margin-bottom:8px;">No coverage data yet.</div>
                  <div id="evoRuntimeStrip" class="evo-runtime-strip"></div>
                </div>
              </div>

              <div id="evoPanelOntology" class="panel hidden">
                <h3>Ontology Review</h3>
                <div class="ontology-toolbar">
                  <select id="ontologyVersionSelect"></select>
                  <button id="ontologyUseExperimentVersion" type="button">Use Experiment Version</button>
                  <button id="ontologyRefreshButton" type="button">Refresh</button>
                </div>
                <div class="ontology-shell">
                  <div class="ontology-column">
                    <div class="panel">
                      <h4>Operations</h4>
                      <div class="runctl-actions">
                        <button id="ontologyScanSupportButton" type="button">Run Support Scan</button>
                        <button id="ontologyGenerateCandidatesButton" type="button">Generate Candidates</button>
                        <button id="ontologyPublishButton" type="button">Publish Version</button>
                        <button id="ontologyReseedBenchmarkButton" type="button">Regenerate Benchmark</button>
                        <button id="ontologyRebuildCalibrationButton" type="button">Rebuild Calibration Queue</button>
                        <button id="ontologyExportButton" type="button">Export Review</button>
                      </div>
                      <div id="ontologyActionMsg" class="muted" style="margin-top:8px;">No ontology action yet.</div>
                    </div>
                    <div class="panel">
                      <h4>Support Summary</h4>
                      <div id="ontologySupportSummary" class="ontology-stat-grid"></div>
                    </div>
                  </div>
                  <div class="ontology-column">
                    <div class="panel">
                      <h4>Candidate Queue</h4>
                      <div class="ontology-filters">
                        <select id="ontologyCandidateTypeFilter">
                          <option value="">all candidate types</option>
                          <option value="new_domain_candidate">new domain</option>
                          <option value="new_lens_candidate">new lens</option>
                          <option value="merge_candidate">merge</option>
                          <option value="split_candidate">split</option>
                          <option value="unmapped_cluster">unmapped cluster</option>
                        </select>
                        <select id="ontologyCandidateStatusFilter">
                          <option value="">all statuses</option>
                          <option value="pending">pending</option>
                          <option value="approved">approved</option>
                          <option value="deferred">deferred</option>
                          <option value="rejected">rejected</option>
                        </select>
                        <input id="ontologyCandidateSearch" placeholder="filter by title/domain/lens..." />
                      </div>
                      <div class="runctl-actions" style="margin-bottom:8px;">
                        <button id="ontologyBatchApproveButton" type="button">Approve Visible</button>
                        <button id="ontologyBatchRejectButton" type="button">Reject Visible</button>
                        <button id="ontologyBatchDeferButton" type="button">Defer Visible</button>
                      </div>
                      <div id="ontologyCandidateList" class="ontology-list"></div>
                    </div>
                    <div class="panel">
                      <h4>Draft Taxonomy</h4>
                      <div id="ontologyDraftSummary"></div>
                    </div>
                    <div class="panel">
                      <h4>Benchmark Freshness</h4>
                      <div id="ontologyFreshness"></div>
                    </div>
                    <div class="panel">
                      <h4>Metadata / Facet Coverage</h4>
                      <div class="ontology-filters">
                        <select id="ontologyFacetTypeFilter">
                          <option value="">all facet types</option>
                          <option value="actor_name">actor names</option>
                          <option value="group_label">group labels</option>
                          <option value="thread_title">thread titles</option>
                          <option value="source_system">source systems</option>
                          <option value="month_bucket">month buckets</option>
                        </select>
                        <select id="ontologyFacetStatusFilter">
                          <option value="">all coverage states</option>
                          <option value="gap">gaps</option>
                          <option value="covered">covered</option>
                          <option value="sparse">sparse</option>
                        </select>
                      </div>
                      <div id="ontologyFacetSummary" class="ontology-stat-grid" style="margin-bottom:10px;"></div>
                      <div class="ontology-pagination">
                        <div id="ontologyFacetPageMeta" class="ontology-pagination-meta">Page 1 of 1</div>
                        <div class="ontology-pagination-actions">
                          <button id="ontologyFacetPrevButton" type="button">Previous</button>
                          <button id="ontologyFacetNextButton" type="button">Next</button>
                        </div>
                      </div>
                      <div id="ontologyFacetCoverage"></div>
                    </div>
                    <div class="panel">
                      <h4>Support Matrix</h4>
                      <div class="ontology-pagination">
                        <div id="ontologyMatrixPageMeta" class="ontology-pagination-meta">Page 1 of 1</div>
                        <div class="ontology-pagination-actions">
                          <button id="ontologyMatrixPrevButton" type="button">Previous</button>
                          <button id="ontologyMatrixNextButton" type="button">Next</button>
                        </div>
                      </div>
                      <div id="ontologySupportMatrix"></div>
                    </div>
                  </div>
                </div>
              </div>

              <div id="evoPanelPreloop" class="panel hidden">
                <h3>Pre-Loop Calibration</h3>
                <div class="preloop-shell">
                  <div class="panel">
                    <h4>Queue</h4>
                    <div class="preloop-glossary">
                      <div class="preloop-glossary-card" id="preloopGlossaryAmbiguity"></div>
                      <div class="preloop-glossary-card" id="preloopGlossarySets"></div>
                    </div>
                    <div class="preloop-count-blocks">
                      <div id="preloopQueueCounts" class="preloop-count-block">Queue now not loaded.</div>
                      <div id="preloopDatasetCounts" class="preloop-count-block">Dataset totals not loaded.</div>
                      <div id="preloopAuthoringCounts" class="preloop-count-block">Authoring totals not loaded.</div>
                    </div>
                    <div class="preloop-filter-grid">
                      <select id="preloopStatusFilter">
                        <option value="pending">pending only</option>
                        <option value="labeled">reviewed only</option>
                        <option value="all">all items</option>
                      </select>
                      <select id="preloopVerdictFilter">
                        <option value="">all verdicts</option>
                        <option value="yes">yes</option>
                        <option value="no">no</option>
                      </select>
                      <select id="preloopDomainFilter">
                        <option value="">all domains</option>
                      </select>
                      <select id="preloopAmbiguityFilter">
                        <option value="">all ambiguity classes</option>
                        <option value="clear">clear</option>
                        <option value="clarify_required">clarify required</option>
                        <option value="unresolved">unresolved</option>
                      </select>
                      <select id="preloopCaseSetFilter">
                        <option value="">all sets</option>
                        <option value="dev">dev</option>
                        <option value="critical">critical</option>
                        <option value="certification">certification</option>
                        <option value="stress">stress</option>
                        <option value="coverage">coverage</option>
                      </select>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr; gap:8px; margin-bottom:8px;">
                      <input id="preloopSampleCount" type="number" min="1" max="200" value="20" />
                    </div>
                    <button id="preloopGenerateSample" type="button" style="width:100%; margin-bottom:8px;">Generate Sample</button>
                    <button id="preloopAutoReview" type="button" style="width:100%; margin-bottom:8px;">Generate AI Suggestions</button>
                    <div id="preloopQueueList" class="preloop-queue-list"></div>
                  </div>
                  <div class="preloop-card">
                    <h4>Case Review</h4>
                    <div id="preloopCaseMeta" class="muted">Select a case.</div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Question</div>
                      <div id="preloopQuestionText"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Expected behavior</div>
                      <div id="preloopExpectedBehavior"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Semantic frame</div>
                      <div id="preloopSemanticFrame"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Clarification path</div>
                      <div id="preloopClarificationPath"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Expected answer summary</div>
                      <div id="preloopExpectedAnswer"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Evidence</div>
                      <div id="preloopEvidencePreview" class="preloop-evidence-list"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Admission</div>
                      <div id="preloopAdmission"></div>
                    </div>
                    <div class="preloop-section">
                      <div class="preloop-section-title">Quality gate</div>
                      <div id="preloopQualityGate"></div>
                    </div>
                  </div>
                  <div class="panel preloop-actions">
                    <h4>Decision</h4>
                    <div class="preloop-section">
                      <div class="preloop-section-title">AI suggestion</div>
                      <div id="preloopSuggestedReview" class="muted">No AI suggestion yet.</div>
                    </div>
                    <div class="preloop-decision-group">
                      <div class="preloop-section-title">Verdict</div>
                      <div class="preloop-button-row" id="preloopVerdictGroup">
                        <button id="preloopVerdictYes" class="preloop-choice-btn active" data-value="yes" type="button">Yes</button>
                        <button id="preloopVerdictNo" class="preloop-choice-btn" data-value="no" type="button">No</button>
                      </div>
                    </div>
                    <div class="preloop-decision-group">
                      <div class="preloop-section-title">Ambiguity class</div>
                      <div class="preloop-button-row" id="preloopAmbiguityGroup">
                        <button id="preloopAmbiguityClear" class="preloop-choice-btn active" data-value="clear" type="button">Clear</button>
                        <button id="preloopAmbiguityClarify" class="preloop-choice-btn" data-value="clarify_required" type="button">Clarify required</button>
                        <button id="preloopAmbiguityUnresolved" class="preloop-choice-btn" data-value="unresolved" type="button">Unresolved</button>
                      </div>
                    </div>
                    <textarea id="preloopNotes" rows="8" placeholder="Notes..."></textarea>
                    <button id="preloopSaveNext" type="button">Save + Next</button>
                    <div id="preloopActionMsg" class="muted"></div>
                  </div>
                </div>
                <div class="preloop-bottom">
                  <div id="preloopStageReadiness" class="muted" style="margin-bottom:8px;">Stage readiness: not loaded.</div>
                  <div id="preloopReadinessBar" class="muted">Readiness: not loaded.</div>
                </div>
              </div>

              <div id="evoPanelRunControl" class="panel hidden">
                <h3>Run Control</h3>
                <div id="runControlSummary" class="muted">No experiment selected.</div>
                <div class="runctl-actions" style="margin-top:8px;">
                  <select id="runControlLockStage">
                    <option value="core_ready">Core-ready lock</option>
                    <option value="selection_ready">Selection-ready lock</option>
                    <option value="certification_ready">Certification-ready lock</option>
                  </select>
                  <button id="runControlLockBenchmark" type="button" disabled>Lock Benchmark</button>
                  <button id="runControlStartLoop" type="button" disabled>Start Loop</button>
                  <button id="runControlRunStep" type="button">Run Single Step</button>
                  <button id="runControlStopLoop" type="button">Stop Loop</button>
                </div>
                <div id="runControlLog" class="runctl-log">Waiting.</div>
              </div>
            </div>
          </section>

          <section id="module-network" class="hidden">
            <div class="network-shell">
              <div class="network-rail">
                <div>
                  <h3 style="margin-bottom:6px; color:#15324a;">Network</h3>
                  <div class="network-muted">Ask, expand, focus, collapse, and save graph states from the same left rail.</div>
                </div>
                <div id="networkSuggestionWrap" class="network-suggestion-wrap"></div>
                <div id="networkChatThread" class="network-chat-thread">
                  <div class="network-chat-bubble agent">I can update the graph with prompts like "focus on family", "expand Nelson", or "collapse all".</div>
                </div>
                <div class="ask-chat-input-wrap" style="margin-top:0;">
                  <input id="networkChatInput" placeholder="Ask or command the graph..." />
                  <button id="networkChatSend" type="button">Run</button>
                </div>
                <div class="network-control-grid">
                  <select id="networkLayoutMode">
                    <option value="radial">Hybrid</option>
                    <option value="force">Force</option>
                    <option value="hierarchical">Hierarchical</option>
                  </select>
                  <select id="networkTickMode">
                    <option value="day">Day</option>
                    <option value="week" selected>Week</option>
                    <option value="month">Month</option>
                  </select>
                  <input id="networkStartDate" type="date" />
                  <input id="networkEndDate" type="date" />
                  <button id="networkPlayButton" type="button">Auto Play</button>
                  <button id="networkFitButton" type="button">Fit View</button>
                  <button id="networkToggleWeak" type="button">Show Weak</button>
                  <button id="networkCollapseAll" type="button">Collapse All</button>
                  <button id="networkSaveView" type="button">Save View</button>
                  <button id="networkSaveSnapshot" type="button">Save Snapshot</button>
                </div>
              </div>
              <div class="network-canvas">
                <div class="network-toolbar">
                  <div>
                    <h3 style="margin:0; color:#15324a;">Life Network</h3>
                    <div id="networkSummaryMeta" class="network-muted">Owner-centered shells load first; expand outward as needed.</div>
                  </div>
                  <div class="network-chip-row">
                    <span id="networkWeakChip" class="network-chip">Weak hidden</span>
                    <span id="networkLayoutChip" class="network-chip">Radial</span>
                  </div>
                </div>
                <div id="networkAnswerSummary" class="network-summary">Loading network...</div>
                <div id="networkGraph" class="graph network-graph"></div>
                <div id="networkHoverCard" class="network-hover-card hidden"></div>
                <div class="network-evidence-panel">
                  <div>
                    <div style="font-weight:700; color:#17324a;">Evidence Reader</div>
                    <div id="networkEvidenceSubtitle" class="network-muted">Select a leaf node to read the supporting thread or evidence.</div>
                  </div>
                  <div id="networkEvidenceList" class="network-evidence-list">
                    <div class="network-muted">No evidence selected yet.</div>
                  </div>
                </div>
              </div>
              <div class="network-detail">
                <div>
                  <h3 style="margin-bottom:6px; color:#15324a;">Details</h3>
                  <div id="networkDetailTitle" class="network-detail-title">You</div>
                  <div id="networkDetailSubtitle" class="network-muted">Select a node to inspect why it exists and what supports it.</div>
                </div>
                <div id="networkMiniMap" class="graph network-mini"></div>
                <div id="networkDetailSections"></div>
                <div class="network-detail-section">
                  <div style="font-weight:700;">Saved Views</div>
                  <div id="networkSavedViews" class="network-save-list"></div>
                </div>
                <div class="network-detail-section">
                  <div style="font-weight:700;">Snapshots</div>
                  <div id="networkSnapshots" class="network-save-list"></div>
                </div>
              </div>
            </div>
          </section>

          <section id="module-behavior" class="hidden">
            <div class="panel">
              <h3>Behavior Trends</h3>
              <div id="behaviorChart" class="chart"></div>
            </div>
          </section>

          <section id="module-timeline" class="hidden">
            <div class="panel">
              <h3>Timeline</h3>
              <div id="timelineList" class="muted"></div>
            </div>
          </section>

          <section id="module-insights" class="hidden">
            <div class="panel">
              <h3>Insight Feed</h3>
              <div id="insightFeed"></div>
            </div>
          </section>

          <section id="module-ops" class="hidden">
            <div class="panel">
              <h3>Pipeline and Jobs</h3>
              <div style="margin-bottom:8px;">
                <button id="pruneOpsButton">Prune Logs (60d)</button>
              </div>
              <div id="opsJobs" class="muted"></div>
            </div>
          </section>

          <section id="module-settings" class="hidden">
            <div class="panel">
              <h3>Settings</h3>
              <p class="muted">Login on refresh is enforced by design. Privacy mode is server-side and session-scoped.</p>
              <div style="display:grid; gap:8px; max-width:420px; margin-bottom:12px;">
                <input id="currentPasswordInput" type="password" placeholder="Current password" />
                <input id="newPasswordInput" type="password" placeholder="New password (min 8 chars)" />
                <button id="rotatePasswordButton">Rotate Password</button>
                <div id="rotatePasswordResult" class="muted"></div>
              </div>
              <button id="logoutButton">Logout</button>
            </div>
          </section>
        </div>
      </main>
    </div>
  </section>

  <script>
    (() => {
      const SESSION_STORAGE_TOKEN_KEY = "openbrain.authToken";
      const state = {
        token: "",
        authSeq: 0,
        sessionKeepaliveTimer: null,
        chatNamespace: "personal.main",
        privacyMode: "private",
        timeframe: "30d",
        module: "brief",
        askTab: "answer",
        askLoading: false,
        loginInProgress: false,
        lastAnswerRunId: "",
        lastAskSceneSeed: null,
        lastAskGraphSuggestion: null,
        pendingQuestion: "",
        awaitingClarification: false,
        briefChart: null,
        behaviorChart: null,
        network: {
          graph: null,
          miniMap: null,
          lastGraphPayload: null,
          includeWeak: false,
          sceneMode: "default",
          sceneSeed: null,
          selectedNodeId: "",
          selectedEdgeId: "",
          expandedNodeIds: [],
          collapsedNodeIds: [],
          overflowState: {},
          layoutMode: "radial",
          tickMode: "week",
          startDate: "",
          endDate: "",
          autoplayMaxDate: "",
          queryText: "",
          autoplayTimer: null
        },
        evolutionTab: "overview",
        evolution: {
          experimentId: "",
          experiments: [],
          ontologyVersionId: "",
          ontologyVersions: [],
          ontologyDetail: null,
          ontologySupportMatrix: [],
          ontologyFacetCoverage: [],
          ontologyFacetSummary: null,
          ontologyMatrixScrollTop: 0,
          ontologyMatrixPage: 0,
          ontologyFacetPage: 1,
          ontologyCandidates: [],
          ontologyFilteredCandidates: [],
          ontologyFreshness: null,
          lightPollTimer: null,
          heavyPollTimer: null,
          queue: [],
          filteredQueue: [],
          selectedQueueIndex: -1,
          selectedQueueItemId: "",
          activeReadiness: null,
          activePreloopReport: null,
          verdict: "yes",
          ambiguityClass: "clear",
          preloopDraft: {
            itemId: "",
            verdict: "yes",
            ambiguityClass: "clear",
            notes: "",
            dirty: false
          },
          preloopLoadSeq: 0,
          preloopSaving: false,
          loopRunning: false,
          frontierPoints: [],
          charts: {
            frontier: null,
            velocity: null,
            failures: null,
            heatmap: null,
            hypothesis: null,
            diversity: null
          },
          lineageGraph: null
        }
      };

      function persistSessionToken() {
        try {
          if (state.token) {
            window.sessionStorage.setItem(SESSION_STORAGE_TOKEN_KEY, state.token);
          } else {
            window.sessionStorage.removeItem(SESSION_STORAGE_TOKEN_KEY);
          }
        } catch {}
      }

      function restoreStoredSessionToken() {
        try {
          const stored = String(window.sessionStorage.getItem(SESSION_STORAGE_TOKEN_KEY) || "").trim();
          return stored;
        } catch {
          return "";
        }
      }

      function setSessionToken(token) {
        state.token = String(token || "").trim();
        state.authSeq += 1;
        persistSessionToken();
      }

      function getAuthSnapshot() {
        return {
          token: state.token,
          authSeq: state.authSeq
        };
      }

      function isAuthSnapshotCurrent(snapshot) {
        return Boolean(snapshot)
          && snapshot.authSeq === state.authSeq
          && snapshot.token === state.token;
      }

      const byId = (id) => document.getElementById(id);
      const loginPage = byId("loginPage");
      const appPage = byId("appPage");
      const loginError = byId("loginError");
      const modeBadge = byId("modeBadge");
      const privacySelect = byId("privacyModeSelect");
      const timeframeSelect = byId("timeframeSelect");
      const askLoadingEl = byId("askLoading");

      function escapeHtml(input) {
        return String(input ?? "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;");
      }

      function clearSessionKeepalive() {
        if (state.sessionKeepaliveTimer) {
          clearInterval(state.sessionKeepaliveTimer);
          state.sessionKeepaliveTimer = null;
        }
      }

      function startSessionKeepalive() {
        clearSessionKeepalive();
        if (!state.token) return;
        state.sessionKeepaliveTimer = setInterval(async () => {
          if (document.hidden || !state.token) return;
          try {
            await api("/v1/auth/session", { method: "GET" });
          } catch (error) {
            console.error(error);
          }
        }, 240000);
      }

      async function api(path, options = {}, requiresSession = true) {
        const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
        const requestAuth = getAuthSnapshot();
        if (requiresSession && requestAuth.token) {
          headers.Authorization = "Bearer " + requestAuth.token;
        }
        const response = await fetch(path, { ...options, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          if (requiresSession && response.status === 401) {
            let sessionStillValid = false;
            if (path !== "/v1/auth/session" && requestAuth.token) {
              try {
                const probe = await fetch("/v1/auth/session", {
                  method: "GET",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: "Bearer " + requestAuth.token
                  }
                });
                sessionStillValid = probe.ok;
              } catch {}
            }
            const message = payload.error || "Session expired. Please log in again.";
            if (!sessionStillValid && isAuthSnapshotCurrent(requestAuth)) {
              clearEvolutionPolling();
              clearSessionKeepalive();
              loginError.textContent = message;
              showLogin();
            }
            throw new Error(sessionStillValid ? (String(path) + ": " + message) : message);
          }
          throw new Error(payload.error || ("HTTP " + response.status));
        }
        return payload;
      }

      function setModeBadge() {
        modeBadge.textContent = state.privacyMode;
        modeBadge.className = "badge mode-" + state.privacyMode;
      }

      function setAskLoading(isLoading) {
        state.askLoading = Boolean(isLoading);
        askLoadingEl.classList.toggle("hidden", !state.askLoading);
        byId("askButton").disabled = state.askLoading || state.module === "ask";
        byId("globalQuestion").disabled = state.askLoading || state.module === "ask";
        byId("askChatInput").disabled = state.askLoading;
        byId("askChatSend").disabled = state.askLoading;
      }

      function syncAskInputMode() {
        const topbarAskDisabled = state.module === "ask";
        byId("askButton").disabled = state.askLoading || topbarAskDisabled;
        byId("globalQuestion").disabled = state.askLoading || topbarAskDisabled;
      }

      function switchAskTab(tabName) {
        state.askTab = tabName === "debug" ? "debug" : "answer";
        byId("askPanelAnswer").classList.toggle("hidden", state.askTab !== "answer");
        byId("askPanelDebug").classList.toggle("hidden", state.askTab !== "debug");
        byId("askTabAnswer").classList.toggle("active", state.askTab === "answer");
        byId("askTabDebug").classList.toggle("active", state.askTab === "debug");
      }

      function pickChart(payload, id) {
        const charts = Array.isArray(payload?.charts) ? payload.charts : [];
        return charts.find((c) => c.id === id) || charts[0] || null;
      }

      function fmtDate(iso) {
        if (!iso) return "n/a";
        const dt = new Date(iso);
        if (Number.isNaN(dt.getTime())) return iso;
        return dt.toLocaleString();
      }

      function resizeVisuals() {
        try { if (state.briefChart) state.briefChart.resize(); } catch {}
        try { if (state.behaviorChart) state.behaviorChart.resize(); } catch {}
        try { if (state.network.graph) { state.network.graph.resize(); state.network.graph.fit(undefined, 26); } } catch {}
        try { if (state.network.miniMap) { state.network.miniMap.resize(); state.network.miniMap.fit(undefined, 18); } } catch {}
        try { if (state.evolution.charts.frontier) state.evolution.charts.frontier.resize(); } catch {}
        try { if (state.evolution.charts.velocity) state.evolution.charts.velocity.resize(); } catch {}
        try { if (state.evolution.charts.failures) state.evolution.charts.failures.resize(); } catch {}
        try { if (state.evolution.charts.heatmap) state.evolution.charts.heatmap.resize(); } catch {}
        try { if (state.evolution.charts.hypothesis) state.evolution.charts.hypothesis.resize(); } catch {}
        try { if (state.evolution.charts.diversity) state.evolution.charts.diversity.resize(); } catch {}
        try { if (state.evolution.lineageGraph) { state.evolution.lineageGraph.resize(); state.evolution.lineageGraph.fit(undefined, 28); } } catch {}
      }

      function showApp() {
        loginPage.style.display = "none";
        appPage.style.display = "block";
        loginError.textContent = "";
        startSessionKeepalive();
      }

      function showLogin() {
        setSessionToken("");
        clearSessionKeepalive();
        loginPage.style.display = "grid";
        appPage.style.display = "none";
      }

      async function loadPrivacyMode() {
        const payload = await api("/v1/privacy/mode");
        state.privacyMode = payload.mode || "private";
        privacySelect.value = state.privacyMode;
        setModeBadge();
      }

      async function loadBrief() {
        const profile = await api("/v1/brain/profile?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&timeframe=" + state.timeframe);
        const metrics = byId("briefMetrics");
        const domains = Array.isArray(profile.topDomains) ? profile.topDomains.slice(0, 6) : [];
        metrics.innerHTML = domains.map((d) => \`<div class="metric"><span class="muted">\${d.domain}</span><b>\${Math.round(d.total || 0)}</b></div>\`).join("");

        const chartPayload = await api("/v1/brain/insights?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&timeframe=" + state.timeframe);
        const chartData = pickChart(chartPayload, "brief-domain-weekly");
        const chartEl = byId("briefChart");
        if (!state.briefChart) state.briefChart = echarts.init(chartEl);
        if (chartData) {
          state.briefChart.setOption({
            tooltip: { trigger: "axis" },
            legend: { textStyle: { color: "#c7d7ec" } },
            xAxis: { type: "category", data: chartData.labels, axisLabel: { color: "#9eb3cb" } },
            yAxis: { type: "value", axisLabel: { color: "#9eb3cb" } },
            grid: { left: 42, right: 20, top: 42, bottom: 36 },
            series: chartData.series.map((s) => ({ name: s.name, type: "bar", barMaxWidth: 22, data: s.data }))
          });
        } else {
          state.briefChart.clear();
        }
        resizeVisuals();
      }

      function appendNetworkBubble(role, text) {
        const thread = byId("networkChatThread");
        const bubble = document.createElement("div");
        bubble.className = "network-chat-bubble " + (role === "user" ? "user" : "agent");
        bubble.textContent = String(text ?? "");
        thread.appendChild(bubble);
        thread.scrollTop = thread.scrollHeight;
      }

      const NETWORK_ZONE_SEQUENCE = ["people", "family", "friends", "groups", "threads", "time", "topics", "projects", "places", "events", "agents-tools"];
      const NETWORK_ZONE_ANGLES = Object.fromEntries(
        NETWORK_ZONE_SEQUENCE.map((zoneKey, index) => {
          const angle = -90 + ((360 / NETWORK_ZONE_SEQUENCE.length) * index);
          return [zoneKey, angle];
        })
      );
      const NETWORK_ICON_MAP = {
        people: "people",
        family: "heart",
        friends: "friend",
        groups: "groups",
        threads: "thread",
        topics: "topic",
        projects: "project",
        places: "location",
        events: "event",
        time: "time",
        "agents-tools": "tool",
        actor: "person",
        group_chat: "groups",
        thread: "thread",
        topic: "topic",
        project: "project",
        location: "location",
        event: "event",
        time_bucket: "time",
        agents_tools: "tool",
        overflow: "overflow"
      };
      const NETWORK_ICON_SCALES = {
        people: 0.92,
        heart: 0.88,
        friend: 0.88,
        groups: 0.9,
        thread: 0.92,
        topic: 0.86,
        project: 0.9,
        location: 0.82,
        event: 0.84,
        time: 0.8,
        tool: 0.8,
        overflow: 1
      };
      const NETWORK_ICON_OFFSETS = {
        people: { x: 0, y: 2 },
        heart: { x: 0, y: 2 },
        friend: { x: 0, y: 2 },
        groups: { x: 0, y: 2 },
        thread: { x: 0, y: 1 },
        topic: { x: 0, y: 0 },
        project: { x: 0, y: 0 },
        location: { x: 0, y: 2 },
        event: { x: 0, y: 0 },
        time: { x: 0, y: 2 },
        tool: { x: 1, y: 1 },
        overflow: { x: 0, y: 0 }
      };
      const NETWORK_CATEGORY_TONES = {
        people: { fill: "#8fd4ff", stroke: "#4a98c8", text: "#17324a", glow: "rgba(143, 212, 255, 0.26)" },
        family: { fill: "#ffc4bc", stroke: "#e58b7f", text: "#17324a", glow: "rgba(255, 171, 160, 0.24)" },
        friends: { fill: "#bff0d4", stroke: "#66be8b", text: "#17324a", glow: "rgba(104, 211, 148, 0.22)" },
        groups: { fill: "#bfeee9", stroke: "#6ec8bd", text: "#17324a", glow: "rgba(110, 200, 189, 0.22)" },
        threads: { fill: "#cae1ff", stroke: "#7ca8dd", text: "#17324a", glow: "rgba(124, 168, 221, 0.22)" },
        time: { fill: "#dce7f1", stroke: "#95abbe", text: "#17324a", glow: "rgba(149, 171, 190, 0.16)" },
        topics: { fill: "#ffe19a", stroke: "#ddb659", text: "#17324a", glow: "rgba(255, 209, 102, 0.22)" },
        projects: { fill: "#ffd08f", stroke: "#e7a650", text: "#17324a", glow: "rgba(255, 163, 79, 0.2)" },
        places: { fill: "#ffc0a6", stroke: "#de8e6d", text: "#17324a", glow: "rgba(255, 156, 113, 0.2)" },
        events: { fill: "#ffcbc5", stroke: "#df8075", text: "#17324a", glow: "rgba(255, 129, 111, 0.18)" },
        "agents-tools": { fill: "#d9e3eb", stroke: "#8ea1b4", text: "#17324a", glow: "rgba(142, 161, 180, 0.16)" },
        overflow: { fill: "#ffffff", stroke: "#8ba6c0", text: "#214261", glow: "rgba(118, 154, 193, 0.18)" }
      };
      const NETWORK_PERSON_ZONE_TONES = {
        people: { fill: "#f5fbff", stroke: "#7aaed8", text: "#214261" },
        family: { fill: "#fff4f1", stroke: "#dd8d83", text: "#5b3440" },
        friends: { fill: "#f2fcf6", stroke: "#67ba8c", text: "#24463d" },
        groups: { fill: "#f3fcfb", stroke: "#6ec8bd", text: "#204f4a" },
        threads: { fill: "#f3f8ff", stroke: "#7ca8dd", text: "#294666" },
        topics: { fill: "#fff8e8", stroke: "#ddb659", text: "#624913" },
        projects: { fill: "#fff4e6", stroke: "#e7a650", text: "#624118" },
        places: { fill: "#fff1ea", stroke: "#de8e6d", text: "#653a26" },
        events: { fill: "#fff3f1", stroke: "#df8075", text: "#633732" },
        time: { fill: "#f7fafe", stroke: "#95abbe", text: "#32485d" },
        "agents-tools": { fill: "#f7f9fb", stroke: "#8ea1b4", text: "#3b4d60" }
      };

      function networkHash(value) {
        let hash = 0;
        const text = String(value || "");
        for (let idx = 0; idx < text.length; idx += 1) {
          hash = ((hash << 5) - hash) + text.charCodeAt(idx);
          hash |= 0;
        }
        return Math.abs(hash);
      }

      function networkEscapeSvg(value) {
        return String(value || "")
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
          .replaceAll('"', "&quot;")
          .replaceAll("'", "&apos;");
      }

      function networkSvgDataUrl(svg) {
        return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
      }

      function networkInitials(label) {
        const parts = String(label || "").trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) return "?";
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
      }

      function networkShellKey(node) {
        const shellKey = node?.metadata && typeof node.metadata.shellKey === "string" ? node.metadata.shellKey : "";
        if (shellKey) return shellKey;
        const nodeType = String(node?.nodeType || "");
        if (nodeType === "agents_tools") return "agents-tools";
        if (nodeType === "time_bucket") return "time";
        return nodeType.replaceAll("_", "-");
      }

      function networkToneForNode(node, zoneKeyOverride) {
        const zoneKey = zoneKeyOverride || (node ? networkShellKey(node) : "people");
        if (node.nodeType === "actor") {
          return NETWORK_PERSON_ZONE_TONES[zoneKey] || NETWORK_PERSON_ZONE_TONES.people;
        }
        if (node.nodeType === "owner") {
          return { fill: "#f7fbff", stroke: "#88b5d8", text: "#17324a", glow: "rgba(143, 212, 255, 0.24)" };
        }
        const shellKey = node.isShell ? networkShellKey(node) : null;
        const toneKey = shellKey || (node.nodeType === "agents_tools" ? "agents-tools" : node.nodeType === "time_bucket" ? "time" : node.nodeType);
        return NETWORK_CATEGORY_TONES[toneKey] || NETWORK_CATEGORY_TONES.people;
      }

      function networkIconMarkup(iconKey, stroke) {
        switch (iconKey) {
          case "people":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'><circle cx='44' cy='34' r='7'/><circle cx='28' cy='42' r='5.5'/><circle cx='60' cy='42' r='5.5'/><path d='M32 57c2-7 7-11 12-11s10 4 12 11'/><path d='M18 56c1.6-4.6 5-7.6 9-8.7'/><path d='M61 47.3c4 1.2 7.2 4.2 8.8 8.7'/></g>";
          case "heart":
            return "<path d='M44 60 20 38c-6-6-6-15 0-21 5-5 14-5 20 1 6-6 15-6 20-1 6 6 6 15 0 21Z' fill='none' stroke='" + stroke + "' stroke-width='2.6' stroke-linejoin='round'/>";
          case "friend":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' fill='none'><circle cx='33' cy='34' r='7'/><circle cx='55' cy='34' r='7'/><path d='M20 57c2-7 7-11 13-11s11 4 13 11'/><path d='M42 57c2-7 7-11 13-11s11 4 13 11'/></g>";
          case "groups":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' fill='none'><circle cx='44' cy='28' r='7'/><circle cx='26' cy='40' r='6'/><circle cx='62' cy='40' r='6'/><path d='M33 58c2-7 7-11 11-11 4 0 9 4 11 11'/><path d='M17 56c1.6-4.7 5.4-8 10-9'/><path d='M61 47c4.6 1.2 8.4 4.5 10 9'/></g>";
          case "thread":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'><path d='M18 24h52c5 0 9 4 9 9v18c0 5-4 9-9 9H43l-13 11v-11H18c-5 0-9-4-9-9V33c0-5 4-9 9-9Z'/><path d='M25 39h36'/><path d='M25 48h28'/></g>";
          case "topic":
            return "<g stroke='" + stroke + "' stroke-width='2.8' stroke-linecap='round'><path d='M32 18v52'/><path d='M56 18v52'/><path d='M18 32h52'/><path d='M18 56h52'/></g>";
          case "project":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'><path d='M24 20h40a6 6 0 0 1 6 6v34a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V26a6 6 0 0 1 6-6Z'/><path d='M31 16h26'/><path d='M28 36h26'/><path d='M28 48h18'/><path d='m52 50 5 5 9-11'/></g>";
          case "location":
            return "<path d='M44 68c11-17 17-26 17-34 0-9-7-17-17-17s-17 8-17 17c0 8 6 17 17 34Z' fill='none' stroke='" + stroke + "' stroke-width='2.6' stroke-linejoin='round'/><circle cx='44' cy='34' r='6' fill='none' stroke='" + stroke + "' stroke-width='2.6'/>";
          case "event":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'><rect x='18' y='22' width='52' height='42' rx='8'/><path d='M18 34h52'/><path d='M30 16v12'/><path d='M58 16v12'/><path d='m32 49 8 8 16-16'/></g>";
          case "time":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' fill='none'><circle cx='44' cy='42' r='24'/><path d='M44 28v16l10 6'/></g>";
          case "tool":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'><path d='m25 54 29-29'/><path d='M52 20a9 9 0 0 0 11 11l8 8-7 7-8-8a9 9 0 0 0-11-11Z'/><path d='m20 59 8 8'/></g>";
          case "overflow":
            return "<g stroke='" + stroke + "' stroke-width='2.6' stroke-linecap='round'><path d='M24 44h40'/><path d='M44 24v40'/></g>";
          default:
            return "<circle cx='44' cy='44' r='18' fill='none' stroke='" + stroke + "' stroke-width='2.6'/>";
        }
      }

      function networkScaledIconMarkup(iconKey, stroke, scale) {
        const offset = NETWORK_ICON_OFFSETS[iconKey] || { x: 0, y: 0 };
        return "<g transform='translate(" + offset.x + " " + offset.y + ") translate(44 44) scale(" + scale + ") translate(-44 -44)'>" + networkIconMarkup(iconKey, stroke) + "</g>";
      }

      function networkShellSvg(node, tone, iconKey, size) {
        const halo = tone.glow || "rgba(110, 160, 210, 0.18)";
        const iconScale = NETWORK_ICON_SCALES[iconKey] || 0.9;
        return networkSvgDataUrl(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 88 88'>"
            + "<defs><filter id='g'><feGaussianBlur stdDeviation='6'/></filter></defs>"
            + "<circle cx='44' cy='44' r='27' fill='" + halo + "' filter='url(%23g)'/>"
            + "<circle cx='44' cy='44' r='22' fill='" + tone.fill + "' fill-opacity='0.72'/>"
            + "<circle cx='44' cy='44' r='22' fill='none' stroke='" + tone.stroke + "' stroke-width='2.1'/>"
            + networkScaledIconMarkup(iconKey, tone.stroke, iconScale)
          + "</svg>"
        );
      }

      function networkPersonSvg(node, tone) {
        const initials = networkEscapeSvg(networkInitials(node.displayLabel || node.label));
        return networkSvgDataUrl(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 88 88'>"
            + "<defs><filter id='g'><feGaussianBlur stdDeviation='5'/></filter></defs>"
            + "<circle cx='44' cy='44' r='22' fill='rgba(122,174,216,0.1)' filter='url(%23g)'/>"
            + "<circle cx='44' cy='44' r='19' fill='" + tone.fill + "'/>"
            + "<circle cx='44' cy='44' r='19' fill='none' stroke='" + tone.stroke + "' stroke-width='2'/>"
            + "<text x='44' y='48' text-anchor='middle' font-family='Segoe UI, sans-serif' font-size='17' font-weight='700' fill='" + tone.text + "'>" + initials + "</text>"
          + "</svg>"
        );
      }

      function networkEntitySvg(node, tone, iconKey) {
        const iconScale = (NETWORK_ICON_SCALES[iconKey] || 0.9) + 0.02;
        return networkSvgDataUrl(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 88 88'>"
            + "<defs><filter id='g'><feGaussianBlur stdDeviation='4'/></filter></defs>"
            + "<circle cx='44' cy='44' r='21' fill='" + (tone.glow || "rgba(118,154,193,0.12)") + "' filter='url(%23g)'/>"
            + "<circle cx='44' cy='44' r='18.5' fill='#ffffff'/>"
            + "<circle cx='44' cy='44' r='18.5' fill='none' stroke='" + tone.stroke + "' stroke-width='1.9'/>"
            + networkScaledIconMarkup(iconKey, tone.stroke, iconScale)
          + "</svg>"
        );
      }

      function networkRootSvg() {
        return networkSvgDataUrl(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 120 120'>"
            + "<defs><radialGradient id='glass' cx='32%' cy='28%'><stop offset='0%' stop-color='%23ffffff' stop-opacity='0.95'/><stop offset='52%' stop-color='%23eef7ff' stop-opacity='0.92'/><stop offset='100%' stop-color='%23d9ecfa' stop-opacity='0.98'/></radialGradient><filter id='g'><feGaussianBlur stdDeviation='8'/></filter></defs>"
            + "<circle cx='60' cy='60' r='42' fill='rgba(143, 212, 255, 0.2)' filter='url(%23g)'/>"
            + "<circle cx='60' cy='60' r='34' fill='url(%23glass)'/>"
            + "<circle cx='60' cy='60' r='34' fill='none' stroke='%2388b5d8' stroke-width='3'/>"
            + "<circle cx='60' cy='60' r='24' fill='rgba(255,255,255,0.78)' stroke='%23b8d4ea' stroke-width='1.4'/>"
            + "<circle cx='60' cy='60' r='9' fill='%2396c8eb'/>"
            + "<path d='M60 28c-12 0-22 10-22 22 0 11 8 20 18 21v14h8V71c10-1 18-10 18-21 0-12-10-22-22-22Z' fill='none' stroke='%236f9fbe' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round' opacity='0.55'/>"
          + "</svg>"
        );
      }

      function networkOverflowSvg(node, tone) {
        const count = networkEscapeSvg(String(node.displayLabel || node.label || "+"));
        return networkSvgDataUrl(
          "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 88 88'>"
            + "<defs><filter id='g'><feGaussianBlur stdDeviation='4'/></filter></defs>"
            + "<circle cx='44' cy='44' r='25' fill='" + (tone.glow || "rgba(118,154,193,0.18)") + "' filter='url(%23g)'/>"
            + "<circle cx='44' cy='44' r='22' fill='#ffffff'/>"
            + "<circle cx='44' cy='44' r='22' fill='none' stroke='" + tone.stroke + "' stroke-width='2.4'/>"
            + "<text x='44' y='50' text-anchor='middle' font-family='Segoe UI, sans-serif' font-size='20' font-weight='700' fill='" + tone.text + "'>" + count + "</text>"
          + "</svg>"
        );
      }

      function networkZoneForNode(node, edges, nodesById, memo = {}) {
        if (memo[node.id]) return memo[node.id];
        if (node.nodeType === "owner") return "center";
        if (node.isShell) {
          memo[node.id] = networkShellKey(node);
          return memo[node.id];
        }
        if (node.nodeType === "overflow") {
          const targetId = String(node.metadata?.overflowForNodeId || "");
          const targetNode = nodesById.get(targetId);
          memo[node.id] = targetNode ? networkZoneForNode(targetNode, edges, nodesById, memo) : "people";
          return memo[node.id];
        }
        const relatedShell = edges.find((edge) => {
          if (edge.source !== node.id && edge.target !== node.id) return false;
          const otherId = edge.source === node.id ? edge.target : edge.source;
          const other = nodesById.get(otherId);
          return Boolean(other?.isShell);
        });
        if (relatedShell) {
          const shellId = relatedShell.source === node.id ? relatedShell.target : relatedShell.source;
          const shellNode = nodesById.get(shellId);
          memo[node.id] = shellNode ? networkShellKey(shellNode) : "people";
          return memo[node.id];
        }
        if (node.nodeType === "group_chat") return "groups";
        if (node.nodeType === "thread") return "threads";
        if (node.nodeType === "topic") return "topics";
        if (node.nodeType === "project") return "projects";
        if (node.nodeType === "location") return "places";
        if (node.nodeType === "event") return "events";
        if (node.nodeType === "time_bucket") return "time";
        if (node.nodeType === "agents_tools") return "agents-tools";
        memo[node.id] = node.relationshipClass === "family_confirmed" || node.relationshipClass === "family_likely"
          ? "family"
          : node.relationshipClass === "friend"
            ? "friends"
            : "people";
        return memo[node.id];
      }

      function networkPlaceOrbit(nodes, centerPoint, radiusStart, radiusStep, startAngle, endAngle, positions) {
        if (!Array.isArray(nodes) || nodes.length === 0) return;
        const perRing = 6;
        nodes.forEach((node, index) => {
          const ring = Math.floor(index / perRing);
          const ringStart = ring * perRing;
          const ringNodes = nodes.slice(ringStart, Math.min(nodes.length, ringStart + perRing));
          const slot = index - ringStart;
          const slots = ringNodes.length;
          const angle = slots <= 1
            ? (startAngle + endAngle) / 2
            : startAngle + (((endAngle - startAngle) * slot) / Math.max(1, slots - 1));
          const radius = radiusStart + (ring * radiusStep);
          positions[node.id] = {
            x: centerPoint.x + (Math.cos(angle) * radius),
            y: centerPoint.y + (Math.sin(angle) * radius)
          };
        });
      }

      function networkComputePositions(nodes, edges, selectedId) {
        const host = byId("networkGraph");
        const rect = host.getBoundingClientRect();
        const width = Math.max(920, Math.round(rect.width || 920));
        const height = Math.max(720, Math.round(rect.height || 720));
        const center = { x: width / 2, y: height / 2 };
        const shellRadius = Math.min(width, height) * 0.37;
        const positions = {};
        const nodesById = new Map(nodes.map((node) => [node.id, node]));
        const zoneMemo = {};
        const zoneAnchors = {};
        const adjacency = new Map();
        const ownerNode = nodes.find((node) => node.nodeType === "owner");

        edges.forEach((edge) => {
          const left = adjacency.get(edge.source) || [];
          left.push(edge.target);
          adjacency.set(edge.source, left);
          const right = adjacency.get(edge.target) || [];
          right.push(edge.source);
          adjacency.set(edge.target, right);
        });

        const placeShells = (radius) => {
          NETWORK_ZONE_SEQUENCE.forEach((zoneKey) => {
            const shellNode = nodes.find((node) => node.isShell && networkShellKey(node) === zoneKey);
            if (!shellNode) return;
            const angle = (NETWORK_ZONE_ANGLES[zoneKey] || 0) * Math.PI / 180;
            const anchor = {
              x: center.x + Math.cos(angle) * radius,
              y: center.y + Math.sin(angle) * radius
            };
            zoneAnchors[zoneKey] = { angle, anchor };
            if (!positions[shellNode.id]) positions[shellNode.id] = anchor;
          });
        };

        const placeOverview = () => {
          if (ownerNode) positions[ownerNode.id] = center;
          placeShells(shellRadius);
          NETWORK_ZONE_SEQUENCE.forEach((zoneKey) => {
            const zoneNodes = nodes
              .filter((node) => !node.isShell && node.nodeType !== "owner" && networkZoneForNode(node, edges, nodesById, zoneMemo) === zoneKey)
              .sort((a, b) => Number(a.nodeType === "overflow") - Number(b.nodeType === "overflow") || b.strength - a.strength);
            const zone = zoneAnchors[zoneKey];
            if (!zone || zoneNodes.length === 0) return;
            const outward = { x: Math.cos(zone.angle), y: Math.sin(zone.angle) };
            const tangent = { x: -Math.sin(zone.angle), y: Math.cos(zone.angle) };
            zoneNodes.forEach((node, index) => {
              const ring = Math.floor(index / 5);
              const slot = index % 5;
              const slots = Math.min(5, zoneNodes.length - ring * 5);
              const tangentOffset = slots === 1 ? 0 : (slot - (slots - 1) / 2) * 64;
              const outwardDistance = 118 + (ring * 76);
              positions[node.id] = {
                x: zone.anchor.x + (outward.x * outwardDistance) + (tangent.x * tangentOffset),
                y: zone.anchor.y + (outward.y * outwardDistance) + (tangent.y * tangentOffset)
              };
            });
          });
        };

        const selectedNode = selectedId ? nodesById.get(selectedId) : null;
        if (!selectedNode || selectedNode.nodeType === "owner") {
          placeOverview();
          return positions;
        }

        const ownerPos = selectedNode.isShell
          ? { x: center.x - 136, y: center.y + 126 }
          : { x: center.x - 148, y: center.y + 134 };
        if (ownerNode) positions[ownerNode.id] = ownerPos;
        placeShells(Math.min(width, height) * 0.4);

        const selectedPos = selectedNode.isShell
          ? { x: center.x + 22, y: center.y + 2 }
          : { x: center.x + 24, y: center.y + 8 };
        positions[selectedNode.id] = selectedPos;

        const directNeighbors = (adjacency.get(selectedNode.id) || [])
          .map((id) => nodesById.get(id))
          .filter(Boolean)
          .sort((a, b) => Number(a.nodeType === "overflow") - Number(b.nodeType === "overflow") || b.strength - a.strength);

        if (selectedNode.isShell) {
          const orbitNodes = directNeighbors.filter((node) => !node.isShell && node.nodeType !== "owner");
          const overflowNodes = orbitNodes.filter((node) => node.nodeType === "overflow");
          const regularNodes = orbitNodes.filter((node) => node.nodeType !== "overflow");
          const ownerAngle = Math.atan2(ownerPos.y - selectedPos.y, ownerPos.x - selectedPos.x);
          networkPlaceOrbit(regularNodes, selectedPos, 224, 96, ownerAngle + 0.64, ownerAngle + (Math.PI * 2) - 0.64, positions);
          networkPlaceOrbit(overflowNodes, selectedPos, 308, 32, ownerAngle + 0.96, ownerAngle + 1.24, positions);
        } else {
          const shellNeighbor = directNeighbors.find((node) => node.isShell);
          if (shellNeighbor) {
            positions[shellNeighbor.id] = { x: selectedPos.x - 210, y: selectedPos.y - 144 };
          }
          const orbitNodes = directNeighbors.filter((node) => node.id !== shellNeighbor?.id && node.nodeType !== "owner");
          const overflowNodes = orbitNodes.filter((node) => node.nodeType === "overflow");
          const regularNodes = orbitNodes.filter((node) => node.nodeType !== "overflow");
          const ownerAngle = Math.atan2(ownerPos.y - selectedPos.y, ownerPos.x - selectedPos.x);
          networkPlaceOrbit(regularNodes, selectedPos, 210, 82, ownerAngle + 0.66, ownerAngle + (Math.PI * 2) - 0.66, positions);
          networkPlaceOrbit(overflowNodes, selectedPos, 298, 26, ownerAngle + 0.9, ownerAngle + 1.16, positions);
        }

        NETWORK_ZONE_SEQUENCE.forEach((zoneKey) => {
          const zone = zoneAnchors[zoneKey];
          if (!zone) return;
          const zoneNodes = nodes
            .filter((node) => !positions[node.id] && networkZoneForNode(node, edges, nodesById, zoneMemo) === zoneKey)
            .sort((a, b) => Number(a.nodeType === "overflow") - Number(b.nodeType === "overflow") || b.strength - a.strength);
          if (zoneNodes.length === 0) return;
          networkPlaceOrbit(zoneNodes, zone.anchor, 116, 56, zone.angle - 0.48, zone.angle + 0.48, positions);
        });

        nodes.forEach((node) => {
          if (!positions[node.id]) {
            positions[node.id] = {
              x: center.x + ((Math.random() * 60) - 30),
              y: center.y + ((Math.random() * 60) - 30)
            };
          }
        });

        return positions;
      }

      function networkLayoutConfig(positions) {
        if (state.network.layoutMode === "force") {
          return {
            name: "cose",
            animate: true,
            animationDuration: 260,
            fit: true,
            padding: 44,
            randomize: false,
            idealEdgeLength: 120,
            nodeRepulsion: 17000,
            gravity: 0.22
          };
        }
        if (state.network.layoutMode === "hierarchical") {
          return {
            name: "breadthfirst",
            animate: true,
            animationDuration: 220,
            spacingFactor: 1.18,
            padding: 40,
            directed: false
          };
        }
        return {
          name: "preset",
          positions: (node) => positions[node.id()] || positions[node.data("id")] || { x: 0, y: 0 },
          fit: true,
          padding: 44,
          animate: true,
          animationDuration: 180
        };
      }

      function applyNetworkFocus(nodeId) {
        if (!state.network.graph) return;
        const cy = state.network.graph;
        cy.elements().removeClass("faded focus-edge focus-node");
        if (state.network.sceneMode === "answer_scene") return;
        if (!nodeId) return;
        const node = cy.getElementById(nodeId);
        if (!node || node.empty()) return;
        const neighborhood = node.closedNeighborhood();
        cy.elements().difference(neighborhood).addClass("faded");
        node.addClass("focus-node");
        node.connectedEdges().addClass("focus-edge");
      }

      function hideNetworkHoverCard() {
        const card = byId("networkHoverCard");
        card.classList.add("hidden");
        card.innerHTML = "";
      }

      function showNetworkHoverCard(node, renderedPosition) {
        const card = byId("networkHoverCard");
        if (!node) {
          hideNetworkHoverCard();
          return;
        }
        const excerpt = Array.isArray(node.evidenceSummary) && node.evidenceSummary.length > 0
          ? String(node.evidenceSummary[0].excerpt || "").trim()
          : String(node.fullLabel || node.label || "").trim();
        card.innerHTML =
          '<div class="network-hover-title">' + escapeHtml(String(node.displayLabel || node.label || "")) + '</div>'
          + '<div class="network-hover-body">' + escapeHtml(excerpt || "No summary available.") + '</div>';
        const graphRect = byId("networkGraph").getBoundingClientRect();
        const canvasRect = byId("networkGraph").parentElement.getBoundingClientRect();
        const baseLeft = graphRect.left - canvasRect.left;
        const baseTop = graphRect.top - canvasRect.top;
        const x = Math.min(Math.max(12, baseLeft + Number(renderedPosition?.x || 0) + 22), baseLeft + graphRect.width - 278);
        const y = Math.min(Math.max(12, baseTop + Number(renderedPosition?.y || 0) + 18), baseTop + graphRect.height - 118);
        card.style.left = x + "px";
        card.style.top = y + "px";
        card.classList.remove("hidden");
      }

      function renderNetworkSuggestions(items) {
        const wrap = byId("networkSuggestionWrap");
        const suggestions = Array.isArray(items) ? items : [];
        wrap.innerHTML = suggestions.map((item) => '<button class="network-suggestion" type="button">' + escapeHtml(String(item)) + '</button>').join("");
        wrap.querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", async () => {
            byId("networkChatInput").value = btn.textContent || "";
            await runNetworkInput(btn.textContent || "");
          });
        });
      }

      function renderNetworkDetail(detail, payload = null) {
        const title = byId("networkDetailTitle");
        const subtitle = byId("networkDetailSubtitle");
        const sectionsHost = byId("networkDetailSections");
        if (!detail) {
          title.textContent = "You";
          subtitle.textContent = "Select a node to inspect why it exists and what supports it.";
          sectionsHost.innerHTML = "";
          return;
        }
        title.textContent = String(detail.title || "You");
        subtitle.textContent = String(detail.subtitle || "");
        const sections = Array.isArray(detail.sections) ? [...detail.sections] : [];
        const panelItems = Array.isArray(payload?.evidencePanel?.items) ? payload.evidencePanel.items : [];
        if (panelItems.length > 0) {
          const evidenceBullets = panelItems
            .map((item) => {
              const excerpt = String(item?.excerpt || "").trim();
              if (!excerpt) return "";
              const actor = String(item?.actorName || "").trim();
              const conversation = String(item?.conversationLabel || "").trim();
              const prefix = [actor, conversation].filter(Boolean).join(" · ");
              return prefix ? prefix + ": " + excerpt : excerpt;
            })
            .filter(Boolean)
            .slice(0, 4);
          const existingEvidence = sections.find((section) => String(section?.title || "").toLowerCase() === "evidence");
          if (existingEvidence) {
            existingEvidence.body = "Supporting evidence for the current selection.";
            existingEvidence.bullets = evidenceBullets;
          } else {
            sections.push({
              title: "Evidence",
              body: "Supporting evidence for the current selection.",
              bullets: evidenceBullets
            });
          }
        }
        sectionsHost.innerHTML = sections.map((section) => {
          const bullets = Array.isArray(section.bullets) && section.bullets.length > 0
            ? '<div class="network-detail-list">' + section.bullets.map((item) => '<div>' + escapeHtml(String(item)) + '</div>').join("") + '</div>'
            : '';
          return '<div class="network-detail-section"><div style="font-weight:700; color:#17324a;">' + escapeHtml(String(section.title || "")) + '</div><div class="network-muted">' + escapeHtml(String(section.body || "")) + '</div>' + bullets + '</div>';
        }).join("");
      }

      function renderNetworkSavedLists(payload) {
        const renderItems = (hostId, items, labelKey) => {
          const host = byId(hostId);
          host.innerHTML = Array.isArray(items) && items.length > 0
            ? items.map((item) => {
                const id = String(item.id || "");
                const label = String(item[labelKey] || "");
                const date = String(item.updatedAt || item.createdAt || "");
                return '<div class="network-save-item"><div><b>' + escapeHtml(label) + '</b></div><div class="network-muted">' + escapeHtml(fmtDate(date)) + '</div><button type="button" data-id="' + escapeHtml(id) + '">Load</button></div>';
              }).join("")
            : '<div class="network-muted">None yet.</div>';
        };
        renderItems("networkSavedViews", payload.savedViews, "viewName");
        renderItems("networkSnapshots", payload.snapshots, "snapshotName");
        byId("networkSavedViews").querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", async () => {
            state.network.queryText = "";
            state.network.sceneMode = "default";
            state.network.sceneSeed = null;
            state.network.selectedNodeId = "";
            state.network.selectedEdgeId = "";
            state.network.expandedNodeIds = [];
            state.network.collapsedNodeIds = [];
            state.network.overflowState = {};
            await loadNetworkGraph({ savedViewId: btn.dataset.id || "", snapshotId: "" });
          });
        });
        byId("networkSnapshots").querySelectorAll("button").forEach((btn) => {
          btn.addEventListener("click", async () => {
            state.network.queryText = "";
            state.network.sceneMode = "default";
            state.network.sceneSeed = null;
            state.network.selectedNodeId = "";
            state.network.selectedEdgeId = "";
            state.network.expandedNodeIds = [];
            state.network.collapsedNodeIds = [];
            state.network.overflowState = {};
            await loadNetworkGraph({ snapshotId: btn.dataset.id || "", savedViewId: "" });
          });
        });
      }

      function renderNetworkEvidencePanel(payload) {
        const subtitle = byId("networkEvidenceSubtitle");
        const host = byId("networkEvidenceList");
        if (payload && payload.evidencePanel && typeof payload.evidencePanel === "object") {
          const panel = payload.evidencePanel;
          const items = Array.isArray(panel.items) ? panel.items : [];
          subtitle.textContent = String(panel.subtitle || "Supporting evidence.");
          host.innerHTML = items.length === 0
            ? '<div class="network-muted">No supporting evidence is loaded for this selection yet.</div>'
            : items.map((item) => {
                const meta = [
                  item.kind ? String(item.kind).replaceAll("_", " ") : "",
                  item.actorName,
                  item.conversationLabel,
                  item.sourceSystem,
                  item.sourceTimestamp
                ].filter(Boolean);
                const before = Array.isArray(item.contextBefore) && item.contextBefore.length > 0
                  ? '<div class="network-evidence-context">' + item.contextBefore.map((line) => '<div>' + escapeHtml(String(line)) + '</div>').join("") + '</div>'
                  : "";
                const after = Array.isArray(item.contextAfter) && item.contextAfter.length > 0
                  ? '<div class="network-evidence-context">' + item.contextAfter.map((line) => '<div>' + escapeHtml(String(line)) + '</div>').join("") + '</div>'
                  : "";
                return '<div class="network-evidence-item">'
                  + '<div style="font-weight:700; color:#17324a;">' + escapeHtml(String(item.title || "")) + '</div>'
                  + '<div class="network-evidence-meta">' + meta.map((part) => '<span>' + escapeHtml(String(part)) + '</span>').join("") + '</div>'
                  + before
                  + '<div style="line-height:1.55; white-space:pre-wrap; font-weight:600;">' + escapeHtml(String(item.excerpt || "")) + '</div>'
                  + after
                  + '</div>';
              }).join("");
          return;
        }
        const nodes = Array.isArray(payload?.graph?.nodes) ? payload.graph.nodes : [];
        const edges = Array.isArray(payload?.graph?.edges) ? payload.graph.edges : [];
        const selectedId = String(payload?.graph?.selectedNodeId || "");
        const selectedNode = nodes.find((node) => node.id === selectedId);
        if (!selectedNode || selectedNode.nodeType === "owner") {
          subtitle.textContent = "Select a leaf node to read the supporting thread or evidence.";
          host.innerHTML = '<div class="network-muted">No evidence selected yet.</div>';
          return;
        }
        const items = [];
        const pushEvidence = (title, evidence) => {
          if (!evidence || !String(evidence.excerpt || "").trim()) return;
          items.push({
            title,
            excerpt: String(evidence.excerpt || "").trim(),
            kind: String(evidence.kind || ""),
            sourceSystem: String(evidence.sourceSystem || ""),
            sourceTimestamp: String(evidence.sourceTimestamp || ""),
            actorName: String(evidence.actorName || ""),
            conversationLabel: String(evidence.conversationLabel || "")
          });
        };
        (selectedNode.evidenceSummary || []).forEach((evidence) => pushEvidence(selectedNode.displayLabel, evidence));
        edges
          .filter((edge) => edge.source === selectedId || edge.target === selectedId)
          .slice(0, 8)
          .forEach((edge) => {
            (edge.evidenceSummary || []).forEach((evidence) => pushEvidence(edge.label, evidence));
          });
        const deduped = [];
        const seen = new Set();
        for (const item of items) {
          const key = [item.title, item.excerpt, item.sourceTimestamp, item.conversationLabel].join("||");
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(item);
        }
        subtitle.textContent = "Full evidence and thread context for " + String(selectedNode.displayLabel || selectedNode.label || "this node") + ".";
        host.innerHTML = deduped.length === 0
          ? '<div class="network-muted">No supporting evidence is loaded for this node yet.</div>'
          : deduped.slice(0, 12).map((item) => {
              const meta = [
                item.kind ? item.kind.replaceAll("_", " ") : "",
                item.actorName,
                item.conversationLabel,
                item.sourceSystem,
                item.sourceTimestamp
              ].filter(Boolean);
              return '<div class="network-evidence-item">'
                + '<div style="font-weight:700; color:#17324a;">' + escapeHtml(item.title) + '</div>'
                + '<div class="network-evidence-meta">' + meta.map((part) => '<span>' + escapeHtml(String(part)) + '</span>').join("") + '</div>'
                + '<div style="line-height:1.55; white-space:pre-wrap;">' + escapeHtml(item.excerpt) + '</div>'
                + '</div>';
            }).join("");
      }

      function renderNetworkGraph(payload) {
        state.network.lastGraphPayload = payload;
        state.network.sceneMode = String(payload?.sceneMode || state.network.sceneMode || "default");
        const nodes = Array.isArray(payload?.graph?.nodes) ? payload.graph.nodes : [];
        const edges = Array.isArray(payload?.graph?.edges) ? payload.graph.edges : [];
        const nodesById = new Map(nodes.map((node) => [node.id, node]));
        const adjacency = new Map();
        edges.forEach((edge) => {
          const left = adjacency.get(edge.source) || [];
          left.push(edge.target);
          adjacency.set(edge.source, left);
          const right = adjacency.get(edge.target) || [];
          right.push(edge.source);
          adjacency.set(edge.target, right);
        });
        const zoneMemo = {};
        const zonePriority = new Map(NETWORK_ZONE_SEQUENCE.map((zone, index) => [zone, index]));
        const labelsByZone = new Map();
        const selectedId = String(payload?.graph?.selectedNodeId || state.network.selectedNodeId || "");
        const selectedNode = selectedId ? nodesById.get(selectedId) : null;
        nodes.forEach((node) => {
          const zoneKey = networkZoneForNode(node, edges, nodesById, zoneMemo);
          const bucket = labelsByZone.get(zoneKey) || [];
          if (!node.isShell && node.nodeType !== "owner" && node.nodeType !== "overflow") bucket.push(node);
          labelsByZone.set(zoneKey, bucket);
        });
        const visibleLabelIds = new Set(
          nodes
            .filter((node) => node.isShell || node.nodeType === "owner" || node.nodeType === "overflow")
            .map((node) => node.id)
        );
        if (selectedNode && selectedNode.nodeType !== "owner") {
          const directLabels = (adjacency.get(selectedId) || [])
            .map((id) => nodesById.get(id))
            .filter(Boolean)
            .filter((node) => node.nodeType !== "owner")
            .sort((a, b) => Number(a.nodeType === "overflow") - Number(b.nodeType === "overflow") || b.strength - a.strength)
            .slice(0, selectedNode.isShell ? 10 : 8);
          directLabels.forEach((node) => visibleLabelIds.add(node.id));
        } else {
          labelsByZone.forEach((bucket) => {
            bucket
              .sort((a, b) => b.strength - a.strength)
              .slice(0, 2)
              .forEach((node) => visibleLabelIds.add(node.id));
          });
        }
        if (selectedId) visibleLabelIds.add(selectedId);

        const positions = networkComputePositions(nodes, edges, selectedId);
        const cyElements = [
          ...nodes.map((node) => {
            const zoneKey = networkZoneForNode(node, edges, nodesById, zoneMemo);
            const tone = networkToneForNode(node, zoneKey);
            const iconKey = NETWORK_ICON_MAP[node.isShell ? networkShellKey(node) : node.nodeType] || "topic";
            const size = node.nodeType === "owner"
              ? 104
              : node.isShell
                ? 84
                : node.nodeType === "actor"
                  ? 62
                  : node.nodeType === "overflow"
                    ? 72
                    : 58;
            const image = node.nodeType === "owner"
              ? networkRootSvg()
              : node.isShell
                ? networkShellSvg(node, tone, iconKey, size)
              : node.nodeType === "actor"
                ? networkPersonSvg(node, tone)
              : node.nodeType === "overflow"
                  ? networkOverflowSvg(node, tone)
                  : networkEntitySvg(node, tone, iconKey);
            return {
              data: {
                id: node.id,
                labelText: visibleLabelIds.has(node.id) ? String(node.displayLabel || node.label || "") : "",
                nodeType: node.nodeType,
                strength: Number(node.strength || 0),
                certainty: Number(node.certainty || 0),
                isShell: Boolean(node.isShell),
                bgImage: image,
                nodeSize: size,
                labelColor: tone.text,
                zoneKey,
                zoneRank: zonePriority.get(zoneKey) ?? 99
              },
              position: positions[node.id]
            };
          }),
          ...edges.map((edge) => {
            const sourceZone = networkZoneForNode(nodesById.get(edge.source) || {}, edges, nodesById, zoneMemo);
            const tone = NETWORK_CATEGORY_TONES[sourceZone] || NETWORK_CATEGORY_TONES.people;
            const isFocused = selectedId && (edge.source === selectedId || edge.target === selectedId);
            const edgeLabel = isFocused && edge.edgeType !== "belongs_to_category" && edge.edgeType !== "overflow"
              ? ""
              : "";
            return {
              data: {
                id: edge.id,
                source: edge.source,
                target: edge.target,
                edgeType: edge.edgeType,
                strength: Number(edge.strength || 0.2),
                edgeColor: tone.stroke,
                edgeLabel
              }
            };
          })
        ];
        const style = [
          {
            selector: "node",
            style: {
              label: "data(labelText)",
              color: "data(labelColor)",
              "font-size": 12,
              "font-weight": 600,
              "text-wrap": "wrap",
              "text-max-width": 124,
              "text-valign": "bottom",
              "text-halign": "center",
              "text-margin-y": 10,
              "text-background-opacity": 0.9,
              "text-background-color": "#f9fcff",
              "text-background-shape": "roundrectangle",
              "text-background-padding": "2px",
              width: "data(nodeSize)",
              height: "data(nodeSize)",
              shape: "ellipse",
              "background-opacity": 0,
              "border-width": 0,
              "background-image": "data(bgImage)",
              "background-fit": "contain",
              "background-repeat": "no-repeat",
              "overlay-opacity": 0
            }
          },
          {
            selector: 'node[nodeType = "overflow"]',
            style: {
              "text-margin-y": 0,
              label: "",
              "z-index-compare": "manual",
              "z-index": 999
            }
          },
          {
            selector: "edge",
            style: {
              width: "mapData(strength, 0, 1, 0.5, 1.35)",
              "line-color": "#cfdae5",
              "curve-style": "bezier",
              opacity: 0.28,
              "target-arrow-shape": "none",
              label: "data(edgeLabel)",
              color: "#7f95ab",
              "font-size": 10,
              "text-rotation": "autorotate",
              "text-margin-y": -8
            }
          },
          {
            selector: 'edge[edgeType = "belongs_to_category"]',
            style: {
              "line-style": "solid",
              opacity: 0.28
            }
          },
          {
            selector: 'edge[edgeType = "overflow"]',
            style: {
              "line-style": "dashed",
              opacity: 0.28
            }
          },
          { selector: ".faded", style: { opacity: 0.015 } },
          { selector: ".focus-edge", style: { opacity: 0.62, width: 1.9, "line-color": "#92a9bd" } },
          { selector: ".focus-node", style: { opacity: 1 } },
          { selector: ":selected", style: { "overlay-opacity": 0, opacity: 1 } }
        ];
        if (state.network.graph) state.network.graph.destroy();
        state.network.graph = cytoscape({
          container: byId("networkGraph"),
          elements: cyElements,
          style,
          layout: { name: "preset", fit: true, padding: 68 },
          autounselectify: true,
          boxSelectionEnabled: false
        });
        const layout = state.network.graph.layout(networkLayoutConfig(positions));
        layout.run();
        state.network.graph.on("tap", "node", async (event) => {
          const nodeId = event.target.id();
          const node = (state.network.lastGraphPayload?.graph?.nodes || []).find((item) => item.id === nodeId);
          if (node && node.nodeType === "owner") {
            if (state.network.sceneMode === "answer_scene") {
              state.network.selectedNodeId = nodeId;
              state.network.selectedEdgeId = "";
              await loadNetworkGraph();
              return;
            }
            state.network.queryText = "";
            state.network.selectedNodeId = "";
            state.network.selectedEdgeId = "";
            state.network.expandedNodeIds = [];
            state.network.collapsedNodeIds = [];
            state.network.overflowState = {};
            await loadNetworkGraph({ command: "collapse all" });
            return;
          }
          if (node && node.nodeType === "overflow") {
            const targetId = String(node.metadata?.overflowForNodeId || "");
            if (targetId) {
              state.network.overflowState[targetId] = Math.max(0, Number(state.network.overflowState[targetId] || 0) + 1);
              state.network.selectedNodeId = targetId;
              await loadNetworkGraph();
            }
            return;
          }
          state.network.selectedNodeId = nodeId;
          state.network.selectedEdgeId = "";
          if (state.network.sceneMode === "answer_scene") {
            await loadNetworkGraph();
            return;
          }
          state.network.collapsedNodeIds = state.network.collapsedNodeIds.filter((id) => id !== nodeId);
          if (!state.network.expandedNodeIds.includes(nodeId)) state.network.expandedNodeIds.push(nodeId);
          await loadNetworkGraph();
        });
        state.network.graph.on("tap", "edge", async (event) => {
          if (state.network.sceneMode !== "answer_scene") return;
          state.network.selectedEdgeId = event.target.id();
          await loadNetworkGraph();
        });
        state.network.graph.on("mouseover", "node", (event) => {
          const nodeId = event.target.id();
          const node = (state.network.lastGraphPayload?.graph?.nodes || []).find((item) => item.id === nodeId);
          if (node) {
            byId("networkSummaryMeta").textContent = String(node.fullLabel || node.label || "");
            showNetworkHoverCard(node, event.renderedPosition);
          }
        });
        state.network.graph.on("mousemove", "node", (event) => {
          const nodeId = event.target.id();
          const node = (state.network.lastGraphPayload?.graph?.nodes || []).find((item) => item.id === nodeId);
          if (node) showNetworkHoverCard(node, event.renderedPosition);
        });
        state.network.graph.on("mouseout", "node", () => {
          hideNetworkHoverCard();
          byId("networkSummaryMeta").textContent = "Owner-centered shells load first; expand outward as needed.";
        });
        if (state.network.miniMap) state.network.miniMap.destroy();
        state.network.miniMap = cytoscape({
          container: byId("networkMiniMap"),
          elements: cyElements,
          style: [
            { selector: "node", style: { width: 10, height: 10, "background-color": "#b8cadc", "border-width": 0 } },
            { selector: 'node[nodeType = "owner"]', style: { width: 14, height: 14, "background-color": "#87b5d8" } },
            { selector: "edge", style: { width: 1, "line-color": "#d2dfe9", opacity: 0.65 } }
          ],
          layout: { ...networkLayoutConfig(positions), animate: false }
        });
        if (selectedId) {
          const selectedCollection = state.network.graph.getElementById(selectedId).closedNeighborhood();
          const ownerCollection = state.network.graph.nodes().filter((node) => node.data("nodeType") === "owner");
          const fitCollection = ownerCollection && !ownerCollection.empty()
            ? selectedCollection.union(ownerCollection)
            : selectedCollection;
          state.network.graph.fit(fitCollection, 56);
        } else {
          state.network.graph.fit(undefined, 48);
        }
        state.network.miniMap.fit(undefined, 18);
      }

      async function loadNetworkGraph(overrides = {}) {
        byId("networkLayoutMode").value = state.network.layoutMode;
        byId("networkTickMode").value = state.network.tickMode;
        if (state.network.startDate) byId("networkStartDate").value = state.network.startDate;
        if (state.network.endDate) byId("networkEndDate").value = state.network.endDate;
        const useSavedArtifact = Boolean(overrides && (overrides.savedViewId || overrides.snapshotId));
        const payload = await api("/v2/brain/search/graph", {
          method: "POST",
          body: JSON.stringify({
            chatNamespace: state.chatNamespace,
            limit: 220,
            query: useSavedArtifact ? undefined : (state.network.queryText || undefined),
            sceneMode: useSavedArtifact ? undefined : state.network.sceneMode,
            sceneSeed: useSavedArtifact ? undefined : state.network.sceneSeed,
            selectedNodeId: useSavedArtifact ? undefined : (state.network.selectedNodeId || undefined),
            selectedEdgeId: useSavedArtifact ? undefined : (state.network.selectedEdgeId || undefined),
            expandedNodeIds: useSavedArtifact ? undefined : state.network.expandedNodeIds,
            collapsedNodeIds: useSavedArtifact ? undefined : state.network.collapsedNodeIds,
            overflowState: useSavedArtifact ? undefined : state.network.overflowState,
            confidenceMode: state.network.includeWeak ? "include_weak" : "strong_only",
            layoutMode: state.network.layoutMode,
            autoplayTickMode: state.network.tickMode,
            startDate: state.network.startDate || undefined,
            endDate: state.network.endDate || undefined,
            ...overrides
          })
        });
        state.network.selectedNodeId = String(payload?.graph?.selectedNodeId || state.network.selectedNodeId || "");
        state.network.selectedEdgeId = String(payload?.graph?.selectedEdgeId || state.network.selectedEdgeId || "");
        renderNetworkGraph(payload);
        renderNetworkDetail(payload.detailPanel, payload);
        renderNetworkEvidencePanel(payload);
        renderNetworkSuggestions([...(Array.isArray(payload.sceneActions) ? payload.sceneActions : []), ...(Array.isArray(payload.commandSuggestions) ? payload.commandSuggestions : [])]);
        renderNetworkSavedLists(payload);
        hideNetworkHoverCard();
        byId("networkAnswerSummary").textContent = String(payload.answerSummary || "Network updated.");
        byId("networkWeakChip").textContent = state.network.includeWeak
          ? ("Weak shown • " + Number(payload.weakHiddenCount || 0) + " hidden")
          : ("Weak hidden • " + Number(payload.weakHiddenCount || 0) + " omitted");
        byId("networkLayoutChip").textContent = state.network.layoutMode === "radial"
          ? "Hybrid"
          : state.network.layoutMode.charAt(0).toUpperCase() + state.network.layoutMode.slice(1);
        applyNetworkFocus(state.network.selectedNodeId || payload?.graph?.selectedNodeId);
        resizeVisuals();
      }

      async function runNetworkInput(inputText) {
        const text = String(inputText || "").trim();
        if (!text) return;
        appendNetworkBubble("user", text);
        const lower = text.toLowerCase();
        if (lower === "collapse all") {
          if (state.network.sceneMode === "answer_scene") {
            state.network.selectedNodeId = "";
            state.network.selectedEdgeId = "";
            await loadNetworkGraph();
            appendNetworkBubble("agent", "Reset the scene selection.");
            return;
          }
          state.network.queryText = "";
          state.network.selectedNodeId = "";
          state.network.selectedEdgeId = "";
          state.network.expandedNodeIds = [];
          state.network.collapsedNodeIds = [];
          state.network.overflowState = {};
          await loadNetworkGraph({ command: text });
          appendNetworkBubble("agent", "Collapsed the graph back to your default shells.");
          return;
        }
        if (lower.startsWith("collapse ")) {
          if (state.network.sceneMode === "answer_scene") {
            state.network.selectedNodeId = "";
            state.network.selectedEdgeId = "";
            await loadNetworkGraph();
            appendNetworkBubble("agent", "Collapsed the active scene selection.");
            return;
          }
          const target = text.slice("collapse ".length).trim().toLowerCase();
          const payloadNodes = Array.isArray(state.network.lastGraphPayload?.graph?.nodes) ? state.network.lastGraphPayload.graph.nodes : [];
          const match = payloadNodes.find((node) => String(node.displayLabel || node.label || "").toLowerCase() === target);
          if (match) {
            state.network.expandedNodeIds = state.network.expandedNodeIds.filter((id) => id !== match.id);
            state.network.collapsedNodeIds = Array.from(new Set([...state.network.collapsedNodeIds, match.id]));
            delete state.network.overflowState[match.id];
            await loadNetworkGraph();
            appendNetworkBubble("agent", "Collapsed " + (match.displayLabel || match.label) + ".");
            return;
          }
        }
        if (lower.startsWith("expand ")) {
          const target = text.slice("expand ".length).trim().toLowerCase();
          const payloadNodes = Array.isArray(state.network.lastGraphPayload?.graph?.nodes) ? state.network.lastGraphPayload.graph.nodes : [];
          const match = payloadNodes.find((node) => String(node.displayLabel || node.label || "").toLowerCase() === target);
          if (match) {
            state.network.selectedNodeId = match.id;
            state.network.selectedEdgeId = "";
            if (state.network.sceneMode === "answer_scene") {
              await loadNetworkGraph();
              appendNetworkBubble("agent", "Focused " + (match.displayLabel || match.label) + ".");
              return;
            }
            state.network.collapsedNodeIds = state.network.collapsedNodeIds.filter((id) => id !== match.id);
            if (!state.network.expandedNodeIds.includes(match.id)) state.network.expandedNodeIds.push(match.id);
            await loadNetworkGraph();
            appendNetworkBubble("agent", "Expanded " + (match.displayLabel || match.label) + ".");
            return;
          }
        }
        if (lower === "hide weak links") {
          state.network.includeWeak = false;
          await loadNetworkGraph();
          appendNetworkBubble("agent", "Weak-confidence nodes are hidden.");
          return;
        }
        if (lower === "show weak links") {
          state.network.includeWeak = true;
          await loadNetworkGraph();
          appendNetworkBubble("agent", "Weak-confidence nodes are now visible.");
          return;
        }
        if (lower === "open evidence") {
          byId("networkEvidenceList").scrollIntoView({ behavior: "smooth", block: "nearest" });
          appendNetworkBubble("agent", "Opened the evidence reader for the current selection.");
          return;
        }
        if (lower === "see related chat") {
          const payloadNodes = Array.isArray(state.network.lastGraphPayload?.graph?.nodes) ? state.network.lastGraphPayload.graph.nodes : [];
          const match = payloadNodes.find((node) => node.nodeType === "group_chat");
          if (match) {
            state.network.selectedNodeId = match.id;
            state.network.selectedEdgeId = "";
            await loadNetworkGraph();
            appendNetworkBubble("agent", "Focused the related conversation.");
            return;
          }
        }
        if (lower === "see earlier mentions" && state.network.sceneMode === "answer_scene" && state.network.sceneSeed?.question) {
          const draft = "Show the earlier mentions related to: " + state.network.sceneSeed.question;
          switchModule("ask");
          byId("askChatInput").value = draft;
          byId("globalQuestion").value = draft;
          byId("askChatNote").textContent = "Question drafted from the current graph scene. Edit it or send it to continue.";
          return;
        }
        if (state.network.sceneMode === "answer_scene") {
          appendNetworkBubble("agent", "Use Ask for a new memory question. Graph follow-up chat is planned next.");
          return;
        }
        state.network.queryText = text;
        await loadNetworkGraph({ query: text });
        appendNetworkBubble("agent", String(state.network.lastGraphPayload?.answerSummary || "Graph updated."));
      }

      async function saveNetworkState(kind) {
        const name = window.prompt(kind === "snapshot" ? "Snapshot name" : "View name");
        if (!name) return;
        if (kind === "snapshot") {
          await api("/v2/brain/search/graph/snapshot", {
            method: "POST",
            body: JSON.stringify({
              chatNamespace: state.chatNamespace,
              snapshotName: name,
              ownerActorId: "",
              graph: {
                graph: state.network.lastGraphPayload?.graph || {},
                answerSummary: state.network.lastGraphPayload?.answerSummary || "",
                detailPanel: state.network.lastGraphPayload?.detailPanel || null,
                commandSuggestions: state.network.lastGraphPayload?.commandSuggestions || [],
                weakHiddenCount: state.network.lastGraphPayload?.weakHiddenCount || 0
              }
            })
          });
        } else {
          await api("/v2/brain/search/graph/save_view", {
            method: "POST",
            body: JSON.stringify({
              chatNamespace: state.chatNamespace,
              viewName: name,
              queryText: state.network.queryText || null,
              config: {
                chatNamespace: state.chatNamespace,
                query: state.network.queryText,
                selectedNodeId: state.network.selectedNodeId,
                expandedNodeIds: state.network.expandedNodeIds,
                collapsedNodeIds: state.network.collapsedNodeIds,
                overflowState: state.network.overflowState,
                confidenceMode: state.network.includeWeak ? "include_weak" : "strong_only",
                layoutMode: state.network.layoutMode,
                autoplayTickMode: state.network.tickMode,
                startDate: state.network.startDate,
                endDate: state.network.endDate
              }
            })
          });
        }
        await loadNetworkGraph();
      }

      function clearNetworkAutoplay() {
        if (state.network.autoplayTimer) {
          clearInterval(state.network.autoplayTimer);
          state.network.autoplayTimer = null;
        }
        state.network.autoplayMaxDate = "";
      }

      function advanceNetworkDate() {
        if (!state.network.endDate) return false;
        const end = new Date(state.network.endDate + "T00:00:00");
        if (Number.isNaN(end.getTime())) return false;
        if (state.network.tickMode === "day") end.setDate(end.getDate() + 1);
        else if (state.network.tickMode === "month") end.setMonth(end.getMonth() + 1);
        else end.setDate(end.getDate() + 7);
        const max = state.network.autoplayMaxDate ? new Date(state.network.autoplayMaxDate + "T00:00:00") : null;
        if (max && end.getTime() > max.getTime()) return false;
        state.network.endDate = end.toISOString().slice(0, 10);
        byId("networkEndDate").value = state.network.endDate;
        return true;
      }

      async function toggleNetworkAutoplay() {
        if (state.network.autoplayTimer) {
          clearNetworkAutoplay();
          byId("networkPlayButton").textContent = "Auto Play";
          return;
        }
        const startValue = String(byId("networkStartDate").value || "").trim();
        const endValue = String(byId("networkEndDate").value || "").trim();
        if (startValue) state.network.startDate = startValue;
        if (endValue) state.network.endDate = endValue;
        state.network.autoplayMaxDate = state.network.endDate;
        if (state.network.startDate) {
          state.network.endDate = state.network.startDate;
          byId("networkEndDate").value = state.network.endDate;
        }
        byId("networkPlayButton").textContent = "Pause";
        state.network.autoplayTimer = setInterval(async () => {
          const ok = advanceNetworkDate();
          if (!ok) {
            clearNetworkAutoplay();
            byId("networkPlayButton").textContent = "Auto Play";
            return;
          }
          await loadNetworkGraph();
        }, 1300);
      }

      async function loadBehaviorChart() {
        const payload = await api("/v1/brain/insights?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&timeframe=" + state.timeframe);
        const chart = pickChart(payload, "behavior-trends");
        if (!state.behaviorChart) state.behaviorChart = echarts.init(byId("behaviorChart"));
        if (!chart) {
          state.behaviorChart.clear();
          return;
        }
        state.behaviorChart.setOption({
          tooltip: { trigger: "axis" },
          legend: { textStyle: { color: "#c7d7ec" }, top: 4 },
          xAxis: { type: "category", data: chart.labels, axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", axisLabel: { color: "#9eb3cb" }, name: "messages/day", nameTextStyle: { color: "#9eb3cb" } },
          grid: { left: 52, right: 20, top: 48, bottom: 36 },
          series: chart.series.map((s) => ({ name: s.name, type: "line", smooth: true, symbol: "none", data: s.data }))
        });
        resizeVisuals();
      }

      async function loadTimeline() {
        const payload = await api("/v1/brain/timeline?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&timeframe=" + encodeURIComponent(state.timeframe));
        const list = byId("timelineList");
        const rows = Array.isArray(payload.items) ? payload.items : [];
        if (rows.length === 0) {
          list.textContent = "No timeline items yet.";
          return;
        }
        list.innerHTML = rows.slice(0, 80).map((item) => {
          const chips = Array.isArray(item.domains) && item.domains.length > 0
            ? item.domains.map((d) => \`<span class="timeline-chip">\${d}</span>\`).join("")
            : \`<span class="timeline-chip">\${item.domain}</span>\`;
          return \`<div class="timeline-item"><div>\${chips}<span class="muted">\${fmtDate(item.sourceTimestamp)}</span></div><div>\${item.text}</div></div>\`;
        }).join("");
      }

      async function loadInsights() {
        const payload = await api("/v1/brain/insights?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&timeframe=" + state.timeframe);
        const feed = byId("insightFeed");
        const rows = Array.isArray(payload.insights) ? payload.insights : [];
        feed.innerHTML = rows.length === 0
          ? '<div class="muted">No insight snapshots yet.</div>'
          : rows.map((r) => {
              const action = r.action ? '<p><b>Action:</b> ' + r.action + '</p>' : '';
              return \`<div class="panel" style="margin:8px 0;"><h4>\${r.title}</h4><div class="muted">confidence: \${Math.round((r.confidence || 0) * 100)}%</div><p>\${r.summary}</p>\${action}</div>\`;
            }).join("");
      }

      async function loadOps() {
        const payload = await api("/v1/brain/jobs?limit=25");
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        const el = byId("opsJobs");
        el.innerHTML = jobs.length === 0
          ? "No jobs."
          : jobs.map((j) => \`<div style="padding:6px 0;border-bottom:1px solid #1f3b60;">\${j.jobType} - \${j.status} - queued \${j.queuedItems} - done \${j.processedItems} - failed \${j.failedItems}</div>\`).join("");
      }

      async function loadAskDebug(answerRunId) {
        if (!answerRunId) {
          byId("askDebugSummary").textContent = "No answer run id returned.";
          byId("askDebugFlow").textContent = "No debug steps yet.";
          return;
        }
        const asObject = (value) => (value && typeof value === "object" && !Array.isArray(value)) ? value : null;
        const agentName = (value, fallback = "unknown_agent") => {
          const text = typeof value === "string" ? value.trim() : "";
          return text || fallback;
        };
        const prettyJson = (value) => {
          const raw = JSON.stringify(value ?? {}, null, 2);
          if (raw.length <= 12000) return raw;
          return raw.slice(0, 12000) + "\\n... (truncated)";
        };
        const connectorRow = (fromIdx, toIdx, laneCount, columnsStyle) => {
          const cells = [];
          if (fromIdx === toIdx) {
            for (let idx = 0; idx < laneCount; idx += 1) {
              if (idx === fromIdx) {
                cells.push('<div class="ask-debug-connector-cell"><pre class="ask-debug-arrow">|\\nv</pre></div>');
              } else {
                cells.push('<div class="ask-debug-connector-cell"></div>');
              }
            }
          } else {
            const left = Math.min(fromIdx, toIdx);
            const right = Math.max(fromIdx, toIdx);
            const movingRight = toIdx > fromIdx;
            for (let idx = 0; idx < laneCount; idx += 1) {
              let token = "";
              if (idx >= left && idx <= right) {
                if (movingRight) {
                  if (idx === left) token = "|---";
                  else if (idx === right) token = "--->";
                  else token = "----";
                } else {
                  if (idx === left) token = "<---";
                  else if (idx === right) token = "---|";
                  else token = "----";
                }
              }
              cells.push('<div class="ask-debug-connector-cell">' + (token ? '<pre class="ask-debug-arrow">' + escapeHtml(token) + '</pre>' : '') + '</div>');
            }
          }
          return '<div class="ask-debug-row" style="grid-template-columns:' + columnsStyle + ';">' + cells.join("") + '</div>';
        };
        const payload = await api("/v2/brain/ask/run/" + encodeURIComponent(answerRunId), { method: "GET" });
        const run = payload.run || {};
        const steps = Array.isArray(payload.steps) ? payload.steps : [];
        const events = [];
        for (const step of steps) {
          const envelope = asObject(step.envelope) || {};
          const request = asObject(envelope.request);
          const response = asObject(envelope.response);
          let emitted = false;
          if (request) {
            events.push({
              stepIndex: step.step_index,
              kind: "request",
              from: agentName(request.fromAgent, agentName(step.agent_name)),
              to: agentName(request.toAgent, agentName(step.agent_name)),
              status: agentName(step.status, "ok"),
              createdAt: (typeof request.createdAt === "string" && request.createdAt.trim()) ? request.createdAt : step.created_at,
              label: (typeof request.intent === "string" && request.intent.trim()) ? request.intent : "request",
              payload: request
            });
            emitted = true;
          }
          if (response) {
            events.push({
              stepIndex: step.step_index,
              kind: "response",
              from: agentName(response.fromAgent, agentName(step.agent_name)),
              to: agentName(response.toAgent, agentName(step.agent_name)),
              status: agentName(response.status, agentName(step.status, "ok")),
              createdAt: (typeof response.createdAt === "string" && response.createdAt.trim()) ? response.createdAt : step.created_at,
              label: (typeof response.decision === "string" && response.decision.trim())
                ? response.decision
                : ((typeof response.messageType === "string" && response.messageType.trim()) ? response.messageType : "response"),
              payload: response
            });
            emitted = true;
          }
          if (!emitted) {
            const from = agentName(envelope.fromAgent, agentName(step.agent_name));
            const to = agentName(envelope.toAgent, from);
            const label = (typeof envelope.intent === "string" && envelope.intent.trim())
              ? envelope.intent
              : agentName(step.message_type, "internal");
            events.push({
              stepIndex: step.step_index,
              kind: "internal",
              from,
              to,
              status: agentName(step.status, "ok"),
              createdAt: step.created_at,
              label,
              payload: envelope
            });
          }
        }
        const lanes = [];
        const seen = new Set();
        for (const event of events) {
          for (const laneCandidate of [event.from, event.to]) {
            const lane = agentName(laneCandidate);
            if (!seen.has(lane)) {
              lanes.push(lane);
              seen.add(lane);
            }
          }
        }
        if (lanes.length === 0) lanes.push("controller_agent");
        const laneIndex = new Map();
        lanes.forEach((lane, idx) => laneIndex.set(lane, idx));
        const columnsStyle = 'repeat(' + lanes.length + ', minmax(220px, 1fr))';
        byId("askDebugSummary").innerHTML =
          \`Run <b>\${escapeHtml(run.id || answerRunId)}</b> | status <b>\${escapeHtml(run.status || "n/a")}</b> | decision <b>\${escapeHtml(run.decision || "n/a")}</b> | started \${escapeHtml(fmtDate(run.created_at))} | lanes <b>\${lanes.length}</b> | events <b>\${events.length}</b>\`;
        byId("askDebugFlow").innerHTML = events.length === 0
          ? "No debug steps recorded."
          : (() => {
              const rows = [];
              rows.push(
                '<div class="ask-debug-lane-row" style="grid-template-columns:' + columnsStyle + ';">' +
                lanes.map((lane) => '<div class="ask-debug-lane">' + escapeHtml(lane) + '</div>').join("") +
                '</div>'
              );
              for (let idx = 0; idx < events.length; idx += 1) {
                const event = events[idx];
                const fromIdx = laneIndex.get(event.from) ?? 0;
                const toIdx = laneIndex.get(event.to) ?? fromIdx;
                const eventCells = lanes.map((_, laneIdx) => {
                  if (laneIdx !== fromIdx) return '<div class="ask-debug-cell"></div>';
                  const meta = '#' + event.stepIndex +
                    ' | ' + event.kind +
                    ' | ' + fmtDate(event.createdAt) +
                    ' | ' + event.from + (event.to !== event.from ? ' -> ' + event.to : '') +
                    ' | ' + event.status;
                  const body = escapeHtml(prettyJson(event.payload));
                  return '<div class="ask-debug-cell"><div class="ask-debug-bubble ' + escapeHtml(event.kind) + '"><div class="ask-debug-meta">' + escapeHtml(meta) + '</div><div><b>' + escapeHtml(event.label) + '</b></div><details><summary>Envelope</summary><pre>' + body + '</pre></details></div></div>';
                }).join("");
                rows.push('<div class="ask-debug-row" style="grid-template-columns:' + columnsStyle + ';">' + eventCells + '</div>');
                if (fromIdx !== toIdx) {
                  rows.push(connectorRow(fromIdx, toIdx, lanes.length, columnsStyle));
                }
                if (idx < events.length - 1) {
                  const nextFrom = laneIndex.get(events[idx + 1].from) ?? 0;
                  rows.push(connectorRow(toIdx, nextFrom, lanes.length, columnsStyle));
                }
              }
              return '<div class="ask-debug-swim">' + rows.join("") + '</div>';
            })();
      }

      function appendChatBubble(role, text) {
        const thread = byId("askChatThread");
        const bubble = document.createElement("div");
        bubble.className = "ask-chat-bubble " + (role === "user" ? "user" : "agent");
        bubble.textContent = String(text ?? "");
        thread.appendChild(bubble);
        thread.scrollTop = thread.scrollHeight;
      }

      function renderAskGraphSuggestion(payload) {
        const wrap = byId("askGraphSuggestion");
        const text = byId("askGraphSuggestionText");
        const button = byId("askShowGraphButton");
        const graphable = Boolean(payload && payload.graphable && payload.sceneSeed);
        if (!graphable) {
          wrap.classList.add("hidden");
          text.textContent = "";
          return;
        }
        const suggestion = payload.graphSuggestion && typeof payload.graphSuggestion === "object"
          ? payload.graphSuggestion
          : null;
        text.textContent = String(suggestion?.prompt || "See this answer in graph mode.");
        button.textContent = String(suggestion?.ctaLabel || "Show graph");
        wrap.classList.remove("hidden");
      }

      async function openAskSceneInNetwork() {
        if (!state.lastAskSceneSeed) return;
        state.network.sceneMode = "answer_scene";
        state.network.sceneSeed = state.lastAskSceneSeed;
        state.network.queryText = "";
        state.network.selectedNodeId = "";
        state.network.selectedEdgeId = "";
        state.network.expandedNodeIds = [];
        state.network.collapsedNodeIds = [];
        state.network.overflowState = {};
        switchModule("network");
      }

      function renderAskAnswerContract(answerPayload) {
        if (!answerPayload || typeof answerPayload !== "object") {
          byId("askAnswer").textContent = "No answer contract returned.";
          return;
        }
        const decision = String(answerPayload.decision || "");
        const status = String(answerPayload.status || "insufficient");
        const finalAnswer = answerPayload.finalAnswer && typeof answerPayload.finalAnswer === "object"
          ? answerPayload.finalAnswer
          : null;
        const blocks = [];
        if (decision === "clarify_first") {
          blocks.push(String(answerPayload.clarificationQuestion || "Please clarify the scope so I can answer accurately."));
        } else if (finalAnswer) {
          blocks.push(String(finalAnswer.direct || finalAnswer.estimate || "No grounded answer yet."));
          if (status === "partial" || status === "estimated") {
            blocks.push("Confidence: " + String(finalAnswer.confidence || "low"));
          }
          if (finalAnswer.contradictionCallout) blocks.push(String(finalAnswer.contradictionCallout));
          if (finalAnswer.estimate && finalAnswer.estimate !== finalAnswer.direct) {
            blocks.push("Evidence summary: " + String(finalAnswer.estimate));
          }
        } else if (status === "insufficient") {
          blocks.push("I do not have enough grounded evidence to answer that confidently yet.");
        }
        byId("askAnswer").textContent = blocks.join("\\n\\n");
      }

      async function ask(question, clarificationResponse = null) {
        setAskLoading(true);
        try {
          const body = {
            question,
            clarificationResponse: clarificationResponse || undefined,
            timeframe: state.timeframe,
            chatNamespace: state.chatNamespace,
            maxLoops: 3
          };
          const payload = await api("/v2/brain/ask", {
            method: "POST",
            body: JSON.stringify(body)
          });

          const answerPayload =
            payload && payload.answerContract && typeof payload.answerContract === "object"
              ? payload.answerContract
              : payload.answer;
          renderAskAnswerContract(answerPayload);
          state.lastAskSceneSeed = payload?.sceneSeed || null;
          state.lastAskGraphSuggestion = payload?.graphSuggestion || null;
          renderAskGraphSuggestion(payload);

          const refs = Array.isArray(payload.evidenceRefs)
            ? payload.evidenceRefs
            : (Array.isArray(payload.evidence) ? payload.evidence : []);
          byId("askEvidence").innerHTML = refs.length === 0
            ? "No evidence."
            : refs.map((r) => {
              const pct = Math.round((r.similarity || 0) * 100);
              const evidenceRole =
                (typeof r.contextRole === "string" && r.contextRole.trim()) ||
                "uncertain";
              const entity =
                (typeof r.entityLabel === "string" && r.entityLabel.trim()) ||
                (typeof r.sourceSystem === "string" && r.sourceSystem.trim()) ||
                "unknown";
              const ts =
                (typeof r.sourceTimestamp === "string" && r.sourceTimestamp.trim())
                  ? fmtDate(r.sourceTimestamp)
                  : "n/a";
              const convId =
                (typeof r.sourceConversationId === "string" && r.sourceConversationId.trim())
                  ? r.sourceConversationId
                  : "n/a";
              const msgId =
                (typeof r.sourceMessageId === "string" && r.sourceMessageId.trim())
                  ? r.sourceMessageId
                  : "n/a";
              const excerpt = typeof r.excerpt === "string" ? r.excerpt : "";
              return \`<div style="padding:6px 0;border-bottom:1px dashed #1f3b60;">\` +
                \`[\${pct}%] <span class="muted">\${escapeHtml(String(evidenceRole))} | \${escapeHtml(String(entity))} | \${escapeHtml(String(ts))}</span>\` +
                \`<br/><span class="muted">conv=\${escapeHtml(String(convId))} | msg=\${escapeHtml(String(msgId))}</span>\` +
                \`<br/>\${escapeHtml(excerpt)}</div>\`;
            }).join("");

          if (answerPayload && typeof answerPayload === "object" && String(answerPayload.decision || "") === "clarify_first") {
            state.awaitingClarification = true;
            const q = String(answerPayload.clarificationQuestion || "Can you clarify the scope?");
            appendChatBubble("agent", q);
            byId("askChatNote").textContent = "Clarification required. Reply in chat to continue.";
          } else {
            state.awaitingClarification = false;
            const finalText = (answerPayload && typeof answerPayload === "object" && answerPayload.finalAnswer)
              ? (String(answerPayload.finalAnswer.direct || answerPayload.finalAnswer.estimate || "Answered in workspace."))
              : "Answered in workspace.";
            appendChatBubble("agent", finalText);
            byId("askChatNote").textContent = "Ask here. If clarification is needed, answer the follow-up to continue.";
            state.pendingQuestion = "";
          }

          state.lastAnswerRunId = String(payload.answerRunId || "");
          await loadAskDebug(state.lastAnswerRunId);
          switchModule("ask");
        } catch (error) {
          state.lastAskSceneSeed = null;
          state.lastAskGraphSuggestion = null;
          renderAskGraphSuggestion(null);
          byId("askAnswer").textContent = "Ask failed: " + (error.message || String(error));
          byId("askEvidence").textContent = "No evidence.";
        } finally {
          setAskLoading(false);
        }
      }

      function setEvolutionTab(tabName) {
        const allowed = ["overview", "ontology", "preloop", "runcontrol"].includes(tabName) ? tabName : "overview";
        state.evolutionTab = allowed;
        byId("evoPanelOverview").classList.toggle("hidden", allowed !== "overview");
        byId("evoPanelOntology").classList.toggle("hidden", allowed !== "ontology");
        byId("evoPanelPreloop").classList.toggle("hidden", allowed !== "preloop");
        byId("evoPanelRunControl").classList.toggle("hidden", allowed !== "runcontrol");
        byId("evoTabOverview").classList.toggle("active", allowed === "overview");
        byId("evoTabOntology").classList.toggle("active", allowed === "ontology");
        byId("evoTabPreloop").classList.toggle("active", allowed === "preloop");
        byId("evoTabRunControl").classList.toggle("active", allowed === "runcontrol");
      }

      function experimentOptionLabel(item) {
        const rate = item.latestPassRate == null ? "no score yet" : (Number(item.latestPassRate || 0) * 100).toFixed(1) + "%";
        return String(item.name || item.id) + " - " + String(item.status || "n/a") + " - " + fmtDate(item.createdAt) + " - " + rate;
      }

      function renderEvolutionExperimentPicker() {
        const select = byId("evoExperimentSelect");
        const list = Array.isArray(state.evolution.experiments) ? state.evolution.experiments : [];
        select.innerHTML = list.length === 0
          ? '<option value="">No experiments</option>'
          : list.map((item) => '<option value="' + escapeHtml(String(item.id)) + '">' + escapeHtml(experimentOptionLabel(item)) + '</option>').join("");
        if (state.evolution.experimentId) {
          select.value = state.evolution.experimentId;
        } else if (list[0]) {
          state.evolution.experimentId = String(list[0].id || "");
          select.value = state.evolution.experimentId;
        }
        const active = list.find((item) => String(item.id) === String(state.evolution.experimentId));
        byId("evoExperimentMeta").textContent = active
          ? ("UUID " + String(active.id) + " | lock " + String(active.activeLockVersion || "none")
            + " | queue " + Number(active.queueCounts?.queued || 0)
            + " | pending calibration " + Number(active.queueCounts?.pendingCalibration || 0))
          : "No experiment loaded.";
      }

      async function loadEvolutionExperimentList(forceLatest = false) {
        const q = String(byId("evoExperimentSearch").value || "").trim();
        const payload = await api("/v2/experiments/list?limit=50" + (q ? "&q=" + encodeURIComponent(q) : ""), { method: "GET" });
        state.evolution.experiments = Array.isArray(payload?.experiments) ? payload.experiments : [];
        if (forceLatest || !state.evolution.experimentId) {
          state.evolution.experimentId = String(state.evolution.experiments?.[0]?.id || "");
        } else if (!state.evolution.experiments.some((item) => String(item.id) === String(state.evolution.experimentId))) {
          state.evolution.experimentId = String(state.evolution.experiments?.[0]?.id || "");
        }
        renderEvolutionExperimentPicker();
      }

      async function ensureEvolutionExperimentId(forceLatest = false) {
        if (forceLatest || !state.evolution.experimentId) {
          await loadEvolutionExperimentList(forceLatest);
        }
        return String(state.evolution.experimentId || "");
      }

      function currentExperimentRecord() {
        return (state.evolution.experiments || []).find((item) => String(item.id) === String(state.evolution.experimentId)) || null;
      }

      function renderOntologyVersionPicker() {
        const select = byId("ontologyVersionSelect");
        const versions = Array.isArray(state.evolution.ontologyVersions) ? state.evolution.ontologyVersions : [];
        select.innerHTML = versions.length === 0
          ? '<option value="">No taxonomy versions</option>'
          : versions.map((item) => {
            const coverage = Number(item.totalPairs || 0) > 0
              ? ((Number(item.supportedPairs || 0) / Number(item.totalPairs || 1)) * 100).toFixed(1) + "%"
              : "not scanned";
            return '<option value="' + escapeHtml(String(item.id)) + '">'
              + escapeHtml(String(item.name || item.versionKey || item.id) + " - " + String(item.status || "n/a") + " - " + coverage)
              + '</option>';
          }).join("");
        if (state.evolution.ontologyVersionId) {
          select.value = state.evolution.ontologyVersionId;
        } else if (versions[0]) {
          state.evolution.ontologyVersionId = String(versions[0].id || "");
          select.value = state.evolution.ontologyVersionId;
        }
      }

      function filterOntologyCandidates() {
        const typeFilter = String(byId("ontologyCandidateTypeFilter").value || "");
        const statusFilter = String(byId("ontologyCandidateStatusFilter").value || "");
        const query = String(byId("ontologyCandidateSearch").value || "").trim().toLowerCase();
        const candidates = Array.isArray(state.evolution.ontologyCandidates) ? state.evolution.ontologyCandidates : [];
        state.evolution.ontologyFilteredCandidates = candidates.filter((item) => {
          if (typeFilter && String(item.candidateType || "") !== typeFilter) return false;
          if (statusFilter && String(item.status || "") !== statusFilter) return false;
          if (query) {
            const hay = [
              item.title,
              item.rationale,
              item.sourceDomainKey,
              item.sourceLensKey,
              item.proposedKey
            ].map((x) => String(x || "")).join(" ").toLowerCase();
            if (!hay.includes(query)) return false;
          }
          return true;
        });
      }

      function renderOntologySupportSummary() {
        const detail = state.evolution.ontologyDetail || {};
        const summary = detail.supportSummary || {};
        const freshness = state.evolution.ontologyFreshness || {};
        const cards = [
          ["Version", String(detail?.version?.versionKey || detail?.version?.name || "n/a")],
          ["Supported pairs", String(summary.supportedPairs ?? 0)],
          ["Unsupported pairs", String(summary.unsupportedPairs ?? 0)],
          ["Coverage", summary.supportCoverageRatio == null ? "n/a" : ((Number(summary.supportCoverageRatio || 0) * 100).toFixed(1) + "%")],
          ["Candidate backlog", String((state.evolution.ontologyCandidates || []).filter((item) => item.status === "pending").length)],
          ["Benchmark stale", freshness.benchmarkStale ? "yes" : "no"]
        ];
        byId("ontologySupportSummary").innerHTML = cards.map(([label, value]) => (
          '<div class="ontology-stat"><div class="muted">' + escapeHtml(label) + '</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(value) + '</div></div>'
        )).join("");
      }

      function renderOntologySupportMatrix() {
        const rows = Array.isArray(state.evolution.ontologySupportMatrix) ? state.evolution.ontologySupportMatrix : [];
        const host = byId("ontologySupportMatrix");
        const previousScroll = host.querySelector(".ontology-matrix-scroll")?.scrollTop ?? Number(state.evolution.ontologyMatrixScrollTop || 0);
        if (rows.length === 0) {
          host.innerHTML = '<div class="muted">No support matrix loaded yet.</div>';
          byId("ontologyMatrixPageMeta").textContent = "Page 0 of 0";
          byId("ontologyMatrixPrevButton").disabled = true;
          byId("ontologyMatrixNextButton").disabled = true;
          return;
        }
        const grouped = new Map();
        for (const row of rows) {
          const domainKey = String(row?.domainKey || "unknown");
          if (!grouped.has(domainKey)) grouped.set(domainKey, []);
          grouped.get(domainKey).push(row);
        }
        const orderedGroups = Array.from(grouped.entries()).map(([domainKey, items]) => {
          const maxEvidence = Math.max(...items.map((item) => Number(item?.evidenceCount || 0)), 0);
          const totalEvidence = items.reduce((sum, item) => sum + Number(item?.evidenceCount || 0), 0);
          const totalSupported = items.reduce((sum, item) => sum + Number(item?.supportCount || 0), 0);
          const sortedItems = items.slice().sort((a, b) => {
            const evidenceDiff = Number(b?.evidenceCount || 0) - Number(a?.evidenceCount || 0);
            if (evidenceDiff !== 0) return evidenceDiff;
            const supportDiff = Number(b?.supportCount || 0) - Number(a?.supportCount || 0);
            if (supportDiff !== 0) return supportDiff;
            return String(a?.lensKey || "").localeCompare(String(b?.lensKey || ""));
          });
          return { domainKey, items: sortedItems, maxEvidence, totalEvidence, totalSupported };
        }).sort((a, b) => {
          const maxDiff = b.maxEvidence - a.maxEvidence;
          if (maxDiff !== 0) return maxDiff;
          const totalDiff = b.totalEvidence - a.totalEvidence;
          if (totalDiff !== 0) return totalDiff;
          const supportedDiff = b.totalSupported - a.totalSupported;
          if (supportedDiff !== 0) return supportedDiff;
          return a.domainKey.localeCompare(b.domainKey);
        });
        const groupsPerPage = 4;
        const totalPages = Math.max(1, Math.ceil(orderedGroups.length / groupsPerPage));
        state.evolution.ontologyMatrixPage = Math.min(Math.max(0, Number(state.evolution.ontologyMatrixPage || 0)), totalPages - 1);
        const startIndex = state.evolution.ontologyMatrixPage * groupsPerPage;
        const limitedGroups = orderedGroups.slice(startIndex, startIndex + groupsPerPage);
        const renderedCount = limitedGroups.reduce((sum, group) => sum + group.items.length, 0);
        const humanize = (value) => String(value || "").replaceAll("_", " ");
        host.innerHTML =
          '<div class="ontology-matrix-scroll"><div class="ontology-matrix-list">'
          + limitedGroups.map((group) => (
            '<div class="ontology-matrix-group">'
            + '<div class="ontology-matrix-group-title">'
            + '<span>' + escapeHtml(humanize(group.domainKey)) + '</span>'
            + '<span>max evidence ' + escapeHtml(String(group.maxEvidence)) + ' | total evidence ' + escapeHtml(String(group.totalEvidence)) + '</span>'
            + '</div>'
            + '<div class="ontology-matrix-group-grid">'
            + group.items.map((row) => {
              const status = String(row.supportStatus || "unknown");
              return '<div class="ontology-matrix-item">'
                + '<div class="ontology-matrix-head">'
                + '<div class="ontology-matrix-title">' + escapeHtml(humanize(row.lensKey)) + '</div>'
                + '<span class="ontology-status-badge ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>'
                + '</div>'
                + '<div class="ontology-matrix-stats">'
                + '<div class="ontology-matrix-stat"><div class="muted">Evidence rows</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(String(row.evidenceCount || 0)) + '</div></div>'
                + '<div class="ontology-matrix-stat"><div class="muted">Supported clusters</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(String(row.supportCount || 0)) + '</div></div>'
                + '</div>'
                + '<div class="ontology-matrix-rationale">' + escapeHtml(String(row.rationale || "No rationale recorded.")) + '</div>'
                + '</div>';
            }).join("")
            + '</div>'
            + '</div>'
          )).join("")
          + '</div></div>'
          + '<div class="muted" style="margin-top:8px;">Showing domains ' + (startIndex + 1) + ' to ' + (startIndex + limitedGroups.length) + ' of ' + orderedGroups.length + ' | support rows ' + renderedCount + ' on this page.</div>';
        byId("ontologyMatrixPageMeta").textContent = "Page " + (state.evolution.ontologyMatrixPage + 1) + " of " + totalPages;
        byId("ontologyMatrixPrevButton").disabled = state.evolution.ontologyMatrixPage <= 0;
        byId("ontologyMatrixNextButton").disabled = state.evolution.ontologyMatrixPage >= totalPages - 1;
        const scrollEl = host.querySelector(".ontology-matrix-scroll");
        if (scrollEl) {
          scrollEl.scrollTop = previousScroll;
          scrollEl.addEventListener("scroll", () => {
            state.evolution.ontologyMatrixScrollTop = scrollEl.scrollTop;
          }, { passive: true });
        }
      }

      function renderOntologyCandidates() {
        filterOntologyCandidates();
        const rows = Array.isArray(state.evolution.ontologyFilteredCandidates) ? state.evolution.ontologyFilteredCandidates : [];
        if (rows.length === 0) {
          byId("ontologyCandidateList").innerHTML = '<div class="muted">No ontology candidates in this filter.</div>';
          return;
        }
        byId("ontologyCandidateList").innerHTML = rows.map((item) => {
          const counts = Number(item.evidenceIds?.length || 0) + " evidence | " + Number(item.conversationIds?.length || 0) + " conv";
          const payloadTarget = String(item.payload?.targetKey || "");
          return '<div class="ontology-item" data-candidate-id="' + escapeHtml(String(item.id)) + '">'
            + '<div style="display:flex; justify-content:space-between; gap:8px;"><strong>' + escapeHtml(String(item.title || "")) + '</strong><span class="muted">' + escapeHtml(String(item.status || "")) + '</span></div>'
            + '<div class="muted" style="margin-top:4px;">' + escapeHtml(String(item.candidateType || "")) + ' | confidence ' + Number(item.recommendationConfidence || 0).toFixed(2) + '</div>'
            + '<div style="margin-top:6px;">' + escapeHtml(String(item.rationale || "")) + '</div>'
            + '<div class="ontology-pill-row">'
            + (item.sourceDomainKey ? '<span class="ontology-pill">domain ' + escapeHtml(String(item.sourceDomainKey)) + '</span>' : '')
            + (item.sourceLensKey ? '<span class="ontology-pill">lens ' + escapeHtml(String(item.sourceLensKey)) + '</span>' : '')
            + (item.proposedKey ? '<span class="ontology-pill">proposed ' + escapeHtml(String(item.proposedKey)) + '</span>' : '')
            + (payloadTarget ? '<span class="ontology-pill">target ' + escapeHtml(payloadTarget) + '</span>' : '')
            + '<span class="ontology-pill">' + escapeHtml(counts) + '</span>'
            + '</div>'
            + '<div class="runctl-actions" style="margin-top:8px;">'
            + '<button type="button" data-action="approved" data-candidate-id="' + escapeHtml(String(item.id)) + '">Approve</button>'
            + '<button type="button" data-action="deferred" data-candidate-id="' + escapeHtml(String(item.id)) + '">Defer</button>'
            + '<button type="button" data-action="rejected" data-candidate-id="' + escapeHtml(String(item.id)) + '">Reject</button>'
            + '</div>'
            + '</div>';
        }).join("");
        byId("ontologyCandidateList").querySelectorAll("button[data-candidate-id]").forEach((btn) => {
          btn.addEventListener("click", async (event) => {
            const action = String(event.currentTarget.dataset.action || "approved");
            const candidateId = String(event.currentTarget.dataset.candidateId || "");
            const targetKey = action === "approved"
              ? (window.prompt("Optional target key for merge-into / split-from actions:", "") || "").trim()
              : "";
            await api("/v2/taxonomy/candidates/" + encodeURIComponent(candidateId) + "/review", {
              method: "POST",
              body: JSON.stringify({
                decision: action,
                targetKey: targetKey || undefined
              })
            });
            await loadOntologyReview();
          });
        });
      }

      function renderOntologyDraftSummary() {
        const detail = state.evolution.ontologyDetail || {};
        const draft = detail.draftSummary || {};
        const renderList = (items, emptyLabel) => {
          const list = Array.isArray(items) ? items : [];
          if (list.length === 0) {
            return '<div class="ontology-empty">' + escapeHtml(emptyLabel) + '</div>';
          }
          return '<div class="ontology-list-block">' + list.map((item) => {
            if (typeof item === "string") {
              return '<div class="ontology-list-item">' + escapeHtml(item) + '</div>';
            }
            return '<div class="ontology-list-item"><pre style="margin:0; white-space:pre-wrap;">'
              + escapeHtml(JSON.stringify(item, null, 2))
              + '</pre></div>';
          }).join("") + '</div>';
        };
        const approvedAdds = draft.approvedAdds || {};
        const approvedAddList = [
          ...(Array.isArray(approvedAdds.domains) ? approvedAdds.domains.map((item) => "domain: " + item) : []),
          ...(Array.isArray(approvedAdds.lenses) ? approvedAdds.lenses.map((item) => "lens: " + item) : [])
        ];
        const approvedRemovals = draft.approvedRemovals || {};
        const approvedRemovalList = [
          ...(Array.isArray(approvedRemovals.domains) ? approvedRemovals.domains.map((item) => "domain: " + item) : []),
          ...(Array.isArray(approvedRemovals.lenses) ? approvedRemovals.lenses.map((item) => "lens: " + item) : [])
        ];
        byId("ontologyDraftSummary").innerHTML =
          '<div class="ontology-stat-grid">'
          + '<div class="ontology-stat"><div class="muted">Base domains</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(String(draft.baseDomainCount ?? 0)) + '</div></div>'
          + '<div class="ontology-stat"><div class="muted">Base lenses</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(String(draft.baseLensCount ?? 0)) + '</div></div>'
          + '</div>'
          + '<div style="margin-top:10px;"><strong>Approved adds</strong>' + renderList(approvedAddList, "No approved additions.") + '</div>'
          + '<div style="margin-top:10px;"><strong>Approved removals</strong>' + renderList(approvedRemovalList, "No approved removals.") + '</div>'
          + '<div style="margin-top:10px;"><strong>Approved splits</strong>' + renderList(draft.approvedSplits || [], "No approved splits.") + '</div>'
          + '<div style="margin-top:10px;"><strong>Approved merges</strong>' + renderList(draft.approvedMerges || [], "No approved merges.") + '</div>';
      }

      function renderOntologyFreshness() {
        const freshness = state.evolution.ontologyFreshness || {};
        byId("ontologyFreshness").innerHTML =
          '<div class="muted">Experiment taxonomy: ' + escapeHtml(String(freshness.taxonomyVersionKey || "n/a")) + '</div>'
          + '<div class="muted" style="margin-top:6px;">Latest published: ' + escapeHtml(String(freshness.latestPublishedVersionKey || "n/a")) + '</div>'
          + '<div class="muted" style="margin-top:6px;">Benchmark generated: ' + escapeHtml(String(freshness.benchmarkGeneratedAt || "n/a")) + '</div>'
          + '<div class="muted" style="margin-top:6px;">Latest scan: ' + escapeHtml(String(freshness.latestScanCompletedAt || "n/a")) + '</div>'
          + '<div style="margin-top:8px;font-weight:700;">Stale: ' + escapeHtml(freshness.benchmarkStale ? "yes" : "no") + '</div>'
          + '<div style="margin-top:8px;">' + escapeHtml((freshness.reasons || []).join(" | ") || "No freshness issues.") + '</div>';
      }

      function renderOntologyFacetCoverage() {
        const summary = state.evolution.ontologyFacetSummary || {};
        const rows = Array.isArray(state.evolution.ontologyFacetCoverage) ? state.evolution.ontologyFacetCoverage : [];
        const summaryCards = [
          ["Facet rows", String(summary.totalRows ?? 0)],
          ["Covered", String(summary.coveredRows ?? 0)],
          ["Gaps", String(summary.gapRows ?? 0)],
          ["Sparse", String(summary.sparseRows ?? 0)]
        ];
        byId("ontologyFacetSummary").innerHTML = summaryCards.map(([label, value]) => (
          '<div class="ontology-stat"><div class="muted">' + escapeHtml(label) + '</div><div style="margin-top:4px;font-weight:700;">' + escapeHtml(value) + '</div></div>'
        )).join("");
        if (rows.length === 0) {
          byId("ontologyFacetCoverage").innerHTML = '<div class="muted">No facet coverage rows for this filter.</div>';
          return;
        }
        byId("ontologyFacetCoverage").innerHTML =
          '<div class="ontology-list-block">'
          + rows.map((row) => (
            '<div class="ontology-item">'
            + '<div style="display:flex; justify-content:space-between; gap:8px;"><strong>'
            + escapeHtml(String(row.facetLabel || row.facetKey || "unknown"))
            + '</strong><span class="ontology-status-badge ' + escapeHtml(String(row.coverageStatus || "sparse")) + '">'
            + escapeHtml(String(row.coverageStatus || "sparse"))
            + '</span></div>'
            + '<div class="muted" style="margin-top:4px;">' + escapeHtml(String(row.facetType || "")) + '</div>'
            + '<div class="ontology-pill-row">'
            + '<span class="ontology-pill">' + escapeHtml(String(row.evidenceCount || 0)) + ' evidence</span>'
            + '<span class="ontology-pill">' + escapeHtml(String(row.conversationCount || 0)) + ' conversations</span>'
            + '<span class="ontology-pill">' + escapeHtml(String(row.benchmarkCaseCount || 0)) + ' benchmark cases</span>'
            + '</div>'
            + '<div style="margin-top:6px;">' + escapeHtml(String(row.rationale || "")) + '</div>'
            + '</div>'
          )).join("")
          + '</div>';
      }

      async function loadOntologyReview(forceLatestVersion = false) {
        const experimentId = await ensureEvolutionExperimentId(false);
        const versionsPayload = await api("/v2/taxonomy/versions", { method: "GET" });
        state.evolution.ontologyVersions = Array.isArray(versionsPayload?.versions) ? versionsPayload.versions : [];
        const experiment = currentExperimentRecord();
        if (forceLatestVersion || !state.evolution.ontologyVersionId) {
          state.evolution.ontologyVersionId = String(experiment?.taxonomyVersionId || state.evolution.ontologyVersions?.[0]?.id || "");
        }
        if (!state.evolution.ontologyVersions.some((item) => String(item.id) === String(state.evolution.ontologyVersionId))) {
          state.evolution.ontologyVersionId = String(state.evolution.ontologyVersions?.[0]?.id || "");
        }
        renderOntologyVersionPicker();
        const versionId = String(state.evolution.ontologyVersionId || "");
        if (!versionId) {
          state.evolution.ontologyDetail = null;
          state.evolution.ontologySupportMatrix = [];
          state.evolution.ontologyFacetCoverage = [];
          state.evolution.ontologyFacetSummary = null;
          state.evolution.ontologyCandidates = [];
          state.evolution.ontologyFreshness = null;
          renderOntologySupportSummary();
          renderOntologySupportMatrix();
          renderOntologyFacetCoverage();
          renderOntologyCandidates();
          renderOntologyDraftSummary();
          renderOntologyFreshness();
          return;
        }
        const facetType = String(byId("ontologyFacetTypeFilter")?.value || "");
        const facetStatus = String(byId("ontologyFacetStatusFilter")?.value || "");
        const facetPage = Math.max(1, Number(state.evolution.ontologyFacetPage || 1));
        const facetQuery = new URLSearchParams();
        if (facetType) facetQuery.set("facetType", facetType);
        if (facetStatus) facetQuery.set("coverageStatus", facetStatus);
        facetQuery.set("page", String(facetPage));
        facetQuery.set("pageSize", "18");
        const [detailPayload, supportPayload, candidatesPayload, freshnessPayload, facetPayload] = await Promise.all([
          api("/v2/taxonomy/versions/" + encodeURIComponent(versionId), { method: "GET" }),
          api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/support_matrix", { method: "GET" }),
          api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/candidates", { method: "GET" }),
          experimentId
            ? api("/v2/experiments/" + encodeURIComponent(experimentId) + "/benchmark_freshness", { method: "GET" })
            : Promise.resolve({}),
          api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/facet_coverage?" + facetQuery.toString(), { method: "GET" })
        ]);
        state.evolution.ontologyDetail = detailPayload || null;
        state.evolution.ontologySupportMatrix = Array.isArray(supportPayload?.matrix) ? supportPayload.matrix : [];
        state.evolution.ontologyCandidates = Array.isArray(candidatesPayload?.candidates) ? candidatesPayload.candidates : [];
        state.evolution.ontologyFreshness = freshnessPayload || null;
        state.evolution.ontologyFacetCoverage = Array.isArray(facetPayload?.rows) ? facetPayload.rows : [];
        state.evolution.ontologyFacetSummary = facetPayload?.summary || null;
        state.evolution.ontologyFacetPage = Math.max(1, Number(facetPayload?.page || facetPage));
        renderOntologySupportSummary();
        renderOntologySupportMatrix();
        renderOntologyCandidates();
        renderOntologyDraftSummary();
        renderOntologyFreshness();
        renderOntologyFacetCoverage();
        const totalFacetPages = Math.max(1, Number(facetPayload?.totalPages || 1));
        byId("ontologyFacetPageMeta").textContent = "Page " + state.evolution.ontologyFacetPage + " of " + totalFacetPages;
        byId("ontologyFacetPrevButton").disabled = state.evolution.ontologyFacetPage <= 1;
        byId("ontologyFacetNextButton").disabled = state.evolution.ontologyFacetPage >= totalFacetPages;
      }

      function setOntologyActionMsg(message) {
        byId("ontologyActionMsg").textContent = String(message || "");
      }

      async function reviewOntologyCandidatesBatch(candidateIds, decision, targetKey = "") {
        for (const candidateId of candidateIds) {
          await api("/v2/taxonomy/candidates/" + encodeURIComponent(String(candidateId)) + "/review", {
            method: "POST",
            body: JSON.stringify({
              decision,
              targetKey: targetKey || undefined
            })
          });
        }
      }

      async function rebuildOntologyCalibrationQueue() {
        const experimentId = await ensureEvolutionExperimentId(false);
        if (!experimentId) {
          setOntologyActionMsg("No experiment selected.");
          return;
        }
        const count = Math.max(1, Math.min(200, Number(byId("preloopSampleCount").value || "20")));
        const caseSet = String(byId("preloopCaseSetFilter").value || "").trim();
        const domain = String(byId("preloopDomainFilter").value || "").trim();
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/sample", {
          method: "POST",
          body: JSON.stringify({
            count,
            caseSet: caseSet || undefined,
            domain: domain || undefined
          })
        });
        setOntologyActionMsg("Calibration queue rebuilt.");
        await loadPreloopQueueAndReadiness();
      }

      async function exportOntologyReview() {
        const payload = {
          version: state.evolution.ontologyDetail?.version || null,
          supportSummary: state.evolution.ontologyDetail?.supportSummary || null,
          draftSummary: state.evolution.ontologyDetail?.draftSummary || null,
          supportMatrix: state.evolution.ontologySupportMatrix || [],
          facetCoverage: state.evolution.ontologyFacetCoverage || [],
          facetSummary: state.evolution.ontologyFacetSummary || null,
          candidates: state.evolution.ontologyCandidates || [],
          freshness: state.evolution.ontologyFreshness || null,
          exportedAt: new Date().toISOString()
        };
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const versionKey = String(payload.version?.versionKey || payload.version?.name || "taxonomy_review")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
        a.href = url;
        a.download = (versionKey || "taxonomy_review") + ".json";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setOntologyActionMsg("Ontology review exported.");
      }

      function clearEvolutionPolling() {
        if (state.evolution.lightPollTimer) {
          clearInterval(state.evolution.lightPollTimer);
          state.evolution.lightPollTimer = null;
        }
        if (state.evolution.heavyPollTimer) {
          clearInterval(state.evolution.heavyPollTimer);
          state.evolution.heavyPollTimer = null;
        }
      }

      function startEvolutionPolling() {
        clearEvolutionPolling();
        if (state.module !== "evolution") return;
          state.evolution.lightPollTimer = setInterval(() => {
            if (document.hidden) return;
            loadEvolutionLight().catch((err) => console.error(err));
            if (state.evolutionTab === "preloop") {
              if (!state.evolution.preloopDraft?.dirty && !state.evolution.preloopSaving) {
                loadPreloopQueueAndReadiness().catch((err) => console.error(err));
              }
            }
          }, 5000);
        state.evolution.heavyPollTimer = setInterval(() => {
          if (document.hidden) return;
          if (state.evolutionTab === "overview") {
            loadEvolutionHeavy().catch((err) => console.error(err));
          }
        }, 30000);
      }

      function evolutionKpiCard(label, value, extra = "") {
        const detail = extra ? '<div class="muted" style="margin-top:4px;font-size:12px;">' + escapeHtml(extra) + "</div>" : "";
        return '<div class="evo-kpi"><div class="label">' + escapeHtml(label) + '</div><div class="value">' + escapeHtml(value) + "</div>" + detail + "</div>";
      }

      function ensureEvolutionCharts() {
        if (!state.evolution.charts.frontier) state.evolution.charts.frontier = echarts.init(byId("evoFrontierChart"));
        if (!state.evolution.charts.velocity) state.evolution.charts.velocity = echarts.init(byId("evoVelocityChart"));
        if (!state.evolution.charts.failures) state.evolution.charts.failures = echarts.init(byId("evoFailuresChart"));
        if (!state.evolution.charts.heatmap) state.evolution.charts.heatmap = echarts.init(byId("evoHeatmapChart"));
        if (!state.evolution.charts.hypothesis) state.evolution.charts.hypothesis = echarts.init(byId("evoHypothesisChart"));
        if (!state.evolution.charts.diversity) state.evolution.charts.diversity = echarts.init(byId("evoDiversityChart"));
      }

      function renderEvolutionKpis(overviewPayload) {
        const exp = overviewPayload?.experiment || {};
        const k = overviewPayload?.kpis || {};
        byId("evoKpiGrid").innerHTML = [
          evolutionKpiCard("Experiment", String(exp.name || exp.id || "n/a"), String(exp.status || "n/a")),
          evolutionKpiCard("Benchmark Stage", String(exp.benchmarkStage || "draft")),
          evolutionKpiCard("Active Lock", String(exp.activeLockVersion || "none")),
          evolutionKpiCard("Current Variant", String(k.currentVariantId || "n/a")),
          evolutionKpiCard("Best Variant", String(k.bestVariantId || "n/a")),
          evolutionKpiCard("Composite Score", (Number(k.compositeScore || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Behavior Correct", (Number(k.behaviorCorrectRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Grounding", (Number(k.groundingRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("False Confident", (Number(k.falseConfidentRate || 0) * 100).toFixed(2) + "%"),
          evolutionKpiCard("Clear Behavior", (Number(k.clearBehaviorCorrectRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Clarify Behavior", (Number(k.clarifyBehaviorCorrectRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Unresolved Debt", (Number(k.unresolvedAmbiguousRatio || 0) * 100).toFixed(2) + "%", k.unresolvedDebtPass ? "within limit" : "above limit"),
          evolutionKpiCard("Queue / Running", String(Number(k.queuedCount || 0)) + " / " + String(Number(k.runningCount || 0))),
          evolutionKpiCard("Completed / Failed", String(Number(k.completedCount || 0)) + " / " + String(Number(k.failedCount || 0))),
          evolutionKpiCard("Provisional", exp.provisionalWinnerStatus ? "yes" : "no"),
          evolutionKpiCard("Certified Winner", exp.certificationStatus ? "yes" : "no"),
          evolutionKpiCard("Authoring Accepted", String(Number(k.authoringAcceptedCount || 0))),
          evolutionKpiCard("Authoring Rejected", String(Number(k.authoringRejectedCount || 0))),
          evolutionKpiCard("Authoring Unresolved", String(Number(k.authoringUnresolvedCount || 0))),
          evolutionKpiCard("Verifier Pass", (Number(k.verifierPassRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Calibration Eligible", String(Number(k.calibrationEligibleCount || 0))),
          evolutionKpiCard("Human Share", (Number(k.humanCaseShare || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Assistant Share", (Number(k.assistantCaseShare || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Direct 1:1", String(Number(k.direct1to1Coverage || 0))),
          evolutionKpiCard("Group Chats", String(Number(k.groupChatCoverage || 0))),
          evolutionKpiCard("3rd-Party", String(Number(k.thirdPartyCoverage || 0))),
          evolutionKpiCard("Human Actors", String(Number(k.distinctHumanActors || 0))),
          evolutionKpiCard("Human Groups", String(Number(k.distinctHumanGroups || 0))),
          evolutionKpiCard("Families", String(Number(k.distinctConversationFamilies || 0))),
          evolutionKpiCard("Leakage Events", String(Number(k.leakageCount || 0))),
          evolutionKpiCard("Timeouts", String(Number(k.timeoutCount || 0)), "recoveries " + String(Number(k.timeoutRecoveries || 0)))
        ].join("");

        byId("evoRuntimeStrip").innerHTML = [
          evolutionKpiCard("Timeout Count", String(Number(k.timeoutCount || 0))),
          evolutionKpiCard("Timeout Recoveries", String(Number(k.timeoutRecoveries || 0))),
          evolutionKpiCard("No-data Requeue", String(Number(k.noDataRequeueCount || 0))),
          evolutionKpiCard("Rescue Retries", String(Number(k.rescueRetryCount || 0)))
        ].join("");
      }

      function renderFrontier(frontierPayload) {
        ensureEvolutionCharts();
        const points = Array.isArray(frontierPayload?.points) ? frontierPayload.points : [];
        state.evolution.frontierPoints = points;
        const chart = state.evolution.charts.frontier;
        chart.setOption({
          tooltip: {
            trigger: "item",
            formatter: (params) => {
              const d = params.data || {};
              return [
                escapeHtml(String(d.variantId || "")),
                "Behavior: " + (Number(d.behaviorCorrectRate || 0) * 100).toFixed(2) + "%",
                "Grounding: " + (Number(d.groundingRate || 0) * 100).toFixed(2) + "%",
                "Composite: " + (Number(d.compositeScore || 0) * 100).toFixed(2) + "%",
                "Latency x: " + Number(d.latencyMultiplier || 0).toFixed(2),
                "Cost x: " + Number(d.costMultiplier || 0).toFixed(2),
                "Group: " + String(d.groupId || "n/a")
              ].join("<br/>");
            }
          },
          xAxis: { type: "value", name: "Latency Multiplier", axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", name: "Behavior Correct", min: 0, max: 1, axisLabel: { color: "#9eb3cb" } },
          grid: { left: 60, right: 20, top: 30, bottom: 40 },
          series: [{
            type: "scatter",
            symbolSize: 12,
            data: points.map((p) => ({
              value: [Number(p.latencyMultiplier || 0), Number(p.behaviorCorrectRate || 0)],
              ...p,
              itemStyle: {
                color: p.paretoLatency ? "#39d98a" : "#46c0ff"
              }
            }))
          }]
        });
        chart.off("click");
        chart.on("click", (params) => {
          const d = params?.data || {};
          byId("evoStrategyDetail").innerHTML =
            "<b>" + escapeHtml(String(d.variantId || "n/a")) + "</b><br/>"
            + "Strategy: " + escapeHtml(String(d.strategyId || "n/a")) + "<br/>"
            + "Status: " + escapeHtml(String(d.status || "n/a")) + "<br/>"
            + "Behavior: " + (Number(d.behaviorCorrectRate || 0) * 100).toFixed(2) + "%<br/>"
            + "Grounding: " + (Number(d.groundingRate || 0) * 100).toFixed(2) + "%<br/>"
            + "False confident: " + (Number(d.falseConfidentRate || 0) * 100).toFixed(2) + "%<br/>"
            + "Composite: " + (Number(d.compositeScore || 0) * 100).toFixed(2) + "%<br/>"
            + "Latency P95: " + Number(d.latencyP95Ms || 0).toFixed(1) + " ms<br/>"
            + "Cost/1k: $" + Number(d.costPer1k || 0).toFixed(4) + "<br/>"
            + "Decision layer: " + escapeHtml(String(d.decisionLayer || "exploratory")) + "<br/>"
            + "Pareto (latency): " + (d.paretoLatency ? "yes" : "no")
            + " | Pareto (cost): " + (d.paretoCost ? "yes" : "no");
        });
      }

      function renderTimeseries(timeseriesPayload) {
        ensureEvolutionCharts();
        const velocity = Array.isArray(timeseriesPayload?.velocity) ? timeseriesPayload.velocity : [];
        const failuresByBucket = Array.isArray(timeseriesPayload?.failuresByBucket) ? timeseriesPayload.failuresByBucket : [];
        const positions = velocity.map((v) => String(v.position));
        state.evolution.charts.velocity.setOption({
          tooltip: { trigger: "axis" },
          legend: { textStyle: { color: "#c7d7ec" } },
          xAxis: { type: "category", data: positions, axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", min: 0, max: 1, axisLabel: { color: "#9eb3cb" } },
          grid: { left: 50, right: 20, top: 38, bottom: 36 },
          series: [
            {
              name: "Pass",
              type: "line",
              smooth: true,
              data: velocity.map((v) => Number(v.passRate || 0))
            },
            {
              name: "Best so far",
              type: "line",
              smooth: true,
              data: velocity.map((v) => Number(v.bestSoFar || 0))
            },
            {
              name: "Moving avg",
              type: "line",
              smooth: true,
              data: velocity.map((v) => Number(v.movingAverage || 0))
            }
          ]
        });

        state.evolution.charts.failures.setOption({
          tooltip: { trigger: "axis" },
          legend: { type: "scroll", textStyle: { color: "#c7d7ec" } },
          xAxis: { type: "category", data: positions, axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", axisLabel: { color: "#9eb3cb" } },
          grid: { left: 50, right: 20, top: 42, bottom: 36 },
          series: failuresByBucket.map((entry) => ({
            name: entry.bucket,
            type: "line",
            stack: "failures",
            areaStyle: {},
            symbol: "none",
            data: Array.isArray(entry.series) ? entry.series.map((x) => Number(x || 0)) : []
          }))
        });

        const hypothesisCounts = timeseriesPayload?.hypothesisOutcomes?.counts || {};
        state.evolution.charts.hypothesis.setOption({
          tooltip: { trigger: "axis" },
          xAxis: {
            type: "category",
            data: ["confirmed", "partial", "rejected"],
            axisLabel: { color: "#9eb3cb" }
          },
          yAxis: { type: "value", axisLabel: { color: "#9eb3cb" } },
          grid: { left: 44, right: 20, top: 20, bottom: 30 },
          series: [{
            type: "bar",
            data: [
              Number(hypothesisCounts.confirmed || 0),
              Number(hypothesisCounts.partiallyConfirmed || 0),
              Number(hypothesisCounts.rejected || 0)
            ],
            itemStyle: {
              color: (p) => ["#39d98a", "#f5ad42", "#ff6b6b"][p.dataIndex] || "#46c0ff"
            }
          }]
        });
      }

      function renderHeatmap(heatmapPayload) {
        ensureEvolutionCharts();
        const components = Array.isArray(heatmapPayload?.components) ? heatmapPayload.components : [];
        const domains = Array.isArray(heatmapPayload?.domains) ? heatmapPayload.domains : [];
        const cells = Array.isArray(heatmapPayload?.cells) ? heatmapPayload.cells : [];
        const xIdx = new Map(components.map((name, i) => [name, i]));
        const yIdx = new Map(domains.map((name, i) => [name, i]));
        const data = [];
        for (const cell of cells) {
          const x = xIdx.get(cell.componentName);
          const y = yIdx.get(cell.domain);
          if (x == null || y == null) continue;
          data.push([x, y, Number(cell.score || 0)]);
        }
        state.evolution.charts.heatmap.setOption({
          tooltip: {
            formatter: (p) => {
              const x = components[p.value[0]] || "";
              const y = domains[p.value[1]] || "";
              const s = Number(p.value[2] || 0).toFixed(3);
              return escapeHtml(x + " / " + y) + "<br/>score " + s;
            }
          },
          xAxis: { type: "category", data: components, axisLabel: { color: "#9eb3cb", rotate: 30 } },
          yAxis: { type: "category", data: domains, axisLabel: { color: "#9eb3cb" } },
          visualMap: {
            min: 0,
            max: 1,
            calculable: false,
            orient: "horizontal",
            left: "center",
            bottom: 0,
            inRange: { color: ["#0b2036", "#1f6aa5", "#39d98a"] },
            textStyle: { color: "#9eb3cb" }
          },
          grid: { left: 88, right: 20, top: 20, bottom: 56 },
          series: [{ type: "heatmap", data }]
        });
      }

      function renderDiversity(diversityPayload) {
        ensureEvolutionCharts();
        const bins = Array.isArray(diversityPayload?.bins) ? diversityPayload.bins : [];
        state.evolution.charts.diversity.setOption({
          tooltip: { trigger: "axis" },
          xAxis: { type: "category", data: bins.map((b) => b.label), axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", axisLabel: { color: "#9eb3cb" } },
          grid: { left: 44, right: 20, top: 20, bottom: 30 },
          series: [{
            type: "bar",
            data: bins.map((b) => Number(b.count || 0)),
            itemStyle: { color: "#46c0ff" }
          }]
        });
      }

      function renderCoverage(coveragePayload) {
        const expected = Number(coveragePayload?.expectedEvidenceCount || 0);
        const touched = Number(coveragePayload?.touchedEvidenceCount || 0);
        const ratio = Number(coveragePayload?.coverageRatio || 0);
        const lockVersion = String(coveragePayload?.lockVersion || "none");
        byId("evoCoverageSummary").textContent =
          "Lock " + lockVersion
          + " | touched " + touched + " / expected " + expected
          + " (" + (ratio * 100).toFixed(2) + "%)";
      }

      function renderLineage(lineagePayload) {
        const list = Array.isArray(lineagePayload?.lineage) ? lineagePayload.lineage : [];
        const nodes = list.map((item) => ({
          data: {
            id: String(item.strategyVariantId),
            label: String(item.variantId || item.strategyId || item.strategyVariantId)
          }
        }));
        const edges = [];
        for (const item of list) {
          const parent = String(item.parentStrategyVariantId || "").trim();
          if (parent) {
            edges.push({
              data: {
                id: String(item.strategyVariantId) + "-" + parent,
                source: parent,
                target: String(item.strategyVariantId)
              }
            });
          }
        }
        if (state.evolution.lineageGraph) state.evolution.lineageGraph.destroy();
        state.evolution.lineageGraph = cytoscape({
          container: byId("evoLineageGraph"),
          elements: [...nodes, ...edges],
          style: [
            {
              selector: "node",
              style: {
                "background-color": "#46c0ff",
                label: "data(label)",
                color: "#dce9f8",
                "font-size": 10,
                "text-wrap": "wrap",
                "text-max-width": 110,
                "text-outline-color": "#081627",
                "text-outline-width": 2
              }
            },
            { selector: "edge", style: { width: 1.5, "line-color": "#2f5a84", "target-arrow-color": "#2f5a84", "target-arrow-shape": "triangle" } }
          ],
          layout: { name: "breadthfirst", directed: true, padding: 20, spacingFactor: 1.1 }
        });
        try { state.evolution.lineageGraph.fit(undefined, 20); } catch {}
      }

      async function loadEvolutionLight() {
        const experimentId = await ensureEvolutionExperimentId(false);
        if (!experimentId) {
          byId("evoKpiGrid").innerHTML = '<div class="muted">No experiment found yet.</div>';
          return;
        }
        const [overview, frontier, timeseries] = await Promise.all([
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/overview", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/frontier", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/timeseries", { method: "GET" })
        ]);
        renderEvolutionKpis(overview);
        renderFrontier(frontier);
        renderTimeseries(timeseries);
        byId("runControlSummary").textContent =
          "Experiment " + String(overview?.experiment?.name || experimentId) + " | status " + String(overview?.experiment?.status || "n/a")
          + " | stage " + String(overview?.experiment?.benchmarkStage || "draft")
          + " | lock " + String(overview?.experiment?.activeLockVersion || "none")
          + " | provisional " + (overview?.experiment?.provisionalWinnerStatus ? "yes" : "no")
          + " | certified " + (overview?.experiment?.certificationStatus ? "yes" : "no");
      }

      async function loadEvolutionHeavy() {
        const experimentId = await ensureEvolutionExperimentId(false);
        if (!experimentId) return;
        const [heatmap, diversity, coverage, lineage] = await Promise.all([
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/component_heatmap", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/diversity", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/evolution/coverage", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/lineage", { method: "GET" })
        ]);
        renderHeatmap(heatmap);
        renderDiversity(diversity);
        renderCoverage(coverage);
        renderLineage(lineage);
      }

      async function loadPreloopQueueAndReadiness() {
        const experimentId = await ensureEvolutionExperimentId(false);
        if (!experimentId) return;
        const requestSeq = Number(state.evolution.preloopLoadSeq || 0) + 1;
        state.evolution.preloopLoadSeq = requestSeq;
        const statusFilter = String(byId("preloopStatusFilter").value || "pending");
        const verdictFilter = String(byId("preloopVerdictFilter").value || "");
        const [pendingPayload, reportPayload, readinessPayload] = await Promise.all([
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/pending?limit=200&status=" + encodeURIComponent(statusFilter) + "&verdict=" + encodeURIComponent(verdictFilter), { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/report", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/preloop/readiness", { method: "GET" })
        ]);
        if (requestSeq !== Number(state.evolution.preloopLoadSeq || 0)) {
          return;
        }
        const queue = Array.isArray(pendingPayload?.items) ? pendingPayload.items : [];
        state.evolution.queue = queue;
        state.evolution.activeReadiness = readinessPayload;
        state.evolution.activePreloopReport = reportPayload;
        const domains = Array.from(new Set(queue.map((item) => String(item.domain || "")).filter(Boolean))).sort();
        const currentDomain = String(byId("preloopDomainFilter").value || "");
        byId("preloopDomainFilter").innerHTML =
          '<option value="">all domains</option>' +
          domains.map((domain) => '<option value="' + escapeHtml(domain) + '">' + escapeHtml(domain.replaceAll("_", " ")) + '</option>').join("");
        if (domains.includes(currentDomain)) byId("preloopDomainFilter").value = currentDomain;
        byId("preloopGlossaryAmbiguity").innerHTML =
          "<b>Ambiguity guide</b><br/>"
          + "Clear: the question is specific enough to answer directly.<br/>"
          + "Clarify required: the question is plausible but missing one critical piece, so the agent should ask one short follow-up.<br/>"
          + "Unresolved: the case itself is weak, unnatural, or not grounded enough to trust for scoring.";
        byId("preloopGlossarySets").innerHTML =
          "<b>Set guide</b><br/>"
          + "Dev: general working set.<br/>"
          + "Critical: must-pass cases.<br/>"
          + "Certification: winner decision set.<br/>"
          + "Stress: harder variants that probe ambiguity/noise.<br/>"
          + "Coverage: broader domain coverage checks.";
        renderPreloopQueue();
        renderPreloopReadiness(readinessPayload, reportPayload);
      }

      function selectedLockStageKey() {
        const raw = byId("runControlLockStage")
          ? String(byId("runControlLockStage").value || "core_ready")
          : "core_ready";
        return raw === "selection_ready" || raw === "certification_ready" ? raw : "core_ready";
      }

      function currentFilteredQueue() {
        const domain = String(byId("preloopDomainFilter").value || "");
        const ambiguity = String(byId("preloopAmbiguityFilter").value || "");
        const caseSet = String(byId("preloopCaseSetFilter").value || "");
        const out = state.evolution.queue.filter((item) => {
          if (domain && String(item?.domain || "") !== domain) return false;
          if (ambiguity && String(item?.ambiguityClass || "") !== ambiguity) return false;
          if (caseSet && String(item?.caseSet || "") !== caseSet) return false;
          return true;
        });
        state.evolution.filteredQueue = out;
        return out;
      }

      function setPreloopButtonGroup(groupId, value) {
        const container = byId(groupId);
        container.querySelectorAll(".preloop-choice-btn").forEach((btn) => {
          btn.classList.toggle("active", String(btn.dataset.value || "") === String(value || ""));
        });
      }

      function resetPreloopDraft(item) {
        const draft = state.evolution.preloopDraft;
        draft.itemId = String(item?.calibrationItemId || "");
        draft.verdict = String(item?.reviewVerdict || item?.assistantSuggestion?.verdict || "yes");
        draft.ambiguityClass = String(item?.assistantSuggestion?.ambiguityClass || item?.ambiguityClass || "clear");
        draft.notes = String(item?.reviewNotes || item?.assistantSuggestion?.notes || "");
        draft.dirty = false;
        state.evolution.verdict = draft.verdict;
        state.evolution.ambiguityClass = draft.ambiguityClass;
      }

      function applyPreloopDraftToControls() {
        const draft = state.evolution.preloopDraft;
        state.evolution.verdict = String(draft.verdict || "yes");
        state.evolution.ambiguityClass = String(draft.ambiguityClass || "clear");
        setPreloopButtonGroup("preloopVerdictGroup", state.evolution.verdict);
        setPreloopButtonGroup("preloopAmbiguityGroup", state.evolution.ambiguityClass);
        byId("preloopNotes").value = String(draft.notes || "");
      }

      function renderPreloopQueue() {
        const filtered = currentFilteredQueue();
        if (filtered.length === 0) {
          state.evolution.selectedQueueIndex = -1;
          state.evolution.selectedQueueItemId = "";
          byId("preloopQueueList").innerHTML = '<div class="muted">No calibration items in this filter.</div>';
          renderPreloopSelectedCase(null);
          return;
        }
        const selectedItemId = String(state.evolution.selectedQueueItemId || "");
        const selectedItemIndex = selectedItemId
          ? filtered.findIndex((item) => String(item?.calibrationItemId || "") === selectedItemId)
          : -1;
        if (selectedItemIndex >= 0) {
          state.evolution.selectedQueueIndex = selectedItemIndex;
        } else if (state.evolution.selectedQueueIndex < 0 || state.evolution.selectedQueueIndex >= filtered.length) {
          state.evolution.selectedQueueIndex = 0;
        }
        state.evolution.selectedQueueItemId = String(filtered[state.evolution.selectedQueueIndex]?.calibrationItemId || "");
        byId("preloopQueueList").innerHTML = filtered.map((item, idx) => {
          const active = String(item?.calibrationItemId || "") === String(state.evolution.selectedQueueItemId || "") ? " active" : "";
          const itemStatus = String(item?.itemStatus || "pending");
          const ambiguity = String(item?.ambiguityClass || "n/a");
          const owner = String(item?.ownerValidationState || "n/a");
          const preview = String(item.question || "").slice(0, 90);
          return '<div class="preloop-item' + active + '" data-preloop-index="' + idx + '">'
            + '<div><b>' + escapeHtml(String(item.domain || "case").replaceAll("_", " ")) + "</b></div>"
            + '<div class="muted">' + escapeHtml(String(item.caseSet || "n/a") + " | " + itemStatus + " | " + ambiguity + " | " + owner) + "</div>"
            + '<div>' + escapeHtml(preview) + "</div>"
            + "</div>";
        }).join("");
        byId("preloopQueueList").querySelectorAll(".preloop-item").forEach((el) => {
          el.addEventListener("click", () => {
            const idx = Number(el.dataset.preloopIndex || "0");
            state.evolution.selectedQueueIndex = Number.isFinite(idx) ? idx : 0;
            state.evolution.selectedQueueItemId = String(filtered[state.evolution.selectedQueueIndex]?.calibrationItemId || "");
            renderPreloopQueue();
          });
        });
        renderPreloopSelectedCase(filtered[state.evolution.selectedQueueIndex] || null);
      }

      function renderPreloopSelectedCase(item) {
        if (!item) {
          const emptyText = '<div class="muted">No calibration item in this filter. Change filters or load a different review mode.</div>';
          resetPreloopDraft(null);
          applyPreloopDraftToControls();
          byId("preloopCaseMeta").textContent = "No case selected.";
          byId("preloopQuestionText").innerHTML = emptyText;
          byId("preloopExpectedBehavior").innerHTML = '<div class="muted">Nothing to review yet.</div>';
          byId("preloopSemanticFrame").innerHTML = emptyText;
          byId("preloopClarificationPath").innerHTML = emptyText;
          byId("preloopExpectedAnswer").innerHTML = emptyText;
          byId("preloopEvidencePreview").innerHTML = emptyText;
          byId("preloopAdmission").innerHTML = emptyText;
          byId("preloopQualityGate").innerHTML = emptyText;
          byId("preloopSuggestedReview").innerHTML = emptyText;
          return;
        }
        if (String(state.evolution.preloopDraft.itemId || "") !== String(item.calibrationItemId || "")) {
          resetPreloopDraft(item);
        }
        byId("preloopCaseMeta").textContent =
          "Case " + String(item.caseId || "n/a")
          + " | item " + String(item.calibrationItemId || "n/a")
          + " | " + String(item.domain || "n/a").replaceAll("_", " ")
          + " / " + String(item.lens || "n/a")
          + " | created " + fmtDate(item.createdAt);
        byId("preloopQuestionText").textContent = String(item.question || "");
        byId("preloopExpectedBehavior").textContent = String(item.expectedBehavior || "answer_now").replaceAll("_", " ");
        const semanticFrame = item.semanticFrame || null;
        byId("preloopSemanticFrame").innerHTML = semanticFrame
          ? [
              semanticFrame.topicSummary ? '<div><b>Topic:</b> ' + escapeHtml(String(semanticFrame.topicSummary)) + '</div>' : "",
              semanticFrame.conversationIntent ? '<div><b>Intent:</b> ' + escapeHtml(String(semanticFrame.conversationIntent)) + '</div>' : "",
              semanticFrame.actorScope ? '<div><b>Actor scope:</b> ' + escapeHtml(String(semanticFrame.actorScope)) + '</div>' : "",
              semanticFrame.timeframe ? '<div><b>Timeframe:</b> ' + escapeHtml(String(semanticFrame.timeframe)) + '</div>' : "",
              Array.isArray(semanticFrame.participants) && semanticFrame.participants.length > 0
                ? '<div><b>Participants:</b> ' + escapeHtml(semanticFrame.participants.join(", ")) + '</div>'
                : "",
              '<div class="muted" style="margin-top:6px;">'
                + 'Support ' + escapeHtml(String(semanticFrame.supportDepth || "n/a"))
                + ' | Ambiguity ' + escapeHtml(String(semanticFrame.ambiguityRisk || "n/a"))
                + (Array.isArray(semanticFrame.supportedLenses) && semanticFrame.supportedLenses.length > 0
                  ? ' | Lenses ' + escapeHtml(semanticFrame.supportedLenses.join(", "))
                  : "")
                + '</div>',
              item.semanticFrameSummary
                ? '<div class="muted" style="margin-top:6px;">' + escapeHtml(String(item.semanticFrameSummary)) + '</div>'
                : ""
            ].filter(Boolean).join("")
          : (item.semanticFrameSummary
            ? escapeHtml(String(item.semanticFrameSummary))
            : '<div class="muted">No semantic frame available.</div>');
        const clarificationQuestion = String(item.clarificationQuestion || "").trim();
        const resolvedQuestion = String(item.resolvedQuestionAfterClarification || "").trim();
        byId("preloopClarificationPath").innerHTML = String(item.expectedBehavior || "") === "clarify_first"
          ? [
              clarificationQuestion
                ? '<div><b>Ask first:</b> ' + escapeHtml(clarificationQuestion) + '</div>'
                : '<div class="muted">Clarification question missing.</div>',
              resolvedQuestion
                ? '<div style="margin-top:6px;"><b>Then resolve to:</b> ' + escapeHtml(resolvedQuestion) + '</div>'
                : '<div class="muted" style="margin-top:6px;">Resolved question not stored.</div>'
            ].join("")
          : '<div class="muted">No clarification expected for this case.</div>';
        byId("preloopExpectedAnswer").textContent = String(item.expectedAnswerSummaryHuman || "");
        const evidenceCards = Array.isArray(item.evidencePreview) ? item.evidencePreview : [];
        byId("preloopEvidencePreview").innerHTML = evidenceCards.length === 0
          ? '<div class="muted">No evidence preview available.</div>'
          : evidenceCards.map((ev) => (
            '<div class="preloop-evidence-card">'
            + '<div><b>' + escapeHtml(String(ev.actorName || ev.sourceSystem || "unknown")) + '</b></div>'
            + '<div class="muted">' + escapeHtml(String(ev.sourceSystem || "n/a")) + ' | ' + escapeHtml(fmtDate(ev.observedAt)) + '</div>'
            + '<div class="muted" style="margin-top:4px;">' + escapeHtml(String(ev.evidenceId || "")) + '</div>'
            + '<div style="margin-top:6px; white-space:pre-wrap; overflow-wrap:anywhere;">' + escapeHtml(String(ev.snippet || "")) + '</div>'
            + '</div>'
          )).join("");
        const admission = item.admissionDecision || {};
        const feasibility = item.feasibilityReport || {};
        byId("preloopAdmission").innerHTML =
          '<div><b>Status:</b> ' + escapeHtml(String(admission.status || "n/a"))
          + ' | <b>Admitted:</b> ' + escapeHtml(admission.admitted ? "yes" : "no")
          + ' | <b>Verifier:</b> ' + escapeHtml(String(feasibility.version || admission.verifierVersion || "n/a")) + '</div>'
          + '<div class="muted" style="margin-top:6px;">'
          + 'Oracle pass ' + escapeHtml(feasibility.pass ? "yes" : "no")
          + ' | exact hit ' + escapeHtml(feasibility.exactEvidenceHit ? "yes" : "no")
          + ' | conversation hit ' + escapeHtml(feasibility.conversationHit ? "yes" : "no")
          + ' | actor hit ' + escapeHtml(feasibility.actorConstrainedHit ? "yes" : "no")
          + '</div>'
          + (Array.isArray(admission.reasons) && admission.reasons.length > 0
            ? '<div style="margin-top:6px;">' + escapeHtml(admission.reasons.join(" | ")) + '</div>'
            : (feasibility.rationale
              ? '<div style="margin-top:6px;">' + escapeHtml(String(feasibility.rationale)) + '</div>'
              : ""));
        const gate = item.qualityGate || {};
        const critique = item.authoringCritique || null;
        byId("preloopQualityGate").innerHTML =
          '<div><b>Status:</b> ' + escapeHtml(String(gate.status || "n/a")) + ' | <b>Score:</b> ' + escapeHtml(Number(gate.score || 0).toFixed(2)) + '</div>'
          + '<div class="muted" style="margin-top:6px;">'
          + 'Naturalness ' + escapeHtml(Number(gate.dimensions?.naturalness || 0).toFixed(2))
          + ' | Answerability ' + escapeHtml(Number(gate.dimensions?.answerability || 0).toFixed(2))
          + ' | Ambiguity ' + escapeHtml(Number(gate.dimensions?.ambiguityCorrectness || 0).toFixed(2))
          + ' | Grounding ' + escapeHtml(Number(gate.dimensions?.evidenceGrounding || 0).toFixed(2))
          + '</div>'
          + (critique
            ? '<div class="muted" style="margin-top:6px;">'
              + 'Actor scope ' + escapeHtml(Number(critique.dimensions?.actorScopeFidelity || 0).toFixed(2))
              + ' | Lens fit ' + escapeHtml(Number(critique.dimensions?.lensFit || 0).toFixed(2))
              + '</div>'
            : '')
          + (Array.isArray(gate.reasons) && gate.reasons.length > 0
            ? '<div style="margin-top:6px;">' + escapeHtml(gate.reasons.join(" | ")) + '</div>'
            : (Array.isArray(critique?.reasons) && critique.reasons.length > 0
              ? '<div style="margin-top:6px;">' + escapeHtml(critique.reasons.join(" | ")) + '</div>'
              : ""));
        const suggestion = item.assistantSuggestion || null;
        byId("preloopSuggestedReview").innerHTML = suggestion
          ? (
            '<div><b>Verdict:</b> ' + escapeHtml(String(suggestion.verdict || "n/a"))
            + ' | <b>Ambiguity:</b> ' + escapeHtml(String(suggestion.ambiguityClass || item.ambiguityClass || "clear").replaceAll("_", " "))
            + ' | <b>Confidence:</b> ' + escapeHtml(Number(suggestion.confidence || 0).toFixed(2)) + '</div>'
            + (suggestion.notes ? '<div style="margin-top:6px;">' + escapeHtml(String(suggestion.notes || "")) + '</div>' : "")
          )
          : '<div class="muted">No AI suggestion yet.</div>';
        applyPreloopDraftToControls();
      }

      function renderPreloopReadiness(readinessPayload, reportPayload) {
        const gates = readinessPayload?.gates || {};
        const metrics = readinessPayload?.metrics || {};
        const queueCounts = readinessPayload?.queueCounts || {};
        const datasetCounts = readinessPayload?.datasetCounts || {};
        const authoringCounts = readinessPayload?.authoringCounts || {};
        const lockCounts = readinessPayload?.lockEligibilityCounts || {};
        const stageReadiness = readinessPayload?.stageReadiness || {};
        const benchmarkStage = String(readinessPayload?.benchmarkStage || "draft");
        const statusCounts = reportPayload?.statusCounts || {};
        const verdictCounts = reportPayload?.verdictCounts || {};
        const selectedStage = selectedLockStageKey();
        const lockReady = Boolean(stageReadiness?.[selectedStage]?.pass);
        const startReady = Boolean(gates.readyForStart);
        const renderMinMetric = (label, value, target) => {
          const normalizedTarget = Number(target ?? 0);
          if (!(normalizedTarget > 0)) return "";
          return '<div class="preloop-stage-metric"><span>' + escapeHtml(String(label)) + '</span><strong>' + Number(value || 0) + ' / ' + normalizedTarget + '</strong></div>';
        };
        const renderMaxMetric = (label, value, target) => {
          if (target == null || target === "") return "";
          const normalizedTarget = Number(target || 0);
          return '<div class="preloop-stage-metric"><span>' + escapeHtml(String(label)) + '</span><strong>' + Number(value || 0) + ' / ' + normalizedTarget + '</strong></div>';
        };
        byId("preloopQueueCounts").innerHTML =
          "<b>Queue now</b><br/>"
          + "Pending " + Number(queueCounts.pending || 0)
          + " | Labeled " + Number(queueCounts.labeled || 0)
          + " | Skipped " + Number(queueCounts.skipped || 0);
        byId("preloopDatasetCounts").innerHTML =
          "<b>Dataset totals</b><br/>"
          + "Total " + Number(datasetCounts.total || 0)
          + " | Clear " + Number(datasetCounts.clear || 0)
          + " | Clarify " + Number(datasetCounts.clarifyRequired || 0)
          + " | Unresolved " + Number(datasetCounts.unresolved || 0);
        byId("preloopAuthoringCounts").innerHTML =
          "<b>Authoring totals</b><br/>"
          + "Accepted " + Number(authoringCounts.accepted || 0)
          + " | Rejected " + Number(authoringCounts.rejected || 0)
          + " | Unresolved " + Number(authoringCounts.unresolved || 0);
        const stageReadinessCards = ["core_ready", "selection_ready", "certification_ready"].map((key) => {
          const label = key === "core_ready"
            ? "Core"
            : key === "selection_ready"
              ? "Selection"
              : "Certification";
          const item = stageReadiness?.[key] || {};
          const isReady = Boolean(item.pass);
          const statusText = isReady ? "ready" : "blocked";
          const threshold = item.thresholds || {};
          const pendingOwnerValue = Number(
            key === "core_ready"
              ? (lockCounts.pendingOwnerInCoreSlice || 0)
              : (lockCounts.pendingOwnerInSelectionSlice || 0)
          );
          const pendingCalibrationValue = Number(
            key === "core_ready"
              ? (lockCounts.pendingCalibrationInCoreSlice || 0)
              : (lockCounts.pendingCalibrationInSelectionSlice || 0)
          );
          const statusClass = isReady ? "ready" : "blocked";
          const readinessMetrics = [
            renderMinMetric("Owner reviewed", lockCounts.ownerReviewedTotal || 0, threshold.ownerReviewedTotalMin),
            renderMinMetric("Reviewed yes", lockCounts.ownerApprovedYes || 0, threshold.ownerApprovedYesMin),
            renderMinMetric("Reviewed no", lockCounts.ownerRejectedNo || 0, threshold.representativeNoMin),
            renderMinMetric("Reviewed clarify", lockCounts.reviewedClarify || 0, threshold.reviewedClarifyMin),
            renderMaxMetric("Pending owner", pendingOwnerValue, threshold.pendingOwnerMax),
            renderMaxMetric("Pending calibration", pendingCalibrationValue, threshold.pendingCalibrationMax)
          ].filter(Boolean).join("");
          const coverageMetrics = [
            renderMinMetric("Domains", lockCounts.approvedDomainCoverage || 0, threshold.approvedDomainCoverageMin),
            renderMinMetric("Lenses", lockCounts.approvedLensCoverage || 0, threshold.approvedLensCoverageMin),
            renderMinMetric("Actors", lockCounts.approvedActorCoverage || 0, threshold.actorCoverageMin),
            renderMinMetric("Groups", lockCounts.approvedGroupCoverage || 0, threshold.groupCoverageMin),
            renderMinMetric("Families", lockCounts.approvedDistinctConversationFamilies || 0, threshold.distinctConversationFamiliesMin),
            renderMinMetric("Critical reviewed", lockCounts.criticalReviewedSlice || 0, threshold.criticalReviewedSliceMin)
          ].filter(Boolean).join("");
          return '<article class="preloop-stage-card ' + statusClass + '">'
            + '<div class="preloop-stage-head">'
            + '<div class="preloop-stage-title">' + label + '</div>'
            + '<div class="preloop-stage-badge ' + statusClass + '">' + statusText + '</div>'
            + '</div>'
            + '<div class="preloop-stage-group">'
            + '<div class="preloop-stage-group-title">Readiness</div>'
            + '<div class="preloop-stage-metric-list">'
            + readinessMetrics
            + '</div></div>'
            + '<div class="preloop-stage-group">'
            + '<div class="preloop-stage-group-title">Coverage</div>'
            + '<div class="preloop-stage-metric-list">'
            + coverageMetrics
            + '</div></div>'
            + '</article>';
        }).join("");
        byId("preloopStageReadiness").className = "preloop-stage-grid";
        byId("preloopStageReadiness").innerHTML = stageReadinessCards;

        const reviewedSummary = [
          "<b>Reviewed:</b>",
          "owner " + Number(lockCounts.ownerReviewedTotal || 0),
          "yes " + Number(lockCounts.ownerApprovedYes || 0),
          "no " + Number(lockCounts.ownerRejectedNo || 0),
          "clarify " + Number(lockCounts.reviewedClarify || 0),
          "critical " + Number(lockCounts.criticalReviewedSlice || 0)
        ].join(" | ");
        byId("preloopReadinessBar").innerHTML =
          reviewedSummary
          + " | Stage " + escapeHtml(benchmarkStage)
          + " | Clear " + (Number(metrics.clearPassRate || 0) * 100).toFixed(2) + "%"
          + " | Clarify " + (Number(metrics.clarifyPassRate || 0) * 100).toFixed(2) + "%"
          + " | Debt " + (Number(metrics.unresolvedAmbiguousRatio || 0) * 100).toFixed(2) + "%"
          + " | Verifier " + (Number(metrics.verifierPassRate || 0) * 100).toFixed(2) + "%"
          + " | Human " + (Number(metrics.humanCaseShare || 0) * 100).toFixed(1) + "%"
          + " | Assistant " + (Number(metrics.assistantCaseShare || 0) * 100).toFixed(1) + "%"
          + " | 1:1 " + Number(metrics.direct1to1Coverage || 0)
          + " | Groups " + Number(metrics.groupChatCoverage || 0)
          + " | 3rd-party " + Number(metrics.thirdPartyCoverage || 0)
          + " | calibration eligible " + Number(lockCounts.calibrationEligible || 0)
          + " | pending owner " + Number(lockCounts.pendingOwner || 0)
          + " | pending queue " + Number(queueCounts.pending || 0)
          + " | labels yes/no " + Number(verdictCounts.yes || 0) + "/" + Number(verdictCounts.no || 0)
          + " | lock target " + escapeHtml(selectedStage);
        byId("runControlLockBenchmark").disabled = !lockReady;
        byId("runControlStartLoop").disabled = !startReady;
      }

      async function submitPreloopDecisionSaveNext() {
        const filtered = state.evolution.filteredQueue;
        const idx = state.evolution.selectedQueueIndex;
        const item = filtered[idx];
        if (!item) {
          byId("preloopActionMsg").textContent = "No item selected.";
          return;
        }
        if (state.evolution.preloopSaving) {
          return;
        }
        const experimentId = await ensureEvolutionExperimentId(false);
        const draft = state.evolution.preloopDraft;
        const payload = {
          calibrationItemId: String(item.calibrationItemId || ""),
          verdict: String(draft.verdict || state.evolution.verdict || "yes"),
          ambiguityClass: String(draft.ambiguityClass || state.evolution.ambiguityClass || "clear"),
          notes: String(draft.notes || byId("preloopNotes").value || "").trim() || undefined
        };
        const saveButton = byId("preloopSaveNext");
        state.evolution.preloopSaving = true;
        saveButton.disabled = true;
        try {
          await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/label", {
            method: "POST",
            body: JSON.stringify(payload)
          });
          draft.dirty = false;
          draft.notes = "";
          byId("preloopActionMsg").textContent = "Saved " + payload.calibrationItemId + ".";
          const nextItemId = idx >= 0 && idx < filtered.length - 1
            ? String(filtered[idx + 1]?.calibrationItemId || "")
            : "";
          await loadPreloopQueueAndReadiness();
          if (state.evolution.filteredQueue.length > 0) {
            const nextIdx = nextItemId
              ? state.evolution.filteredQueue.findIndex((candidate) => String(candidate?.calibrationItemId || "") === nextItemId)
              : -1;
            state.evolution.selectedQueueIndex = nextIdx >= 0
              ? nextIdx
              : Math.min(idx, state.evolution.filteredQueue.length - 1);
            state.evolution.selectedQueueItemId = String(state.evolution.filteredQueue[state.evolution.selectedQueueIndex]?.calibrationItemId || "");
            renderPreloopQueue();
          } else {
            state.evolution.selectedQueueItemId = "";
            renderPreloopQueue();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          byId("preloopActionMsg").textContent = "Save/refresh failed: " + message;
        } finally {
          state.evolution.preloopSaving = false;
          saveButton.disabled = false;
        }
      }

      async function generatePreloopSample() {
        const experimentId = await ensureEvolutionExperimentId(false);
        const count = Math.max(1, Math.min(200, Number(byId("preloopSampleCount").value || "20")));
        const caseSet = String(byId("preloopCaseSetFilter").value || "").trim();
        const domain = String(byId("preloopDomainFilter").value || "").trim();
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/sample", {
          method: "POST",
          body: JSON.stringify({
            count,
            caseSet: caseSet || undefined,
            domain: domain || undefined
          })
        });
        byId("preloopActionMsg").textContent = "Queue refreshed with newly generated sample items.";
        await loadPreloopQueueAndReadiness();
      }

      async function generatePreloopAiSuggestions() {
        const experimentId = await ensureEvolutionExperimentId(false);
        const status = String(byId("preloopStatusFilter").value || "pending");
        const domain = String(byId("preloopDomainFilter").value || "").trim();
        const caseSet = String(byId("preloopCaseSetFilter").value || "").trim();
        byId("preloopActionMsg").textContent = "Generating AI suggestions...";
        const payload = await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/auto_review", {
          method: "POST",
          body: JSON.stringify({
            limit: 500,
            batchSize: 5,
            status,
            domain: domain || undefined,
            caseSet: caseSet || undefined
          })
        });
        byId("preloopActionMsg").textContent =
          "AI suggestions generated for " + Number(payload?.reviewed || 0) + " item(s); materialized " + Number(payload?.materialized || 0) + " new calibration item(s).";
        await loadPreloopQueueAndReadiness();
      }

      async function preloopLockBenchmark() {
        const experimentId = await ensureEvolutionExperimentId(false);
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/benchmark/lock", {
          method: "POST",
          body: JSON.stringify({
            lockStage: String(byId("runControlLockStage").value || "core_ready")
          })
        });
        byId("preloopActionMsg").textContent = "Benchmark locked.";
        await loadPreloopQueueAndReadiness();
        await loadEvolutionLight();
      }

      function appendRunControlLog(line) {
        const el = byId("runControlLog");
        const now = new Date().toLocaleTimeString();
        const next = "[" + now + "] " + line;
        const existing = String(el.textContent || "");
        el.textContent = existing ? (existing + "\\n" + next) : next;
        el.scrollTop = el.scrollHeight;
      }

      async function runControlSingleStep() {
        const experimentId = await ensureEvolutionExperimentId(false);
        if (!experimentId) {
          appendRunControlLog("No experiment id available.");
          return;
        }
        const result = await api("/v2/experiments/run_step", {
          method: "POST",
          body: JSON.stringify({ experimentId })
        });
        const strategy = result?.strategy ? (result.strategy.variantId || result.strategy.strategyId) : "n/a";
        const pass = result?.strategyPass === true ? "pass" : (result?.strategyPass === false ? "fail" : "n/a");
        appendRunControlLog("step done | strategy " + strategy + " | " + pass + " | remaining " + String(result?.remainingQueued ?? "n/a"));
        await loadEvolutionLight();
        if (state.evolutionTab === "overview") await loadEvolutionHeavy();
      }

      async function runControlLoopStart() {
        if (state.evolution.loopRunning) return;
        state.evolution.loopRunning = true;
        appendRunControlLog("loop started");
        try {
          while (state.evolution.loopRunning) {
            const experimentId = await ensureEvolutionExperimentId(false);
            if (!experimentId) break;
            const result = await api("/v2/experiments/run_step", {
              method: "POST",
              body: JSON.stringify({ experimentId })
            });
            if (result?.message) appendRunControlLog(String(result.message));
            if (result?.strategy) {
              appendRunControlLog("strategy " + String(result.strategy.variantId || result.strategy.strategyId || "n/a")
                + " | " + (result?.strategyPass === true ? "pass" : "fail")
                + " | queued " + String(result?.remainingQueued ?? "n/a"));
            }
            await loadEvolutionLight();
            if (state.evolutionTab === "overview") await loadEvolutionHeavy();
            if (!result?.strategy && /No queued strategies remain/i.test(String(result?.message || ""))) {
              appendRunControlLog("loop reached terminal queue state.");
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        } catch (error) {
          appendRunControlLog("loop error: " + (error.message || String(error)));
        } finally {
          state.evolution.loopRunning = false;
        }
      }

      function runControlLoopStop() {
        state.evolution.loopRunning = false;
        appendRunControlLog("loop stop requested");
      }

      async function refreshEvolutionModule(full = true) {
        await loadEvolutionExperimentList(false);
        if (state.evolutionTab === "overview") {
          await loadEvolutionLight();
          await loadEvolutionHeavy();
          return;
        }
        if (state.evolutionTab === "preloop") {
          await loadPreloopQueueAndReadiness();
          return;
        }
        if (state.evolutionTab === "ontology") {
          await loadOntologyReview(false);
          return;
        }
        await loadEvolutionLight();
      }

      async function refreshModuleData(moduleName) {
        if (moduleName === "brief") await loadBrief();
        if (moduleName === "evolution") await refreshEvolutionModule(true);
        if (moduleName === "network") await loadNetworkGraph();
        if (moduleName === "behavior") await loadBehaviorChart();
        if (moduleName === "timeline") await loadTimeline();
        if (moduleName === "insights") await loadInsights();
        if (moduleName === "ops") await loadOps();
      }

      function switchModule(moduleName) {
        state.module = moduleName;
        document.querySelectorAll("[id^='module-']").forEach((el) => el.classList.add("hidden"));
        byId("module-" + moduleName).classList.remove("hidden");
        document.querySelectorAll(".nav-btn").forEach((btn) => btn.classList.toggle("active", btn.dataset.module === moduleName));
        syncAskInputMode();
        if (moduleName !== "network") clearNetworkAutoplay();
        if (moduleName === "evolution") startEvolutionPolling();
        else clearEvolutionPolling();
        refreshModuleData(moduleName).catch((err) => {
          console.error(err);
        });
      }

      document.querySelectorAll(".nav-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          if (btn.dataset.module === "network") {
            state.network.sceneMode = "default";
            state.network.sceneSeed = null;
            state.network.selectedEdgeId = "";
          }
          switchModule(btn.dataset.module);
        });
      });

      byId("askTabAnswer").addEventListener("click", () => switchAskTab("answer"));
      byId("askTabDebug").addEventListener("click", () => switchAskTab("debug"));
      byId("askShowGraphButton").addEventListener("click", async () => {
        await openAskSceneInNetwork();
      });
      byId("networkChatSend").addEventListener("click", async () => {
        await runNetworkInput(byId("networkChatInput").value || "");
        byId("networkChatInput").value = "";
      });
      byId("networkChatInput").addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        await runNetworkInput(byId("networkChatInput").value || "");
        byId("networkChatInput").value = "";
      });
      byId("networkLayoutMode").addEventListener("change", async (event) => {
        state.network.layoutMode = String(event.target.value || "radial");
        await loadNetworkGraph();
      });
      byId("networkTickMode").addEventListener("change", (event) => {
        state.network.tickMode = String(event.target.value || "week");
      });
      byId("networkStartDate").addEventListener("change", async (event) => {
        state.network.startDate = String(event.target.value || "");
        await loadNetworkGraph();
      });
      byId("networkEndDate").addEventListener("change", async (event) => {
        state.network.endDate = String(event.target.value || "");
        await loadNetworkGraph();
      });
      byId("networkToggleWeak").addEventListener("click", async () => {
        state.network.includeWeak = !state.network.includeWeak;
        byId("networkToggleWeak").textContent = state.network.includeWeak ? "Hide Weak" : "Show Weak";
        await loadNetworkGraph();
      });
      byId("networkCollapseAll").addEventListener("click", async () => {
        await runNetworkInput("collapse all");
      });
      byId("networkFitButton").addEventListener("click", () => {
        try { if (state.network.graph) state.network.graph.fit(undefined, 28); } catch {}
      });
      byId("networkPlayButton").addEventListener("click", async () => {
        await toggleNetworkAutoplay();
      });
      byId("networkSaveView").addEventListener("click", async () => {
        await saveNetworkState("view");
      });
      byId("networkSaveSnapshot").addEventListener("click", async () => {
        await saveNetworkState("snapshot");
      });
      byId("evoTabOverview").addEventListener("click", async () => {
        setEvolutionTab("overview");
        await loadEvolutionLight();
        await loadEvolutionHeavy();
      });
      byId("evoTabOntology").addEventListener("click", async () => {
        setEvolutionTab("ontology");
        await loadOntologyReview(false);
      });
      byId("evoTabPreloop").addEventListener("click", async () => {
        setEvolutionTab("preloop");
        await loadPreloopQueueAndReadiness();
      });
      byId("evoTabRunControl").addEventListener("click", async () => {
        setEvolutionTab("runcontrol");
        await loadEvolutionLight();
      });
      byId("evoUseLatest").addEventListener("click", async () => {
        await ensureEvolutionExperimentId(true);
        state.evolution.ontologyMatrixPage = 0;
        state.evolution.ontologyMatrixScrollTop = 0;
        await refreshEvolutionModule(true);
      });
      byId("evoExperimentSelect").addEventListener("change", async (event) => {
        state.evolution.experimentId = String(event.target.value || "");
        renderEvolutionExperimentPicker();
        state.evolution.ontologyMatrixPage = 0;
        state.evolution.ontologyMatrixScrollTop = 0;
        await refreshEvolutionModule(true);
      });
      byId("evoExperimentSearch").addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        await loadEvolutionExperimentList(false);
        await refreshEvolutionModule(true);
      });
      byId("evoRefreshAll").addEventListener("click", async () => {
        await loadEvolutionExperimentList(false);
        await refreshEvolutionModule(true);
      });
      byId("ontologyVersionSelect").addEventListener("change", async (event) => {
        state.evolution.ontologyVersionId = String(event.target.value || "");
        state.evolution.ontologyMatrixPage = 0;
        state.evolution.ontologyMatrixScrollTop = 0;
        await loadOntologyReview(false);
      });
      byId("ontologyUseExperimentVersion").addEventListener("click", async () => {
        const experiment = currentExperimentRecord();
        state.evolution.ontologyVersionId = String(experiment?.taxonomyVersionId || "");
        state.evolution.ontologyMatrixPage = 0;
        state.evolution.ontologyMatrixScrollTop = 0;
        await loadOntologyReview(false);
      });
      byId("ontologyRefreshButton").addEventListener("click", async () => {
        await loadOntologyReview(false);
      });
      byId("ontologyFacetTypeFilter").addEventListener("change", async () => {
        state.evolution.ontologyFacetPage = 1;
        await loadOntologyReview(false);
      });
      byId("ontologyFacetStatusFilter").addEventListener("change", async () => {
        state.evolution.ontologyFacetPage = 1;
        await loadOntologyReview(false);
      });
      byId("ontologyFacetPrevButton").addEventListener("click", async () => {
        state.evolution.ontologyFacetPage = Math.max(1, Number(state.evolution.ontologyFacetPage || 1) - 1);
        await loadOntologyReview(false);
      });
      byId("ontologyFacetNextButton").addEventListener("click", async () => {
        state.evolution.ontologyFacetPage = Number(state.evolution.ontologyFacetPage || 1) + 1;
        await loadOntologyReview(false);
      });
      byId("ontologyMatrixPrevButton").addEventListener("click", () => {
        state.evolution.ontologyMatrixPage = Math.max(0, Number(state.evolution.ontologyMatrixPage || 0) - 1);
        state.evolution.ontologyMatrixScrollTop = 0;
        renderOntologySupportMatrix();
      });
      byId("ontologyMatrixNextButton").addEventListener("click", () => {
        state.evolution.ontologyMatrixPage = Number(state.evolution.ontologyMatrixPage || 0) + 1;
        state.evolution.ontologyMatrixScrollTop = 0;
        renderOntologySupportMatrix();
      });
      byId("ontologyScanSupportButton").addEventListener("click", async () => {
        const versionId = String(state.evolution.ontologyVersionId || "");
        if (!versionId) {
          setOntologyActionMsg("No taxonomy version selected.");
          return;
        }
        setOntologyActionMsg("Running full support scan...");
        await api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/scan_support", {
          method: "POST",
          body: JSON.stringify({})
        });
        await loadOntologyReview(false);
        await loadEvolutionExperimentList(false);
        await loadEvolutionLight();
        setOntologyActionMsg("Support scan completed.");
      });
      byId("ontologyGenerateCandidatesButton").addEventListener("click", async () => {
        const versionId = String(state.evolution.ontologyVersionId || "");
        if (!versionId) {
          setOntologyActionMsg("No taxonomy version selected.");
          return;
        }
        setOntologyActionMsg("Generating ontology candidates...");
        await api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/generate_candidates", {
          method: "POST",
          body: JSON.stringify({})
        });
        await loadOntologyReview(false);
        setOntologyActionMsg("Ontology candidates refreshed.");
      });
      byId("ontologyPublishButton").addEventListener("click", async () => {
        const versionId = String(state.evolution.ontologyVersionId || "");
        if (!versionId) {
          setOntologyActionMsg("No taxonomy version selected.");
          return;
        }
        const confirmed = window.confirm("Publish a new taxonomy version from the current approved draft?");
        if (!confirmed) return;
        setOntologyActionMsg("Publishing taxonomy version...");
        const payload = await api("/v2/taxonomy/versions/" + encodeURIComponent(versionId) + "/publish", {
          method: "POST",
          body: JSON.stringify({})
        });
        state.evolution.ontologyVersionId = String(payload?.publishedVersion?.id || "");
        await loadEvolutionExperimentList(false);
        await loadOntologyReview(false);
        await loadEvolutionLight();
        setOntologyActionMsg("Published " + String(payload?.publishedVersion?.versionKey || "new taxonomy version") + ".");
      });
      byId("ontologyReseedBenchmarkButton").addEventListener("click", async () => {
        const experimentId = await ensureEvolutionExperimentId(false);
        const versionId = String(state.evolution.ontologyVersionId || "");
        if (!experimentId) {
          setOntologyActionMsg("No experiment selected.");
          return;
        }
        const confirmed = window.confirm("Regenerate the benchmark for the selected experiment using the chosen taxonomy version?");
        if (!confirmed) return;
        setOntologyActionMsg("Regenerating benchmark...");
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/reseed_from_taxonomy_version", {
          method: "POST",
          body: JSON.stringify({ taxonomyVersionId: versionId || undefined })
        });
        await loadEvolutionExperimentList(false);
        await refreshEvolutionModule(true);
        setOntologyActionMsg("Benchmark regenerated.");
      });
      byId("ontologyRebuildCalibrationButton").addEventListener("click", async () => {
        setOntologyActionMsg("Rebuilding calibration queue...");
        await rebuildOntologyCalibrationQueue();
      });
      byId("ontologyExportButton").addEventListener("click", async () => {
        await exportOntologyReview();
      });
      ["ontologyCandidateTypeFilter", "ontologyCandidateStatusFilter"].forEach((id) => {
        byId(id).addEventListener("change", () => {
          renderOntologyCandidates();
        });
      });
      byId("ontologyCandidateSearch").addEventListener("input", () => {
        renderOntologyCandidates();
      });
      byId("ontologyBatchApproveButton").addEventListener("click", async () => {
        const ids = (state.evolution.ontologyFilteredCandidates || []).map((item) => String(item.id || "")).filter(Boolean);
        if (ids.length === 0) {
          setOntologyActionMsg("No visible candidates to approve.");
          return;
        }
        const targetKey = (window.prompt("Optional target key for merge-into / split-from actions:", "") || "").trim();
        setOntologyActionMsg("Approving " + ids.length + " visible candidates...");
        await reviewOntologyCandidatesBatch(ids, "approved", targetKey);
        await loadOntologyReview(false);
        setOntologyActionMsg("Approved " + ids.length + " visible candidates.");
      });
      byId("ontologyBatchRejectButton").addEventListener("click", async () => {
        const ids = (state.evolution.ontologyFilteredCandidates || []).map((item) => String(item.id || "")).filter(Boolean);
        if (ids.length === 0) {
          setOntologyActionMsg("No visible candidates to reject.");
          return;
        }
        setOntologyActionMsg("Rejecting " + ids.length + " visible candidates...");
        await reviewOntologyCandidatesBatch(ids, "rejected");
        await loadOntologyReview(false);
        setOntologyActionMsg("Rejected " + ids.length + " visible candidates.");
      });
      byId("ontologyBatchDeferButton").addEventListener("click", async () => {
        const ids = (state.evolution.ontologyFilteredCandidates || []).map((item) => String(item.id || "")).filter(Boolean);
        if (ids.length === 0) {
          setOntologyActionMsg("No visible candidates to defer.");
          return;
        }
        setOntologyActionMsg("Deferring " + ids.length + " visible candidates...");
        await reviewOntologyCandidatesBatch(ids, "deferred");
        await loadOntologyReview(false);
        setOntologyActionMsg("Deferred " + ids.length + " visible candidates.");
      });
      byId("preloopStatusFilter").addEventListener("change", async () => {
        state.evolution.selectedQueueIndex = 0;
        state.evolution.selectedQueueItemId = "";
        state.evolution.preloopDraft.dirty = false;
        await loadPreloopQueueAndReadiness();
      });
      byId("preloopVerdictFilter").addEventListener("change", async () => {
        state.evolution.selectedQueueIndex = 0;
        state.evolution.selectedQueueItemId = "";
        state.evolution.preloopDraft.dirty = false;
        await loadPreloopQueueAndReadiness();
      });
      ["preloopDomainFilter", "preloopAmbiguityFilter", "preloopCaseSetFilter"].forEach((id) => {
        byId(id).addEventListener("change", () => {
          state.evolution.selectedQueueIndex = 0;
          state.evolution.selectedQueueItemId = "";
          renderPreloopQueue();
        });
      });
      ["preloopVerdictYes", "preloopVerdictNo"].forEach((id) => {
        byId(id).addEventListener("click", (event) => {
          const draft = state.evolution.preloopDraft;
          draft.verdict = String(event.currentTarget.dataset.value || "yes");
          draft.dirty = true;
          state.evolution.verdict = draft.verdict;
          setPreloopButtonGroup("preloopVerdictGroup", draft.verdict);
        });
      });
      ["preloopAmbiguityClear", "preloopAmbiguityClarify", "preloopAmbiguityUnresolved"].forEach((id) => {
        byId(id).addEventListener("click", (event) => {
          const draft = state.evolution.preloopDraft;
          draft.ambiguityClass = String(event.currentTarget.dataset.value || "clear");
          draft.dirty = true;
          state.evolution.ambiguityClass = draft.ambiguityClass;
          setPreloopButtonGroup("preloopAmbiguityGroup", draft.ambiguityClass);
        });
      });
      byId("preloopNotes").addEventListener("input", (event) => {
        const draft = state.evolution.preloopDraft;
        draft.notes = String(event.target.value || "");
        draft.dirty = true;
      });
      byId("preloopGenerateSample").addEventListener("click", async () => {
        await generatePreloopSample();
      });
      byId("preloopAutoReview").addEventListener("click", async () => {
        await generatePreloopAiSuggestions();
      });
      byId("preloopSaveNext").addEventListener("click", async () => {
        await submitPreloopDecisionSaveNext();
      });
      byId("runControlLockBenchmark").addEventListener("click", async () => {
        await preloopLockBenchmark();
      });
      byId("runControlLockStage").addEventListener("change", () => {
        if (state.evolution.activeReadiness) {
          renderPreloopReadiness(state.evolution.activeReadiness, state.evolution.activePreloopReport || {});
        }
      });
      byId("runControlStartLoop").addEventListener("click", async () => {
        await runControlLoopStart();
      });
      byId("runControlRunStep").addEventListener("click", async () => {
        await runControlSingleStep();
      });
      byId("runControlStopLoop").addEventListener("click", () => {
        runControlLoopStop();
      });

      async function doLogin(event) {
        if (event) {
          event.preventDefault();
        }
        if (state.loginInProgress) return;
        loginError.textContent = "";
        const password = String(byId("passwordInput").value || "").trim();
        if (!password) {
          loginError.textContent = "Password is required.";
          return;
        }
        state.loginInProgress = true;
        try {
          const payload = await api("/v1/auth/login", {
            method: "POST",
            body: JSON.stringify({ password })
          }, false);
          const token = String(payload?.token || "").trim();
          if (!token) {
            throw new Error("Login returned no token.");
          }
          setSessionToken(token);
          showApp();
          const bootstrapErrorHint = "Your session was created, but some dashboard data did not load. You can continue after retrying sections.";
          const bootstrapTasks = [
            loadPrivacyMode(),
            refreshModuleData("brief"),
            ensureEvolutionExperimentId(true)
          ].map((task) =>
            task.catch((error) => {
              console.error("Login bootstrap step failed:", error);
              loginError.textContent = bootstrapErrorHint;
              return null;
            })
          );
          await Promise.allSettled(bootstrapTasks);
          byId("passwordInput").value = "";
        } catch (error) {
          showLogin();
          loginError.textContent = error.message || "Login failed";
        } finally {
          state.loginInProgress = false;
        }
      }

      byId("loginForm").addEventListener("submit", doLogin);
      byId("passwordInput").addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        void doLogin(event);
      });

      byId("askButton").addEventListener("click", async () => {
        if (state.askLoading) return;
        const question = byId("globalQuestion").value.trim();
        if (!question) return;
        byId("askChatInput").value = question;
        byId("globalQuestion").value = "";
        if (state.module !== "ask") switchModule("ask");
        appendChatBubble("user", question);
        state.pendingQuestion = question;
        state.awaitingClarification = false;
        byId("askChatInput").value = "";
        await ask(question, null);
      });

      byId("globalQuestion").addEventListener("keydown", async (event) => {
        if (state.askLoading) return;
        if (event.key !== "Enter") return;
        event.preventDefault();
        const question = byId("globalQuestion").value.trim();
        if (!question) return;
        byId("askChatInput").value = question;
        byId("globalQuestion").value = "";
        if (state.module !== "ask") switchModule("ask");
        appendChatBubble("user", question);
        state.pendingQuestion = question;
        state.awaitingClarification = false;
        byId("askChatInput").value = "";
        await ask(question, null);
      });

      byId("askChatSend").addEventListener("click", async () => {
        if (state.askLoading) return;
        const value = byId("askChatInput").value.trim();
        if (!value) return;
        if (state.module !== "ask") switchModule("ask");
        appendChatBubble("user", value);
        byId("askChatInput").value = "";
        if (state.awaitingClarification && state.pendingQuestion) {
          await ask(state.pendingQuestion, value);
          return;
        }
        state.pendingQuestion = value;
        state.awaitingClarification = false;
        await ask(value, null);
      });

      byId("askChatInput").addEventListener("keydown", async (event) => {
        if (state.askLoading) return;
        if (event.key !== "Enter") return;
        event.preventDefault();
        byId("askChatSend").click();
      });

      privacySelect.addEventListener("change", async () => {
        const mode = privacySelect.value;
        await api("/v1/privacy/mode", { method: "POST", body: JSON.stringify({ mode }) });
        state.privacyMode = mode;
        setModeBadge();
        await refreshModuleData(state.module);
      });

      timeframeSelect.addEventListener("change", async () => {
        state.timeframe = timeframeSelect.value;
        await refreshModuleData(state.module);
      });

      byId("lockButton").addEventListener("click", async () => {
        if (state.token) {
          try { await api("/v1/auth/logout", { method: "POST" }); } catch {}
        }
        showLogin();
      });

      byId("logoutButton").addEventListener("click", async () => {
        if (state.token) {
          try { await api("/v1/auth/logout", { method: "POST" }); } catch {}
        }
        showLogin();
      });

      byId("rotatePasswordButton").addEventListener("click", async () => {
        const currentPassword = byId("currentPasswordInput").value;
        const newPassword = byId("newPasswordInput").value;
        const resultEl = byId("rotatePasswordResult");
        resultEl.textContent = "";
        try {
          await api("/v1/auth/rotate", {
            method: "POST",
            body: JSON.stringify({ currentPassword, newPassword })
          });
          resultEl.textContent = "Password updated.";
        } catch (error) {
          resultEl.textContent = error.message || "Failed to rotate password.";
        }
      });

      byId("pruneOpsButton").addEventListener("click", async () => {
        await api("/v1/brain/jobs/prune", {
          method: "POST",
          body: JSON.stringify({ days: 60 })
        });
        await loadOps();
      });

      document.addEventListener("visibilitychange", () => {
        if (state.module !== "evolution") return;
        if (document.hidden) {
          clearEvolutionPolling();
        } else {
          startEvolutionPolling();
          refreshEvolutionModule(false).catch((err) => console.error(err));
        }
      });

      window.addEventListener("resize", () => resizeVisuals());
      syncAskInputMode();

      const restoredToken = restoreStoredSessionToken();
      if (restoredToken) {
        setSessionToken(restoredToken);
        const restoredAuth = getAuthSnapshot();
        showApp();
        api("/v1/auth/session", { method: "GET" })
          .then(() => (isAuthSnapshotCurrent(restoredAuth) ? loadPrivacyMode() : null))
          .then(() => (isAuthSnapshotCurrent(restoredAuth) ? refreshModuleData("brief") : null))
          .then(() => (isAuthSnapshotCurrent(restoredAuth) ? ensureEvolutionExperimentId(true).catch(() => "") : null))
          .catch((error) => {
            if (!isAuthSnapshotCurrent(restoredAuth)) return;
            loginError.textContent = error?.message || "Session expired. Please log in again.";
            showLogin();
          });
      }
    })();
  </script>
</body>
</html>`;
}

