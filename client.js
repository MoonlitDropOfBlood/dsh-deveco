/**
 * dsh-deveco — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Registers:
 *   1. A `HarmonyOS Suite` single-instance tab in better-sidebar (HiLog
 *      streaming + ArkUI Inspector + project browser).
 *   2. An `ArkTS / TypeScript` file viewer for `.ets` files (preferred over
 *      the built-in text editor via higher priority).
 *   3. A plugin-configuration card under Settings → 插件 → 配置
 *      (`settings.plugin.item`, keyed `harmony-deveco`) for managing DevEco
 *      Studio / Command Line Tools paths with three-platform auto-discovery
 *      and the studio↔clt mutual exclusion rule. No extra sidebar/settings
 *      nav entry is added.
 *
 * Host communication goes through the `harmonyDevEco` Remote namespace
 * (`ctx.get('remote.harmonyDevEco').{getConfig, getSettingsNamespace, rescan,
 * deviceList, hilog*, ui*, ...}`), published by the Host half in `index.js`.
 * Path writes use the official settings transport (`ctx.settingsScope`), not a
 * custom Remote method.
 *
 * IMPORTANT: every React component below is defined once at bundle scope so
 * its function identity is stable across parent re-renders. Inline component
 * creation wipes local input state on each parent re-render.
 */
