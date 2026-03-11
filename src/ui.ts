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
    .ask-answer { white-space: pre-wrap; line-height: 1.45; }
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
        <button class="nav-btn" data-module="people">People</button>
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
                  <div id="preloopReadinessBar" class="muted">Readiness: not loaded.</div>
                </div>
              </div>

              <div id="evoPanelRunControl" class="panel hidden">
                <h3>Run Control</h3>
                <div id="runControlSummary" class="muted">No experiment selected.</div>
                <div class="runctl-actions" style="margin-top:8px;">
                  <button id="runControlLockBenchmark" type="button" disabled>Lock Benchmark</button>
                  <button id="runControlStartLoop" type="button" disabled>Start Loop</button>
                  <button id="runControlRunStep" type="button">Run Single Step</button>
                  <button id="runControlStopLoop" type="button">Stop Loop</button>
                </div>
                <div id="runControlLog" class="runctl-log">Waiting.</div>
              </div>
            </div>
          </section>

          <section id="module-people" class="hidden">
            <div class="panel people-panel">
              <h3>Relationship Network</h3>
              <div id="peopleGraph" class="graph"></div>
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
      const state = {
        token: "",
        chatNamespace: "personal.main",
        privacyMode: "private",
        timeframe: "30d",
        module: "brief",
        askTab: "answer",
        askLoading: false,
        lastAnswerRunId: "",
        pendingQuestion: "",
        awaitingClarification: false,
        briefChart: null,
        behaviorChart: null,
        graph: null,
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
          activeReadiness: null,
          verdict: "yes",
          ambiguityClass: "clear",
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

      async function api(path, options = {}, requiresSession = true) {
        const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
        if (requiresSession && state.token) {
          headers.Authorization = "Bearer " + state.token;
        }
        const response = await fetch(path, { ...options, headers });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
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
        try { if (state.graph) { state.graph.resize(); state.graph.fit(undefined, 26); } } catch {}
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
      }

      function showLogin() {
        state.token = "";
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

      async function loadPeopleGraph() {
        const payload = await api("/v2/brain/search/graph", {
          method: "POST",
          body: JSON.stringify({
            chatNamespace: state.chatNamespace,
            limit: 180
          })
        });
        const el = byId("peopleGraph");
        if (state.graph) state.graph.destroy();
        state.graph = cytoscape({
          container: el,
          elements: [
            ...payload.graph.nodes.map((n) => ({ data: { id: n.id, label: n.label, value: n.value } })),
            ...payload.graph.edges.map((e) => ({ data: { id: e.id, source: e.source, target: e.target, weight: e.weight } }))
          ],
          style: [
            {
              selector: "node",
              style: {
                "background-color": "#46c0ff",
                label: "data(label)",
                color: "#dce9f8",
                "font-size": 11,
                "text-wrap": "wrap",
                "text-max-width": 88,
                "text-outline-color": "#081627",
                "text-outline-width": 2
              }
            },
            { selector: "edge", style: { "line-color": "#2f5a84", width: "mapData(weight, 1, 30, 1, 9)", opacity: 0.72 } }
          ],
          layout: { name: "cose", animate: false, nodeRepulsion: 11000, idealEdgeLength: 120, gravity: 0.8 }
        });
        state.graph.fit(undefined, 30);
        resizeVisuals();
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
        const intentSummary = answerPayload.intentSummary ? String(answerPayload.intentSummary) : "No intent summary.";
        const checks = Array.isArray(answerPayload.constraintChecks) ? answerPayload.constraintChecks : [];
        const assumptions = Array.isArray(answerPayload.assumptionsUsed) ? answerPayload.assumptionsUsed : [];

        const blocks = [
          "Decision: " + decision,
          "Status: " + status,
          "Intent: " + intentSummary
        ];
        if (decision === "clarify_first") {
          blocks.push("Clarification needed: " + String(answerPayload.clarificationQuestion || "Please clarify scope."));
        } else if (finalAnswer) {
          blocks.push("Direct: " + String(finalAnswer.direct || "No definitive direct value found."));
          if (finalAnswer.estimate) blocks.push("Estimate: " + String(finalAnswer.estimate));
          if (finalAnswer.contradictionCallout) blocks.push("Contradictions: " + String(finalAnswer.contradictionCallout));
          blocks.push("Confidence: " + String(finalAnswer.confidence || "low"));
          blocks.push("Definitive next data: " + String(finalAnswer.definitiveNextData || "Provide explicit timestamped evidence."));
        }
        if (assumptions.length > 0) {
          blocks.push("Assumptions: " + assumptions.map((a) => String(a)).join(" | "));
        }
        if (checks.length > 0) {
          const lines = checks.slice(0, 6).map((c) => {
            const ok = c && c.passed ? "pass" : "fail";
            return "[" + ok + "] " + String(c?.name || "check") + " - " + String(c?.note || "");
          });
          blocks.push("Constraint checks: " + lines.join(" | "));
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
            loadPreloopQueueAndReadiness().catch((err) => console.error(err));
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
          evolutionKpiCard("Active Lock", String(exp.activeLockVersion || "none")),
          evolutionKpiCard("Current Variant", String(k.currentVariantId || "n/a")),
          evolutionKpiCard("Best Variant", String(k.bestVariantId || "n/a")),
          evolutionKpiCard("Best Pass", (Number(k.bestPassRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Clear Pass", (Number(k.clearPassRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Clarify Pass", (Number(k.clarifyPassRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Unresolved Debt", (Number(k.unresolvedAmbiguousRatio || 0) * 100).toFixed(2) + "%", k.unresolvedDebtPass ? "within limit" : "above limit"),
          evolutionKpiCard("Queue / Running", String(Number(k.queuedCount || 0)) + " / " + String(Number(k.runningCount || 0))),
          evolutionKpiCard("Completed / Failed", String(Number(k.completedCount || 0)) + " / " + String(Number(k.failedCount || 0))),
          evolutionKpiCard("Authoring Accepted", String(Number(k.authoringAcceptedCount || 0))),
          evolutionKpiCard("Authoring Rejected", String(Number(k.authoringRejectedCount || 0))),
          evolutionKpiCard("Authoring Unresolved", String(Number(k.authoringUnresolvedCount || 0))),
          evolutionKpiCard("Verifier Pass", (Number(k.verifierPassRate || 0) * 100).toFixed(1) + "%"),
          evolutionKpiCard("Calibration Eligible", String(Number(k.calibrationEligibleCount || 0))),
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
                "Pass: " + (Number(d.passRate || 0) * 100).toFixed(2) + "%",
                "Latency x: " + Number(d.latencyMultiplier || 0).toFixed(2),
                "Cost x: " + Number(d.costMultiplier || 0).toFixed(2),
                "Group: " + String(d.groupId || "n/a")
              ].join("<br/>");
            }
          },
          xAxis: { type: "value", name: "Latency Multiplier", axisLabel: { color: "#9eb3cb" } },
          yAxis: { type: "value", name: "Pass Rate", min: 0, max: 1, axisLabel: { color: "#9eb3cb" } },
          grid: { left: 60, right: 20, top: 30, bottom: 40 },
          series: [{
            type: "scatter",
            symbolSize: 12,
            data: points.map((p) => ({
              value: [Number(p.latencyMultiplier || 0), Number(p.passRate || 0)],
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
            + "Pass: " + (Number(d.passRate || 0) * 100).toFixed(2) + "%<br/>"
            + "Latency P95: " + Number(d.latencyP95Ms || 0).toFixed(1) + " ms<br/>"
            + "Cost/1k: $" + Number(d.costPer1k || 0).toFixed(4) + "<br/>"
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
          + " | lock " + String(overview?.experiment?.activeLockVersion || "none");
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
        const [pendingPayload, reportPayload, readinessPayload] = await Promise.all([
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/pending?limit=200", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/report", { method: "GET" }),
          api("/v2/experiments/" + encodeURIComponent(experimentId) + "/preloop/readiness", { method: "GET" })
        ]);
        const queue = Array.isArray(pendingPayload?.pending) ? pendingPayload.pending : [];
        state.evolution.queue = queue;
        state.evolution.activeReadiness = readinessPayload;
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

      function renderPreloopQueue() {
        const filtered = currentFilteredQueue();
        if (filtered.length === 0) {
          state.evolution.selectedQueueIndex = -1;
          byId("preloopQueueList").innerHTML = '<div class="muted">No pending items in this filter.</div>';
          renderPreloopSelectedCase(null);
          return;
        }
        if (state.evolution.selectedQueueIndex < 0 || state.evolution.selectedQueueIndex >= filtered.length) {
          state.evolution.selectedQueueIndex = 0;
        }
        byId("preloopQueueList").innerHTML = filtered.map((item, idx) => {
          const active = idx === state.evolution.selectedQueueIndex ? " active" : "";
          const ambiguity = String(item?.ambiguityClass || "n/a");
          const owner = String(item?.ownerValidationState || "n/a");
          const preview = String(item.question || "").slice(0, 90);
          return '<div class="preloop-item' + active + '" data-preloop-index="' + idx + '">'
            + '<div><b>' + escapeHtml(String(item.domain || "case").replaceAll("_", " ")) + "</b></div>"
            + '<div class="muted">' + escapeHtml(String(item.caseSet || "n/a") + " | " + ambiguity + " | " + owner) + "</div>"
            + '<div>' + escapeHtml(preview) + "</div>"
            + "</div>";
        }).join("");
        byId("preloopQueueList").querySelectorAll(".preloop-item").forEach((el) => {
          el.addEventListener("click", () => {
            const idx = Number(el.dataset.preloopIndex || "0");
            state.evolution.selectedQueueIndex = Number.isFinite(idx) ? idx : 0;
            renderPreloopQueue();
          });
        });
        renderPreloopSelectedCase(filtered[state.evolution.selectedQueueIndex] || null);
      }

      function renderPreloopSelectedCase(item) {
        if (!item) {
          const emptyText = '<div class="muted">No pending item in this filter. Change filters or generate a new sample.</div>';
          byId("preloopCaseMeta").textContent = "No case selected.";
          byId("preloopQuestionText").innerHTML = emptyText;
          byId("preloopExpectedBehavior").innerHTML = '<div class="muted">Nothing to review yet.</div>';
          byId("preloopSemanticFrame").innerHTML = emptyText;
          byId("preloopClarificationPath").innerHTML = emptyText;
          byId("preloopExpectedAnswer").innerHTML = emptyText;
          byId("preloopEvidencePreview").innerHTML = emptyText;
          byId("preloopAdmission").innerHTML = emptyText;
          byId("preloopQualityGate").innerHTML = emptyText;
          return;
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
            + '<div style="margin-top:6px;">' + escapeHtml(String(ev.snippet || "")) + '</div>'
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
        state.evolution.verdict = "yes";
        state.evolution.ambiguityClass = String(item?.ambiguityClass || "clear");
        setPreloopButtonGroup("preloopVerdictGroup", state.evolution.verdict);
        setPreloopButtonGroup("preloopAmbiguityGroup", state.evolution.ambiguityClass);
      }

      function renderPreloopReadiness(readinessPayload, reportPayload) {
        const gates = readinessPayload?.gates || {};
        const metrics = readinessPayload?.metrics || {};
        const queueCounts = readinessPayload?.queueCounts || {};
        const datasetCounts = readinessPayload?.datasetCounts || {};
        const authoringCounts = readinessPayload?.authoringCounts || {};
        const lockCounts = readinessPayload?.lockEligibilityCounts || {};
        const statusCounts = reportPayload?.statusCounts || {};
        const verdictCounts = reportPayload?.verdictCounts || {};
        const lockReady = Boolean(gates.readyForLock);
        const startReady = Boolean(gates.readyForStart);
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
        byId("preloopReadinessBar").innerHTML =
          "Clear " + (Number(metrics.clearPassRate || 0) * 100).toFixed(2) + "% (target 99%)"
          + " | Clarify " + (Number(metrics.clarifyPassRate || 0) * 100).toFixed(2) + "% (target 99%)"
          + " | Debt " + (Number(metrics.unresolvedAmbiguousRatio || 0) * 100).toFixed(2) + "% (max 1%)"
          + " | Verifier " + (Number(metrics.verifierPassRate || 0) * 100).toFixed(2) + "%"
          + " | calibration eligible " + Number(lockCounts.calibrationEligible || 0)
          + " | pending owner " + Number(lockCounts.pendingOwner || 0)
          + " | pending queue " + Number(statusCounts.pending || 0)
          + " | labels yes/no " + Number(verdictCounts.yes || 0) + "/" + Number(verdictCounts.no || 0);
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
        const experimentId = await ensureEvolutionExperimentId(false);
        const payload = {
          calibrationItemId: String(item.calibrationItemId || ""),
          verdict: String(state.evolution.verdict || "yes"),
          ambiguityClass: String(state.evolution.ambiguityClass || "clear"),
          notes: String(byId("preloopNotes").value || "").trim() || undefined
        };
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/calibration/label", {
          method: "POST",
          body: JSON.stringify(payload)
        });
        byId("preloopNotes").value = "";
        byId("preloopActionMsg").textContent = "Saved " + payload.calibrationItemId + ".";
        const nextIdx = idx;
        await loadPreloopQueueAndReadiness();
        if (state.evolution.filteredQueue.length > 0) {
          state.evolution.selectedQueueIndex = Math.min(nextIdx, state.evolution.filteredQueue.length - 1);
          renderPreloopQueue();
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

      async function preloopLockBenchmark() {
        const experimentId = await ensureEvolutionExperimentId(false);
        await api("/v2/experiments/" + encodeURIComponent(experimentId) + "/benchmark/lock", {
          method: "POST",
          body: JSON.stringify({})
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
        await loadEvolutionLight();
        if (full || state.evolutionTab === "overview") await loadEvolutionHeavy();
        await loadPreloopQueueAndReadiness();
        if (full || state.evolutionTab === "ontology") await loadOntologyReview(false);
      }

      async function refreshModuleData(moduleName) {
        if (moduleName === "brief") await loadBrief();
        if (moduleName === "evolution") await refreshEvolutionModule(true);
        if (moduleName === "people") await loadPeopleGraph();
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
        if (moduleName === "evolution") startEvolutionPolling();
        else clearEvolutionPolling();
        refreshModuleData(moduleName).catch((err) => {
          console.error(err);
        });
      }

      document.querySelectorAll(".nav-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchModule(btn.dataset.module));
      });

      byId("askTabAnswer").addEventListener("click", () => switchAskTab("answer"));
      byId("askTabDebug").addEventListener("click", () => switchAskTab("debug"));
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
      ["preloopDomainFilter", "preloopAmbiguityFilter", "preloopCaseSetFilter"].forEach((id) => {
        byId(id).addEventListener("change", () => {
          state.evolution.selectedQueueIndex = 0;
          renderPreloopQueue();
        });
      });
      ["preloopVerdictYes", "preloopVerdictNo"].forEach((id) => {
        byId(id).addEventListener("click", (event) => {
          state.evolution.verdict = String(event.currentTarget.dataset.value || "yes");
          setPreloopButtonGroup("preloopVerdictGroup", state.evolution.verdict);
        });
      });
      ["preloopAmbiguityClear", "preloopAmbiguityClarify", "preloopAmbiguityUnresolved"].forEach((id) => {
        byId(id).addEventListener("click", (event) => {
          state.evolution.ambiguityClass = String(event.currentTarget.dataset.value || "clear");
          setPreloopButtonGroup("preloopAmbiguityGroup", state.evolution.ambiguityClass);
        });
      });
      byId("preloopGenerateSample").addEventListener("click", async () => {
        await generatePreloopSample();
      });
      byId("preloopSaveNext").addEventListener("click", async () => {
        await submitPreloopDecisionSaveNext();
      });
      byId("runControlLockBenchmark").addEventListener("click", async () => {
        await preloopLockBenchmark();
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

      byId("loginForm").addEventListener("submit", async (event) => {
        event.preventDefault();
        loginError.textContent = "";
        try {
          const payload = await api("/v1/auth/login", {
            method: "POST",
            body: JSON.stringify({ password: byId("passwordInput").value })
          }, false);
          state.token = payload.token;
          showApp();
          await loadPrivacyMode();
          await refreshModuleData("brief");
          await ensureEvolutionExperimentId(true).catch(() => "");
        } catch (error) {
          loginError.textContent = error.message || "Login failed";
        }
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
    })();
  </script>
</body>
</html>`;
}

