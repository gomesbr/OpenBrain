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
      grid-template-columns: 1fr auto auto auto auto;
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
    .evidence {
      margin-top: 8px;
      border-top: 1px dashed var(--line);
      padding-top: 8px;
    }
    details { border: 1px solid var(--line); border-radius: 8px; padding: 8px; }
    summary { cursor: pointer; color: var(--accent); }
    @media (max-width: 960px) {
      .layout { grid-template-columns: 1fr; }
      .rail { border-right: 0; border-bottom: 1px solid var(--line); }
      .topbar { grid-template-columns: 1fr 1fr; }
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
            <div class="panel">
              <h3>Ask Workspace</h3>
              <div class="ask-answer" id="askAnswer">Ask a question to generate a response with evidence-on-demand.</div>
              <details class="evidence">
                <summary>Evidence</summary>
                <div id="askEvidence" class="muted">No evidence yet.</div>
              </details>
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
        briefChart: null,
        behaviorChart: null,
        graph: null
      };

      const byId = (id) => document.getElementById(id);
      const loginPage = byId("loginPage");
      const appPage = byId("appPage");
      const loginError = byId("loginError");
      const modeBadge = byId("modeBadge");
      const privacySelect = byId("privacyModeSelect");
      const timeframeSelect = byId("timeframeSelect");

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
        const payload = await api("/v1/brain/graph?chatNamespace=" + encodeURIComponent(state.chatNamespace) + "&graphType=relationships");
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

      async function ask(question) {
        const payload = await api("/v1/brain/query", {
          method: "POST",
          body: JSON.stringify({
            question,
            timeframe: state.timeframe,
            privacyMode: state.privacyMode,
            chatNamespace: state.chatNamespace
          })
        });
        byId("askAnswer").textContent = payload.answer || "";
        const refs = Array.isArray(payload.evidenceRefs) ? payload.evidenceRefs : [];
        byId("askEvidence").innerHTML = refs.length === 0
          ? "No evidence."
          : refs.map((r) => \`<div style="padding:6px 0;border-bottom:1px dashed #1f3b60;">[\${Math.round((r.similarity || 0) * 100)}%] \${r.excerpt}</div>\`).join("");
        switchModule("ask");
      }

      async function refreshModuleData(moduleName) {
        if (moduleName === "brief") await loadBrief();
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
        refreshModuleData(moduleName).catch((err) => {
          console.error(err);
        });
      }

      document.querySelectorAll(".nav-btn").forEach((btn) => {
        btn.addEventListener("click", () => switchModule(btn.dataset.module));
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
        } catch (error) {
          loginError.textContent = error.message || "Login failed";
        }
      });

      byId("askButton").addEventListener("click", async () => {
        const question = byId("globalQuestion").value.trim();
        if (!question) return;
        await ask(question);
      });

      byId("globalQuestion").addEventListener("keydown", async (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        const question = byId("globalQuestion").value.trim();
        if (!question) return;
        await ask(question);
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

      window.addEventListener("resize", () => resizeVisuals());
    })();
  </script>
</body>
</html>`;
}