window.__ModuleLoader__.load({
  id: "@duke-dsh-plugins/dsh-deveco",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ---- CSS (package-owned, mirrors DSH design tokens) ------------------
    const CSS = `
.harm-page{max-width:760px;width:100%;box-sizing:border-box;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px}
.harm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.harm-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.harm-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
.harm-tabs{display:inline-flex;gap:4px;padding:3px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-self:flex-start}
.harm-tab{box-sizing:border-box;height:26px;font:inherit;font-size:12px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:0 14px;line-height:26px}
.harm-tab-active{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.harm-input{box-sizing:border-box;height:30px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none;min-width:280px;flex:1}
.harm-input:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.harm-btn{box-sizing:border-box;height:30px;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 14px;white-space:nowrap}
.harm-btn:hover{border-color:var(--dsw-alias-border-l1)}
.harm-btn:disabled{opacity:.5;cursor:not-allowed}
.harm-btn-primary{background:var(--dsw-alias-button-info-fill,#4a7dff);border-color:transparent;color:#fff}
.harm-btn-primary:hover{background:var(--dsw-alias-button-info-hover,#3d6cd9);border-color:transparent}
.harm-btn-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.harm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.harm-field{display:flex;flex-direction:column;gap:5px;flex:1;min-width:240px}
.harm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.harm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.harm-banner{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.harm-banner-warn{background:rgba(245,185,66,.08);border-color:rgba(245,185,66,.3);color:var(--dsw-alias-state-warn-primary,#f5b942)}
.harm-badge{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;font-size:12px;line-height:22px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500}
.harm-badge-ok{background:var(--dsw-alias-state-success-primary,#2fb37d);color:#fff;border-color:transparent}
.harm-badge-warn{background:var(--dsw-alias-state-warn-primary,#f5b942);color:#fff;border-color:transparent}
.harm-badge-err{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;border-color:transparent}
.harm-chip{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 10px;border-radius:6px;font-size:11px;font-weight:600;line-height:24px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);user-select:none}
.harm-chip-on{background:var(--dsw-alias-brand-primary,#4a7dff);border-color:transparent;color:#fff}
.harm-scroll{overflow-y:auto;max-height:50vh;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.harm-log-line{padding:6px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:flex-start}
.harm-log-line:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06))}
.harm-log-level{flex:none;display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:24px;padding:0 6px;border-radius:4px;font-size:10px;font-weight:700;color:#fff}
.harm-level-D{background:#888}.harm-level-I{background:#4a7dff}.harm-level-W{background:#f5b942;color:#000}.harm-level-E{background:#e5484d}.harm-level-F{background:#a020f0}
.harm-log-pid{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:48px}
.harm-log-tag{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;min-width:80px}
.harm-log-msg{flex:1;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap;min-width:0}
.harm-log-raw{flex:1;color:var(--dsw-alias-label-tertiary);font-style:italic;word-break:break-word}
.harm-tree{display:flex;flex-direction:column;gap:2px;overflow-y:auto;max-height:50vh;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1)}
.harm-tree-node{padding:5px 7px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-radius:5px;cursor:pointer;line-height:18px;color:var(--dsw-alias-label-primary);border:1px solid transparent;display:flex;gap:8px;align-items:baseline}
.harm-tree-node:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.harm-tree-node.selected{background:rgba(74,125,255,.15);border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.harm-tree-idx{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;min-width:28px;text-align:right}
.harm-tree-class{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.harm-tree-text{flex:none;color:var(--dsw-alias-label-primary)}
.harm-tree-rid{flex:none;color:var(--dsw-alias-brand-primary,#4a7dff);font-size:11px}
.harm-tree-bounds{flex:1;color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:right;margin-left:auto}
.harm-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:32px 16px;font-size:13px;line-height:20px}
.harm-error{padding:8px 14px;border-radius:8px;background:rgba(229,72,77,.08);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px}
.harm-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px 0}
.harm-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:harm-spin .8s linear infinite;flex:none}
@keyframes harm-spin{to{transform:rotate(360deg)}}
.harm-split{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}
.harm-list{display:flex;flex-direction:column;gap:6px}
.harm-list-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px}
.harm-list-item-path{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);word-break:break-all;min-width:0}
.harm-list-item-ver{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}

/* Settings nav icon: replace fallback gear with HarmonyOS-globe via currentColor mask */
[data-dsh-deveco-settings-nav]>svg:first-child{display:none}
[data-dsh-deveco-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M2 12h20'/%3E%3Cpath d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Ccircle cx='12' cy='12' r='10'/%3E%3Cpath d='M2 12h20'/%3E%3Cpath d='M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'/%3E%3C/svg%3E") center/contain no-repeat}

/* ArkTS syntax highlight */
.ark-line{display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;padding:0 8px;white-space:pre}
.ark-line:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.04))}
.ark-lineno{flex:none;width:52px;color:var(--dsw-alias-label-tertiary);text-align:right;padding-right:14px;user-select:none;font-size:11px}
.ark-code{flex:1;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0}
.ark-kw{color:#c586c0;font-weight:600}.ark-str{color:#ce9178}.ark-num{color:#b5cea8}.ark-com{color:#6a9955;font-style:italic}.ark-deco{color:#dcdcaa}.ark-type{color:#4ec9b0}
.ark-meta{color:var(--dsw-alias-label-secondary);font-size:11px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
`;

    // ---- Settings nav icon (mirror of dsh-memory-manager pattern) ---------
    const SETTINGS_LABEL = "HarmonyOS Suite";
    const SETTINGS_NAV_MARKER = "data-dsh-deveco-settings-nav";

    function registerSettingsNavIcon(label) {
      let disposed = false;
      const sync = function () {
        if (disposed) return;
        const currentLabel = String(label).trim();
        const buttons = document.querySelectorAll('[role="dialog"] nav button');
        for (let i = 0; i < buttons.length; i++) {
          const button = buttons[i];
          const text = button.textContent ? button.textContent.trim() : "";
          if (currentLabel.length > 0 && text === currentLabel) {
            button.setAttribute(SETTINGS_NAV_MARKER, "");
          } else {
            button.removeAttribute(SETTINGS_NAV_MARKER);
          }
        }
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      return function () {
        disposed = true;
        observer.disconnect();
        const marked = document.querySelectorAll("[" + SETTINGS_NAV_MARKER + "]");
        for (let i = 0; i < marked.length; i++) marked[i].removeAttribute(SETTINGS_NAV_MARKER);
      };
    }

    // ---- Client Remote namespace self-mount ------------------------------
    const passthrough = () => ({ parse: (v) => v });
    const method = (m, params) => ({
      id: "dsh-deveco#harmonyDevEco/" + m,
      service: "harmonyDevEco",
      namespace: "harmonyDevEco",
      method: m,
      invocation: { kind: "direct" },
      parameters: (params || []).map((name) => ({
        name,
        wire: name,
        source: "json",
        codec: { mode: "strict", typeSymbol: "dsh-deveco#HarmonyDevEco" + m + "Request", schema: passthrough() },
      })),
      result: { mode: "strict", typeSymbol: "dsh-deveco#HarmonyDevEco" + m + "Result", schema: passthrough() },
    });
    const CLIENT_REMOTE = {
      package: "dsh-deveco",
      descriptors: [
        method("getConfig", []),
        method("getSettingsNamespace", []),
        method("rescan", []),
        method("deviceList", []),
        method("deviceInfo", ["request"]),
        method("hilogList", ["request"]),
        method("hilogStreamStart", ["request"]),
        method("hilogStreamRead", ["request"]),
        method("hilogStreamStop", ["request"]),
        method("uiDump", ["request"]),
        method("uiScreenshot", ["request"]),
        method("uiTap", ["request"]),
        method("uiSwipe", ["request"]),
        method("uiText", ["request"]),
        method("listProjects", []),
      ],
    };

    // ---- shared helpers ---------------------------------------------------
    function unwrap(res) {
      if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || { code: "transport", message: "调用失败" } };
      const v = res.value;
      if (v && typeof v === "object" && typeof v.ok === "boolean") return v;
      return { ok: true, value: v };
    }

    const LEVEL_BADGES = ["D", "I", "W", "E", "F"];

    function formatHilogLevel(level) {
      return ({ D: "DEBUG", I: "INFO", W: "WARN", E: "ERROR", F: "FATAL" })[level] || (level || "?");
    }

    // ---- ArkTS syntax highlight (lightweight regex tokenizer) -----------
    const ARKTS_KEYWORDS = new Set([
      "component", "struct", "build", "function", "const", "let", "var", "if", "else", "for",
      "while", "do", "return", "import", "export", "from", "as", "class", "extends", "implements",
      "interface", "type", "enum", "public", "private", "protected", "static", "readonly",
      "async", "await", "this", "super", "new", "throw", "try", "catch", "finally", "void",
      "true", "false", "null", "undefined", "in", "of", "instanceof", "typeof", "switch",
      "case", "break", "continue", "default", "yield", "delete", "void",
    ]);
    const ARKTS_DECORATORS = new Set([
      "Entry", "Component", "State", "Prop", "Link", "Provide", "Consume", "ObjectLink",
      "Watch", "Builder", "BuilderParam", "Extend", "Styles", "Reusable", "Concurrent",
      "Type", "Observer", "Track", "Require", "CustomDialog", "AnimatableExtend",
      "Animatable", "Preview", "Computed", "Local", "Param", "Event", "Watch",
    ]);

    function tokenizeArktsLine(line) {
      // Returns an array of {t: 'kw'|'str'|'num'|'com'|'deco'|'type'|'plain', v: string}
      // Order matters: comments first, then strings, then decorators/keywords, then numbers.
      const tokens = [];
      let rest = line;
      // line comment: // ...
      const cmIdx = rest.indexOf("//");
      let code = rest;
      let comment = "";
      if (cmIdx >= 0) {
        code = rest.slice(0, cmIdx);
        comment = rest.slice(cmIdx);
      }
      // string literals "..." or '...'
      const strRe = /(['"])((?:\\.|(?!\1).)*)\1/g;
      let last = 0;
      let m;
      const codeTokens = [];
      while ((m = strRe.exec(code)) !== null) {
        if (m.index > last) codeTokens.push({ t: "plain", v: code.slice(last, m.index) });
        codeTokens.push({ t: "str", v: m[0] });
        last = m.index + m[0].length;
      }
      if (last < code.length) codeTokens.push({ t: "plain", v: code.slice(last) });

      // Within plain chunks, find identifiers and numbers.
      const idRe = /(@?[A-Za-z_][A-Za-z0-9_]*)|(\d+\.?\d*)/g;
      const final = [];
      for (const ct of codeTokens) {
        if (ct.t !== "plain") { final.push(ct); continue; }
        let i = 0;
        let lm;
        idRe.lastIndex = 0;
        const local = ct.v;
        let lastPos = 0;
        while ((lm = idRe.exec(local)) !== null) {
          if (lm.index > lastPos) final.push({ t: "plain", v: local.slice(lastPos, lm.index) });
          const word = lm[0];
          if (lm[1] !== undefined) {
            if (word.startsWith("@")) {
              const name = word.slice(1);
              final.push({ t: "deco", v: ARKTS_DECORATORS.has(name) ? word : word });
            } else if (ARKTS_KEYWORDS.has(word)) {
              final.push({ t: "kw", v: word });
            } else if (/^[A-Z]/.test(word)) {
              final.push({ t: "type", v: word });
            } else {
              final.push({ t: "plain", v: word });
            }
          } else if (lm[2] !== undefined) {
            final.push({ t: "num", v: word });
          }
          lastPos = lm.index + word.length;
        }
        if (lastPos < local.length) final.push({ t: "plain", v: local.slice(lastPos) });
      }
      if (comment) final.push({ t: "com", v: comment });
      return final;
    }

    function ArktsCodeView(props) {
      const content = props.content || "";
      const lines = content.split(/\r?\n/);
      const maxLines = 2000;
      const truncated = lines.length > maxLines;
      const view = truncated ? lines.slice(0, maxLines) : lines;
      const rows = [];
      for (let i = 0; i < view.length; i++) {
        const tokens = tokenizeArktsLine(view[i]);
        rows.push(
          React.createElement(
            "div",
            { key: i, className: "ark-line" },
            React.createElement("span", { className: "ark-lineno" }, String(i + 1)),
            React.createElement(
              "span",
              { className: "ark-code" },
              tokens.map((tk, j) =>
                React.createElement("span", { key: j, className: "ark-" + tk.t }, tk.v),
              ),
            ),
          ),
        );
      }
      return React.createElement(
        "div",
        null,
        React.createElement(
          "div",
          { className: "ark-meta" },
          props.path || "",
          " · ",
          String(lines.length),
          " 行",
          props.bytes !== undefined ? " · " + String(props.bytes) + " 字节" : "",
          truncated ? " · 已截断（前 " + maxLines + " 行）" : "",
        ),
        React.createElement("div", { className: "harm-scroll", style: { maxHeight: "60vh" } }, rows),
      );
    }

    function ArkTSViewer(props) {
      const content = props.content || "";
      const bytes = typeof content === "string" ? content.length : 0;
      return React.createElement(ArktsCodeView, {
        path: props.path,
        content: content,
        bytes: bytes,
      });
    }

    // ---- shared device hook -------------------------------------------------
    // Both feature tabs need the device list. A small shared hook keeps each
    // tab independent (its own state, its own refresh) without coupling them.
    function useDeviceList() {
      const [devices, setDevices] = React.useState([]);
      const [device, setDevice] = React.useState("");
      const refresh = React.useCallback(async () => {
        if (!remote) return;
        try {
          const r = await remote.deviceList();
          const out = unwrap(r);
          if (out.ok && out.value && Array.isArray(out.value.devices)) {
            setDevices(out.value.devices);
            setDevice((prev) => {
              if (prev && out.value.devices.some((d) => d.serial === prev)) return prev;
              return out.value.devices.length > 0 ? (out.value.devices[0].serial || "") : "";
            });
          }
        } catch (e) { /* */ }
      }, []);
      React.useEffect(() => { refresh(); }, [refresh]);
      return { devices, device, setDevice, refresh };
    }

    function useToolchainBadge() {
      const [resolved, setResolved] = React.useState(null);
      React.useEffect(() => {
        let alive = true;
        (async () => {
          if (!remote) return;
          try {
            const r = await remote.getConfig();
            const out = unwrap(r);
            if (alive && out.ok && out.value) setResolved(out.value.resolved || null);
          } catch (e) { /* */ }
        })();
        return () => { alive = false; };
      }, []);
      const cls = resolved && resolved.source === "devecocli" ? "harm-badge-ok"
        : resolved && resolved.source === "clt" && resolved.minVersionOk ? "harm-badge-ok"
        : resolved && resolved.source === "studio" ? "harm-badge-warn"
        : "harm-badge-err";
      return { resolved, cls, label: resolved ? resolved.source : "…" };
    }

    function DevicePicker(props) {
      const { devices, device, setDevice, refresh, busy } = props;
      return React.createElement(
        React.Fragment, null,
        React.createElement(
          "select",
          {
            className: "harm-input",
            style: { minWidth: 0, maxWidth: 220, flex: "0 1 auto" },
            value: device,
            onChange: (e) => setDevice(e.target.value),
          },
          React.createElement("option", { value: "" }, "未选择"),
          devices.map((d, i) =>
            React.createElement("option", { key: i, value: d.serial }, d.name || d.serial),
          ),
        ),
        React.createElement("button", { className: "harm-btn", disabled: !!busy, onClick: refresh }, "刷新设备"),
      );
    }

    // ---- HiLog 检查器 tab（独立入口）--------------------------------------
    function HarmonyHiLogTab(props) {
      const { devices, device, setDevice, refresh: refreshDevices } = useDeviceList();
      const badge = useToolchainBadge();
      const [busy, setBusy] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState("");
      const [hilogLines, setHilogLines] = React.useState([]);
      const [hilogStreamId, setHilogStreamId] = React.useState("");
      const [hilogRunning, setHilogRunning] = React.useState(false);
      const [hilogLevels, setHilogLevels] = React.useState(new Set(["I", "W", "E"]));
      const [hilogBundle, setHilogBundle] = React.useState("");
      const [hilogKeyword, setHilogKeyword] = React.useState("");

      React.useEffect(() => {
        if (!hilogRunning || !hilogStreamId || !remote) return;
        let cancelled = false;
        const tick = async () => {
          try {
            const r = await remote.hilogStreamRead({ streamId: hilogStreamId, maxLines: 200 });
            if (cancelled) return;
            const out = unwrap(r);
            if (out.ok && out.value && Array.isArray(out.value.lines)) {
              const filtered = out.value.lines.filter((l) => !l.level || hilogLevels.has(l.level));
              if (filtered.length > 0) {
                setHilogLines((prev) => {
                  const next = prev.concat(filtered);
                  return next.length > 500 ? next.slice(next.length - 500) : next;
                });
              }
              if (out.value.closed) setHilogRunning(false);
            }
          } catch (e) { /* */ }
        };
        const id = setInterval(tick, 1000);
        return () => { cancelled = true; clearInterval(id); };
      }, [hilogRunning, hilogStreamId, hilogLevels, remote]);

      const toggleLevel = (lv) => {
        setHilogLevels((prev) => {
          const next = new Set(prev);
          if (next.has(lv)) next.delete(lv); else next.add(lv);
          return next;
        });
      };

      const startHilog = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          if (hilogStreamId) {
            await remote.hilogStreamStop({ streamId: hilogStreamId });
            setHilogStreamId("");
          }
          setHilogLines([]);
          const r = await remote.hilogStreamStart({
            device: device || undefined,
            level: Array.from(hilogLevels).join("") || undefined,
            bundle: hilogBundle.trim() || undefined,
            keyword: hilogKeyword.trim() || undefined,
          });
          const out = unwrap(r);
          if (!out.ok) { setErrorMsg((out.error && (out.error.message || out.error.code)) || "启动失败"); return; }
          setHilogStreamId(out.value.streamId);
          setHilogRunning(true);
        } catch (e) {
          setErrorMsg(e instanceof Error ? e.message : String(e));
        } finally { setBusy(false); }
      };

      const stopHilog = async () => {
        if (!remote || !hilogStreamId) return;
        setBusy(true);
        try {
          await remote.hilogStreamStop({ streamId: hilogStreamId });
        } catch (e) { /* */ }
        setHilogRunning(false);
        setHilogStreamId("");
        setBusy(false);
      };

      if (!remote) {
        return React.createElement("div", { className: "harm-page" },
          React.createElement("div", { className: "harm-empty" }, "Remote 命名空间尚未挂载（请检查 console 报错）"));
      }

      const levelChips = LEVEL_BADGES.map((lv) =>
        React.createElement(
          "span",
          {
            key: lv, className: "harm-chip" + (hilogLevels.has(lv) ? " harm-chip-on" : ""),
            onClick: () => toggleLevel(lv),
          },
          lv,
        ),
      );
      const linesView = hilogLines.length === 0
        ? React.createElement("div", { className: "harm-empty" }, hilogRunning ? "等待日志…" : "尚未启动 HiLog 流。设置过滤后点击「开始」。")
        : React.createElement("div", { className: "harm-scroll" },
            hilogLines.map((l, i) =>
              React.createElement(
                "div",
                { key: i, className: "harm-log-line" },
                l.level
                  ? React.createElement("span", { className: "harm-log-level harm-level-" + l.level }, l.level)
                  : React.createElement("span", { className: "harm-log-level" }, "?"),
                l.pid !== undefined ? React.createElement("span", { className: "harm-log-pid" }, "pid " + l.pid) : null,
                l.tag ? React.createElement("span", { className: "harm-log-tag" }, l.tag) : null,
                l.message
                  ? React.createElement("span", { className: "harm-log-msg" }, l.message)
                  : React.createElement("span", { className: "harm-log-raw" }, l.raw || ""),
              ),
            ),
          );

      return React.createElement(
        "div", { className: "harm-page" },
        React.createElement(
          "div", { className: "harm-head" },
          React.createElement("h3", { className: "harm-head-title" }, "HiLog 检查器"),
          React.createElement("span", { className: "harm-badge " + badge.cls }, badge.label),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement(DevicePicker, { devices, device, setDevice, refresh: refreshDevices, busy }),
          hilogRunning
            ? React.createElement("button", { className: "harm-btn harm-btn-danger", disabled: busy, onClick: stopHilog }, "停止")
            : React.createElement("button", { className: "harm-btn harm-btn-primary", disabled: busy, onClick: startHilog }, "开始"),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement("span", { className: "harm-label" }, "级别"),
          levelChips,
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement("div", { className: "harm-field" },
            React.createElement("span", { className: "harm-label" }, "包名"),
            React.createElement("input", { className: "harm-input", value: hilogBundle, onChange: (e) => setHilogBundle(e.target.value), placeholder: "可选，如 com.example.app" }),
          ),
          React.createElement("div", { className: "harm-field" },
            React.createElement("span", { className: "harm-label" }, "关键词"),
            React.createElement("input", { className: "harm-input", value: hilogKeyword, onChange: (e) => setHilogKeyword(e.target.value), placeholder: "可选，如 focus" }),
          ),
        ),
        errorMsg ? React.createElement("div", { className: "harm-error" }, errorMsg) : null,
        linesView,
      );
    }

    // ---- ArkUI Inspector tab（独立入口）------------------------------------
    function HarmonyArkUITab(props) {
      const { devices, device, setDevice, refresh: refreshDevices } = useDeviceList();
      const badge = useToolchainBadge();
      const [busy, setBusy] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState("");
      const [uiNodes, setUiNodes] = React.useState([]);
      const [selectedNode, setSelectedNode] = React.useState(-1);
      const [tapX, setTapX] = React.useState("");
      const [tapY, setTapY] = React.useState("");
      const [swipeX1, setSwipeX1] = React.useState("");
      const [swipeY1, setSwipeY1] = React.useState("");
      const [swipeX2, setSwipeX2] = React.useState("");
      const [swipeY2, setSwipeY2] = React.useState("");
      const [swipeSpeed, setSwipeSpeed] = React.useState("");
      const [textInput, setTextInput] = React.useState("");
      const [screenshotPath, setScreenshotPath] = React.useState("");

      const doDump = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const r = await remote.uiDump({ device: device || undefined });
          const out = unwrap(r);
          if (!out.ok) { setErrorMsg((out.error && (out.error.message || out.error.code)) || "dump 失败"); return; }
          setUiNodes(out.value.nodes || []);
          setSelectedNode(-1);
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doScreenshot = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const path = "~/.dsh/data/dsh-deveco/screenshot-" + Date.now() + ".png";
          const r = await remote.uiScreenshot({ device: device || undefined, outPath: path });
          const out = unwrap(r);
          if (!out.ok) { setErrorMsg((out.error && (out.error.message || out.error.code)) || "截图失败"); return; }
          setScreenshotPath(out.value.savedTo || path);
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doTap = async () => {
        if (!remote) return;
        const x = Number(tapX), y = Number(tapY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) { setErrorMsg("x / y 必须是数字"); return; }
        setBusy(true); setErrorMsg("");
        try {
          const r = await remote.uiTap({ device: device || undefined, x, y });
          const out = unwrap(r);
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "tap 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doSwipe = async () => {
        if (!remote) return;
        const x1 = Number(swipeX1), y1 = Number(swipeY1), x2 = Number(swipeX2), y2 = Number(swipeY2);
        if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) { setErrorMsg("swipe 坐标必须是数字"); return; }
        setBusy(true); setErrorMsg("");
        try {
          const req = { device: device || undefined, x1, y1, x2, y2 };
          const sp = Number(swipeSpeed);
          if (Number.isFinite(sp)) req.speed = sp;
          const r = await remote.uiSwipe(req);
          const out = unwrap(r);
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "swipe 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doText = async () => {
        if (!remote) return;
        if (!textInput) { setErrorMsg("text 不能为空"); return; }
        setBusy(true); setErrorMsg("");
        try {
          const r = await remote.uiText({ device: device || undefined, text: textInput });
          const out = unwrap(r);
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "text 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      if (!remote) {
        return React.createElement("div", { className: "harm-page" },
          React.createElement("div", { className: "harm-empty" }, "Remote 命名空间尚未挂载（请检查 console 报错）"));
      }

      const treeView = uiNodes.length === 0
        ? React.createElement("div", { className: "harm-empty" }, "尚未 Dump UI。点击「Dump UI」获取节点树。")
        : React.createElement("div", { className: "harm-tree" },
            uiNodes.map((n, i) =>
              React.createElement(
                "div",
                {
                  key: i,
                  className: "harm-tree-node" + (selectedNode === i ? " selected" : ""),
                  onClick: () => {
                    setSelectedNode(i);
                    const b = n.bounds || {};
                    setTapX(String(Math.round((b.left + b.right) / 2) || ""));
                    setTapY(String(Math.round((b.top + b.bottom) / 2) || ""));
                  },
                },
                React.createElement("span", { className: "harm-tree-idx" }, "#" + (n.index !== undefined ? n.index : i)),
                React.createElement("span", { className: "harm-tree-class" }, n.className || ""),
                n.text ? React.createElement("span", { className: "harm-tree-text" }, n.text) : null,
                n.resourceId ? React.createElement("span", { className: "harm-tree-rid" }, "#" + n.resourceId) : null,
                React.createElement("span", { className: "harm-tree-bounds" }, n.boundsStr || ""),
              ),
            ),
          );

      return React.createElement(
        "div", { className: "harm-page" },
        React.createElement(
          "div", { className: "harm-head" },
          React.createElement("h3", { className: "harm-head-title" }, "ArkUI Inspector"),
          React.createElement("span", { className: "harm-badge " + badge.cls }, badge.label),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement(DevicePicker, { devices, device, setDevice, refresh: refreshDevices, busy }),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doDump }, "Dump UI"),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doScreenshot }, "Screenshot"),
        ),
        React.createElement(
          "div", { className: "harm-split" },
          React.createElement("div", null,
            React.createElement("div", { className: "harm-label" }, "UI 树"),
            treeView,
          ),
          React.createElement("div", null,
            React.createElement("div", { className: "harm-label" }, "Screenshot"),
            screenshotPath
              ? React.createElement("div", { className: "harm-empty" }, "已保存到：" + screenshotPath)
              : React.createElement("div", { className: "harm-empty" }, "尚未截图"),
          ),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement("span", { className: "harm-label" }, "Tap"),
          React.createElement("input", { className: "harm-input", style: { minWidth: 80, flex: "0 1 80px" }, value: tapX, onChange: (e) => setTapX(e.target.value), placeholder: "x" }),
          React.createElement("input", { className: "harm-input", style: { minWidth: 80, flex: "0 1 80px" }, value: tapY, onChange: (e) => setTapY(e.target.value), placeholder: "y" }),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doTap }, "执行"),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement("span", { className: "harm-label" }, "Swipe"),
          React.createElement("input", { className: "harm-input", style: { minWidth: 70, flex: "0 1 70px" }, value: swipeX1, onChange: (e) => setSwipeX1(e.target.value), placeholder: "x1" }),
          React.createElement("input", { className: "harm-input", style: { minWidth: 70, flex: "0 1 70px" }, value: swipeY1, onChange: (e) => setSwipeY1(e.target.value), placeholder: "y1" }),
          React.createElement("input", { className: "harm-input", style: { minWidth: 70, flex: "0 1 70px" }, value: swipeX2, onChange: (e) => setSwipeX2(e.target.value), placeholder: "x2" }),
          React.createElement("input", { className: "harm-input", style: { minWidth: 70, flex: "0 1 70px" }, value: swipeY2, onChange: (e) => setSwipeY2(e.target.value), placeholder: "y2" }),
          React.createElement("input", { className: "harm-input", style: { minWidth: 70, flex: "0 1 70px" }, value: swipeSpeed, onChange: (e) => setSwipeSpeed(e.target.value), placeholder: "speed" }),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doSwipe }, "执行"),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement("span", { className: "harm-label" }, "Text"),
          React.createElement("input", { className: "harm-input", value: textInput, onChange: (e) => setTextInput(e.target.value), placeholder: "输入文本" }),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doText }, "执行"),
        ),
        errorMsg ? React.createElement("div", { className: "harm-error" }, errorMsg) : null,
      );
    }

    // ---- plugin-config card (settings.plugin.item) -------------------------
    //
    // The user-facing configuration surface for this plugin: a card inside the
    // DSH Settings → Plugins → Configuration tab. It edits the settings
    // namespace `harmony-deveco` directly through `ctx.settingsScope` (the
    // official client-side settings transport), instead of a bespoke settings
    // page. The Host half registered the namespace and re-resolves the
    // toolchain on every `settings/document-updated`, so saving a path here
    // takes effect immediately.
    function HarmonySettingsCard(props) {
      // Bound scope is created once per card mount by the apply() closure.
      const [resolved, setResolved] = React.useState(null);
      const [discovery, setDiscovery] = React.useState(null);
      const [studioPath, setStudioPath] = React.useState("");
      const [cltPath, setCltPath] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState("");

      // Read the current values out of the bound scope (defined in apply()).
      const sync = React.useCallback(() => {
        if (!settingsScope) return;
        const snap = settingsScope.get();
        const value = (snap && snap.value) || {};
        setStudioPath(typeof value.studioPath === "string" ? value.studioPath : "");
        setCltPath(typeof value.cltPath === "string" ? value.cltPath : "");
      }, []);

      React.useEffect(() => {
        if (!settingsScope) return;
        const off = settingsScope.subscribe(() => sync());
        sync();
        return off;
      }, [sync]);

      const loadToolchainState = React.useCallback(async () => {
        if (!remote) return;
        try {
          const r = await remote.getConfig();
          const out = unwrap(r);
          if (out.ok && out.value) {
            setResolved(out.value.resolved || null);
            setDiscovery(out.value.discovery || null);
          }
        } catch (e) { /* */ }
      }, []);

      React.useEffect(() => { loadToolchainState(); }, [loadToolchainState]);

      const applyPath = async (field) => {
        if (!settingsScope) return;
        setBusy(true); setErrorMsg("");
        try {
          const value = field === "cltPath" ? cltPath.trim() : studioPath.trim();
          // Mutual exclusion: writing one field clears the other (user decision).
          await settingsScope.set(field, value);
          if (field === "cltPath") await settingsScope.unset("studioPath");
          else await settingsScope.unset("cltPath");
          await loadToolchainState();
        } catch (e) {
          setErrorMsg(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
      };

      const rescan = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const r = await remote.rescan();
          const out = unwrap(r);
          if (!out.ok) { setErrorMsg((out.error && (out.error.message || out.error.code)) || "扫描失败"); return; }
          setDiscovery(out.value.discovery || null);
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const sourceLabel = resolved ? resolved.source : "加载中…";
      const sourceMsg = resolved ? (resolved.message || "") : "从设置服务读取工具链状态…";
      const badgeCls = resolved && resolved.source === "devecocli" ? "harm-badge-ok"
        : resolved && resolved.source === "clt" && resolved.minVersionOk ? "harm-badge-ok"
        : resolved && resolved.source === "studio" ? "harm-badge-warn"
        : "harm-badge-err";

      const studios = discovery && Array.isArray(discovery.studios) ? discovery.studios : [];
      const clts = discovery && Array.isArray(discovery.clts) ? discovery.clts : [];

      return React.createElement(
        "div", { className: "harm-page" },
        React.createElement(
          "div", { className: "harm-head" },
          React.createElement("h3", { className: "harm-head-title" }, "HarmonyOS 开发套件配置"),
          React.createElement("span", { className: "harm-badge " + badgeCls }, sourceLabel),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: rescan }, "重新扫描"),
        ),
        React.createElement("div", { className: "harm-status" }, sourceMsg),
        React.createElement(
          "div", { className: "harm-banner harm-banner-warn" },
          "DevEco Studio 路径与 Command Line Tools 路径互斥：配置一个会清空另一个；同时配置时优先 Command Line Tools（最低 26.0.0）。PATH 中存在 devecocli 时优先使用并忽略以下路径。",
        ),
        errorMsg ? React.createElement("div", { className: "harm-error" }, errorMsg) : null,

        React.createElement(
          "div", { className: "harm-field" },
          React.createElement("span", { className: "harm-label" }, "DevEco Studio 路径"),
          React.createElement(
            "div", { className: "harm-row" },
            React.createElement("input", {
              className: "harm-input", value: studioPath,
              onChange: (e) => setStudioPath(e.target.value),
              placeholder: "C:\\Program Files\\Huawei\\DevEco Studio",
            }),
            React.createElement("button", { className: "harm-btn harm-btn-primary", disabled: busy, onClick: () => applyPath("studioPath") }, "应用"),
          ),
          studios.length > 0
            ? React.createElement(
                "div", { className: "harm-list" },
                studios.map((s, i) =>
                  React.createElement(
                    "div", { key: i, className: "harm-list-item" },
                    React.createElement("span", { className: "harm-list-item-path" }, s.path),
                    React.createElement("button", { className: "harm-btn", disabled: busy, onClick: () => setStudioPath(s.path) }, "应用"),
                  ),
                ),
              )
            : React.createElement("div", { className: "harm-hint" }, "（暂无自发现结果，请点击「重新扫描」或手动填写路径）"),
        ),

        React.createElement(
          "div", { className: "harm-field" },
          React.createElement("span", { className: "harm-label" }, "HarmonyOS Command Line Tools 路径（≥ 26.0.0）"),
          React.createElement(
            "div", { className: "harm-row" },
            React.createElement("input", {
              className: "harm-input", value: cltPath,
              onChange: (e) => setCltPath(e.target.value),
              placeholder: "C:\\Program Files\\Huawei\\Command Line Tools\\26.0.0",
            }),
            React.createElement("button", { className: "harm-btn harm-btn-primary", disabled: busy, onClick: () => applyPath("cltPath") }, "应用"),
          ),
          clts.length > 0
            ? React.createElement(
                "div", { className: "harm-list" },
                clts.map((c, i) =>
                  React.createElement(
                    "div", { key: i, className: "harm-list-item" },
                    React.createElement("span", { className: "harm-list-item-path" }, c.path),
                    React.createElement("span", { className: "harm-list-item-ver" }, c.version),
                    React.createElement("button", { className: "harm-btn", disabled: busy, onClick: () => setCltPath(c.path) }, "应用"),
                  ),
                ),
              )
            : React.createElement("div", { className: "harm-hint" }, "（暂无自发现结果，请点击「重新扫描」或手动填写路径）"),
        ),
      );
    }

    // ---- icons ------------------------------------------------------------
    function HarmonyIcon(props) {
      const size = props.size || 16;
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("circle", { cx: 12, cy: 12, r: 10 }),
        React.createElement("path", { d: "M2 12h20" }),
        React.createElement("path", { d: "M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" }),
      );
    }

    /** HiLog tab icon: stacked log lines (Lucide "scroll-text" style). */
    function HarmonyLogIcon(props) {
      const size = props.size || 16;
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
        React.createElement("path", { d: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z" }),
        React.createElement("path", { d: "M14 2v4a2 2 0 0 0 2 2h4" }),
        React.createElement("path", { d: "M10 9H8" }),
        React.createElement("path", { d: "M16 13H8" }),
        React.createElement("path", { d: "M16 17H8" }),
      );
    }

    // ---- apply() ----------------------------------------------------------
    async function apply(ctx) {
      // Mount the harmonyDevEco namespace before anything touches it.
      // The browser-side `ctx.remote.harmonyDevEco` is a Proxy namespace created
      // by $mount; reading the same key on the bundle's own ctx via ctx.get()
      // resolves the namespace object.
      await ctx.remote.$mount(CLIENT_REMOTE);
      // Bind the remote service into the apply-scope closure so the registered
      // components (rendered through settings.section and better-sidebar tabs,
      // where the supplied `ctx` is the host's own — not our bundle's) can
      // still talk to the Host through the same mounted namespace.
      const remote = ctx.get("remote.harmonyDevEco");

      // Bind the settings namespace scope. The namespace is registered by the
      // Host half under `harmony-deveco`; binding it on this fiber lets the
      // settings card read current values and write back through the official
      // settings transport (no custom write Remote needed).
      const settingsScope = ctx.settingsScope ? ctx.settingsScope.bind({
        namespace: "harmony-deveco",
      }) : null;

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      ctx.effect(() => registerSettingsNavIcon(SETTINGS_LABEL));

      // better-sidebar tabs + ets viewer (graceful when not installed).
      // Two independent feature tabs — the HiLog 检查器 and the ArkUI
      // Inspector — plus the .ets file viewer.
      const sidebar = ctx.get("betterSidebar");
      if (sidebar) {
        const disposeHilog = sidebar.registerTab({
          id: "harmony-hilog",
          title: () => "HiLog 检查器",
          icon: (size) => React.createElement(HarmonyLogIcon, { size }),
          order: 50,
          single: true,
          component: HarmonyHiLogTab,
        });
        ctx.effect(() => disposeHilog);

        const disposeArkui = sidebar.registerTab({
          id: "harmony-arkui",
          title: () => "ArkUI Inspector",
          icon: (size) => React.createElement(HarmonyIcon, { size }),
          order: 51,
          single: true,
          component: HarmonyArkUITab,
        });
        ctx.effect(() => disposeArkui);

        const disposeViewer = sidebar.registerFileViewer({
          id: "arkts",
          title: "ArkTS / TypeScript",
          priority: 10,
          exts: ["ets"],
          fetchStrategy: "fsRead",
          component: ArkTSViewer,
        });
        ctx.effect(() => disposeViewer);
      }

      // Plugin Configuration card: appears inside Settings → 插件 → 配置
      // (the ui-settings-plugins "configurable" tab), keyed by the settings
      // namespace it edits. No extra sidebar/settings nav entry is added.
      ctx.slots.inject("settings.plugin.item", function* () {
        yield ctx.slots.register({
          name: "settings.plugin.item",
          key: "harmony-deveco",
          label: () => "HarmonyOS Suite",
        }, HarmonySettingsCard);
      });
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote", "settingsScope", "betterSidebar"];
    return module.exports;
  },
});