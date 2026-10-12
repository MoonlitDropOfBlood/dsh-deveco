/**
 * dsh-deveco — Client half (web bundle).
 *
 * Rendered by the DSH web shell via `window.__ModuleLoader__.load`. Registers:
 *   1. Two single-instance page tabs in the official right sidebar
 *      (`ctx.sidebarRightTabs` / slot `sidebar.right.pane.tab`): the HiLog
 *      检查器 (log streaming) and the ArkUI Inspector (Chrome-Elements-style
 *      screenshot / UI tree / node properties + box model, plus tap / swipe /
 *      text). Both appear in the sidebar Guide menu.
 *   2. An `ArkTS / TypeScript` file viewer for `.ets` files (patterns
 *      `*.ets`, priority `extension` — preferred over the built-in text
 *      editor). Content is paged through the official `remote.workspaceFiles`
 *      namespace, with the plugin's own `readTextFile` Remote as fallback for
 *      absolute paths.
 *   3. A settings page under Settings (`settings.section`, id
 *      `harmony-deveco`, order 40) split into a 工具链 section (DevEco Studio /
 *      Command Line Tools paths, three-platform auto-discovery, studio↔clt
 *      mutual exclusion) and a 设备管理 section (device list with one-click
 *      disconnect for network targets + the `hdc tconn` IP connect form).
 *
 * Host communication goes through the `harmonyDevEco` Remote namespace
 * (`ctx.get('remote.harmonyDevEco').{getConfig, setStudioPath, setCltPath,
 * rescan, deviceList, deviceConnectIp, deviceDisconnectIp, hilog*, ui*,
 * readTextFile, ...}`), published by the Host half in `index.js`. Path writes
 * go through the `setStudioPath` / `setCltPath` Remote methods (the Host
 * persists to config.json); DSH 0.2.0 removed the `settingsScope` client
 * transport.
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
.harm-pane{max-width:none;height:100%;min-height:0;overflow:hidden;padding:14px 16px}
.harm-pane .harm-scroll,.harm-pane .harm-tree{flex:1;min-height:0;max-height:none}
.ark-root{display:flex;flex-direction:column;height:100%;min-height:0}
.ark-root .harm-scroll{flex:1;min-height:0;max-height:none}
.harm-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.harm-head-title{font-size:16px;font-weight:500;line-height:24px;margin:0;flex:1}
.harm-status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
.harm-tabs{display:inline-flex;gap:4px;padding:3px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;align-self:flex-start}
.harm-tab{box-sizing:border-box;height:26px;font:inherit;font-size:12px;cursor:pointer;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:7px;padding:0 14px;line-height:26px}
.harm-tab-active{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.harm-input{box-sizing:border-box;height:30px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 10px;outline:none;min-width:0;flex:1}
.harm-input:focus{border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.harm-btn{box-sizing:border-box;height:30px;font:inherit;font-size:12px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 14px;white-space:nowrap}
.harm-btn:hover{border-color:var(--dsw-alias-border-l1)}
.harm-btn:disabled{opacity:.5;cursor:not-allowed}
.harm-btn-primary{background:var(--dsw-alias-button-info-fill,#4a7dff);border-color:transparent;color:#fff}
.harm-btn-primary:hover{background:var(--dsw-alias-button-info-hover,#3d6cd9);border-color:transparent}
.harm-btn-danger{color:var(--dsw-alias-state-error-primary,#e5484d)}
.harm-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.harm-field{display:flex;flex-direction:column;gap:5px;flex:1;min-width:0}
.harm-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.harm-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.harm-banner{padding:8px 12px;border-radius:8px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.harm-banner-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5b942) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5b942) 30%,transparent);color:var(--dsw-alias-state-warn-primary,#f5b942)}
.harm-badge{display:inline-flex;align-items:center;height:22px;padding:0 10px;border-radius:999px;font-size:12px;line-height:22px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500}
.harm-badge-ok{background:var(--dsw-alias-state-success-primary,#2fb37d);color:#fff;border-color:transparent}
.harm-badge-warn{background:var(--dsw-alias-state-warn-primary,#f5b942);color:#fff;border-color:transparent}
.harm-badge-err{background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;border-color:transparent}
.harm-chip{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 10px;border-radius:6px;font-size:11px;font-weight:600;line-height:24px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);user-select:none}
.harm-chip-on{background:var(--dsw-alias-button-info-fill,#4a7dff);border-color:transparent;color:#fff}
.harm-scroll{overflow-y:auto;max-height:50vh;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}
.harm-log-line{padding:6px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;border-bottom:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;align-items:flex-start}
.harm-log-line:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.06))}
.harm-log-level{flex:none;display:inline-flex;align-items:center;justify-content:center;height:18px;min-width:24px;padding:0 6px;border-radius:4px;font-size:10px;font-weight:700;color:#fff}
.harm-level-D{background:var(--dsw-alias-label-dimmed,#888)}.harm-level-I{background:var(--dsw-alias-button-info-fill,#4a7dff)}.harm-level-W{background:var(--dsw-alias-state-warn-primary,#f5b942);color:#000}.harm-level-E{background:var(--dsw-alias-state-error-primary,#e5484d)}.harm-level-F{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 65%,#000)}
.harm-log-pid{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;min-width:48px}
.harm-log-tag{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;min-width:80px}
.harm-log-msg{flex:1;color:var(--dsw-alias-label-primary);word-break:break-word;white-space:pre-wrap;min-width:0}
.harm-log-raw{flex:1;color:var(--dsw-alias-label-tertiary);font-style:italic;word-break:break-word}
.harm-tree{display:flex;flex-direction:column;gap:2px;overflow-y:auto;max-height:50vh;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;background:var(--dsw-alias-bg-layer-1)}
.harm-tree-node{padding:5px 7px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;border-radius:5px;cursor:pointer;line-height:18px;color:var(--dsw-alias-label-primary);border:1px solid transparent;display:flex;gap:8px;align-items:baseline}
.harm-tree-node:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.harm-tree-node.selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 15%,transparent);border-color:var(--dsw-alias-brand-primary,#4a7dff)}
.harm-tree-idx{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;min-width:28px;text-align:right}
.harm-tree-class{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}
.harm-tree-text{flex:none;color:var(--dsw-alias-label-primary)}
.harm-tree-rid{flex:none;color:var(--dsw-alias-brand-primary,#4a7dff);font-size:11px}
.harm-tree-bounds{flex:1;color:var(--dsw-alias-label-tertiary);font-size:10px;text-align:right;margin-left:auto}
.harm-empty{color:var(--dsw-alias-label-tertiary);text-align:center;padding:32px 16px;font-size:13px;line-height:20px}
.harm-error{padding:8px 14px;border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#e5484d) 10%,transparent);color:var(--dsw-alias-state-error-primary,#e5484d);font-size:12px;line-height:18px}
.harm-loading{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;padding:12px 0}
.harm-spinner{width:14px;height:14px;border-radius:50%;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-brand-primary);animation:harm-spin .8s linear infinite;flex:none}
@keyframes harm-spin{to{transform:rotate(360deg)}}
.harm-split{display:grid;grid-template-columns:1fr 1fr;gap:12px;align-items:stretch}

/* ---- ArkUI Inspector（Chrome Elements 风格：左截图 / 右上树 / 右下属性）---- */
.harm-insp{flex:1;min-height:0;display:grid;grid-template-columns:minmax(260px,42%) 1fr;gap:12px;align-items:stretch}
.harm-inspCol{display:flex;flex-direction:column;gap:8px;min-height:0;min-width:0}
.harm-inspColTop{flex:1 1 55%;min-height:0;display:flex;flex-direction:column;gap:6px}
.harm-inspColBot{flex:1 1 45%;min-height:0;display:flex;flex-direction:column;gap:6px}
.harm-inspTitle{flex:none;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;line-height:1.5}
.harm-inspTitle .harm-inspCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-weight:400}
/* 截图预览：wrapper 收缩包裹 img，overlay 用百分比定位，天然跟随缩放 */
.harm-shot{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:6px}
.harm-shotFrame{position:relative;display:inline-block;max-width:100%;max-height:100%;line-height:0;cursor:crosshair}
.harm-shotImg{display:block;max-width:100%;max-height:100%;width:auto;height:auto;border-radius:4px;user-select:none;-webkit-user-drag:none}
.harm-shotOverlay{position:absolute;pointer-events:none;box-sizing:border-box;border:2px solid var(--dsw-alias-button-info-fill,#4a7dff);border-radius:2px;background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#4a7dff) 12%,transparent)}
.harm-shotEmpty{color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;line-height:1.5;padding:16px}
.harm-shotHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
/* 窗口选择器 */
.harm-winSel{display:inline-flex;align-items:center;gap:6px}
.harm-winSelLabel{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:30px}
.harm-winSelSelect{box-sizing:border-box;height:30px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:0 8px;outline:none;max-width:220px;cursor:pointer}
.harm-winSelSelect:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.harm-winSelSelect:disabled{opacity:.5;cursor:default}
/* 节点列表 */
.harm-tree2{flex:1;min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:6px 4px 6px 0}
.harm-node{position:relative;display:flex;align-items:baseline;gap:6px;padding:3px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;border-radius:5px;cursor:pointer;color:var(--dsw-alias-label-primary);white-space:nowrap;min-width:max-content}
.harm-node:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))}
.harm-node.selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 16%,transparent)}
.harm-node.isComponent{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#4a7dff) 9%,transparent)}
.harm-node.isComponent.selected{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#4a7dff) 18%,transparent)}
.harm-node.isHidden .harm-nodeText{opacity:.55}
.harm-nodeTag{flex:none;color:var(--dsw-alias-brand-primary,#4a7dff)}
.harm-nodePh{opacity:.55}
.harm-nodeBadge{flex:none;font-size:9px;line-height:14px;padding:0 5px;border-radius:4px;background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#4a7dff) 22%,transparent);color:var(--dsw-alias-button-info-fill,#4a7dff);font-weight:600}
.harm-btnOn{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#4a7dff) 22%,transparent);border-color:var(--dsw-alias-button-info-fill,#4a7dff);color:var(--dsw-alias-button-info-fill,#4a7dff)}
.harm-node.isComponent .harm-nodeTag{color:var(--dsw-alias-label-primary);font-weight:600}
.harm-nodeType{flex:none;color:var(--dsw-alias-label-secondary)}
.harm-nodeText{min-width:0;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harm-nodeId{flex:none;color:var(--dsw-alias-label-tertiary)}
.harm-nodeBounds{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px}
.harm-nodeFlags{flex:none;display:inline-flex;gap:3px}
.harm-nodeDepth{flex:none;color:var(--dsw-alias-label-tertiary);font-size:9px;opacity:.75}
/* 单个元素的层级引导线（repeating gradient 由行内 style 给宽度） */
.harm-nodeGuides{position:absolute;top:0;bottom:0;pointer-events:none;background-repeat:repeat}
.harm-nodeFlag{font-size:9px;line-height:14px;padding:0 4px;border-radius:4px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary)}
.harm-nodeFlag-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#2fb37d) 20%,transparent);color:var(--dsw-alias-state-success-primary,#2fb37d)}
.harm-nodeFlag-hit{background:color-mix(in srgb,var(--dsw-alias-button-info-fill,#4a7dff) 22%,transparent);color:var(--dsw-alias-button-info-fill,#4a7dff)}
/* 折叠箭头 */
.harm-caret{flex:none;width:14px;height:14px;display:inline-flex;align-items:center;justify-content:center;border:0;background:0 0;padding:0;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:3px}
.harm-caret:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14));color:var(--dsw-alias-label-primary)}
.harm-caret svg{width:10px;height:10px;display:block;transition:transform .15s}
.harm-caretOpen svg{transform:rotate(90deg)}
/* 属性面板 */
.harm-props{flex:1;min-height:0;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);padding:10px}
.harm-propsSearch{position:sticky;top:-10px;z-index:1;align-items:center;gap:6px;margin:-10px -10px 8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);display:flex}
.harm-propsSearchInput{box-sizing:border-box;flex:1;min-width:0;height:26px;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:0 8px;outline:none}
.harm-propsSearchInput:focus-visible{border-color:var(--dsw-alias-brand-primary)}
.harm-propsSearchCount{flex:none;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums}
.harm-propsEmpty{color:var(--dsw-alias-label-tertiary);text-align:center;font-size:13px;padding:24px 8px}
.harm-propsHead{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;font-weight:600;word-break:break-all}
.harm-propsSec{margin:12px 0 4px;color:var(--dsw-alias-label-tertiary);font-size:10px;font-weight:600;letter-spacing:.04em}
.harm-propsTable{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px;line-height:1.6}
.harm-propsKey{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.harm-propsVal{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}
.harm-propsVal mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5b942) 45%,transparent);color:inherit;border-radius:2px}
/* 盒子模型（真实几何；设备未提供的层显示「未提供」而不是假的 0） */
.harm-boxWrap{display:flex;justify-content:center;margin:10px 0 4px}
.harm-box{align-items:center;font-size:10px;line-height:1.4;display:inline-flex;flex-direction:column}
.harm-boxLayer{align-items:center;justify-content:center;border-radius:3px;padding:4px 8px;color:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;box-sizing:border-box;display:flex}
.harm-boxOuter{background:color-mix(in srgb,#8b7bd8 55%,#3b2f6e);flex-direction:column;gap:4px;padding:10px}
.harm-boxInset{background:color-mix(in srgb,#6fbf73 60%,#2b6f2f);flex-direction:column;gap:4px;padding:8px 10px}
.harm-boxContent{background:color-mix(in srgb,#4a7dff 65%,#1b45ad);min-width:104px;min-height:36px;flex-direction:column;gap:2px}
.harm-boxContent b{font-size:12px;font-weight:600}
.harm-boxUnknown{background:transparent;color:var(--dsw-alias-label-tertiary);border:1px dashed var(--dsw-alias-border-l2);font-style:italic}
.harm-boxEmpty{color:var(--dsw-alias-label-tertiary);font-size:11px;padding:6px 0 0;text-align:center}
.harm-boxTable{grid-template-columns:auto auto 1fr;gap:3px 10px;font-size:11px;line-height:1.6;margin-top:8px;display:grid}
.harm-boxKey{color:var(--dsw-alias-label-secondary);white-space:nowrap}
.harm-boxNum{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;text-align:right;font-variant-numeric:tabular-nums}
.harm-boxNA{color:var(--dsw-alias-label-tertiary);font-style:italic}
.harm-boxNote{margin-top:8px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
/* 操作区 */
.harm-ops{border-top:1px solid var(--dsw-alias-border-l2);padding-top:8px;display:flex;flex-direction:column;gap:6px}
.harm-opsRow{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.harm-opsLabel{flex:none;width:44px;color:var(--dsw-alias-label-secondary);font-size:12px}
.harm-opsRow .harm-input{flex:1 1 60px;max-width:90px;height:28px}
.harm-list{display:flex;flex-direction:column;gap:6px}
.harm-list-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);font-size:12px;line-height:18px}
.harm-list-item-path{flex:1;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-primary);word-break:break-all;min-width:0}
.harm-list-item-ver{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px}

/* Settings nav icon: replace fallback gear with Lucide smartphone via currentColor mask */
[data-dsh-deveco-settings-nav]>svg:first-child{display:none}
[data-dsh-deveco-settings-nav]::before{content:'';flex:none;width:16px;height:16px;background:currentColor;-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='14' height='20' x='5' y='2' rx='2' ry='2'/%3E%3Cpath d='M12 18h.01'/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='14' height='20' x='5' y='2' rx='2' ry='2'/%3E%3Cpath d='M12 18h.01'/%3E%3C/svg%3E") center/contain no-repeat}

/* Plugin-config collapsible card (mirrors ui-settings-plugins PluginCard) */
.harm-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.harm-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.harm-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.harm-cardHeader{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.harm-cardHeader:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.harm-cardHeadText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.harm-cardName{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4;display:inline-flex;align-items:center;gap:10px}
.harm-cardBadge{display:inline-flex;align-items:center;height:24px;padding:0 12px;border-radius:999px;font-size:12px;font-weight:600;line-height:24px;border:1px solid transparent;white-space:nowrap}
.harm-badge-info{background:var(--dsw-alias-button-info-fill,#4a7dff);color:#fff;border-color:transparent}
.harm-badge-muted{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l1)}
.harm-cardDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.harm-cardPending{white-space:nowrap;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);border-radius:999px;flex:none;padding:1px 8px;font-size:11px;font-weight:500;line-height:17px}
.harm-cardChevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.harm-cardChevronOpen{transform:rotate(180deg)}
.harm-cardBody{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 8px}
.harm-cardNote{color:var(--dsw-alias-label-tertiary);margin:0 0 10px;font-size:12px;line-height:1.5}
.harm-fieldRow{flex-direction:column;gap:6px;padding:12px 0;display:flex}
.harm-fieldRow+.harm-fieldRow{border-top:1px solid var(--dsw-alias-border-l2)}
.harm-fieldHead{align-items:center;gap:8px;display:flex}
.harm-fieldLabel{min-width:0;color:var(--dsw-alias-label-primary);flex:1;font-size:13px;font-weight:500;line-height:1.5}
.harm-fieldInput{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);height:34px;font:inherit;color:var(--dsw-alias-label-primary);border-radius:8px;padding:0 12px;font-size:13px;line-height:1.5;width:100%;box-sizing:border-box}
.harm-fieldInput:focus-visible{border-color:var(--dsw-alias-brand-primary);outline:none}
.harm-fieldHint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:1.5}
.harm-ipRow{display:flex;gap:8px}
.harm-ipRow .harm-fieldInput{flex:1;min-width:0}
.harm-ipRow .harm-ipPort{flex:none;width:96px}
.harm-ipOk{min-width:0;color:var(--dsw-alias-state-success-primary,#2fb37d);flex:1;font-size:12px;line-height:1.5}
.harm-discovery{display:flex;flex-direction:column;gap:4px}
.harm-discoveryItem{appearance:none;font:inherit;font-size:12px;line-height:1.5;text-align:left;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-secondary);padding:6px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harm-discoveryItem:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.harm-cardActions{border-top:1px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex;margin-top:4px}
.harm-cardError{min-width:0;color:var(--dsw-alias-state-error-primary,#e5484d);flex:1;font-size:12px;line-height:1.5}
/* Settings sections（工具链 / 设备管理） */
.harm-secHead{align-items:center;gap:10px;margin:20px 0 6px;display:flex}
.harm-secTitle{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:600;letter-spacing:.02em;line-height:1.5}
.harm-secRule{flex:1;height:1px;background:var(--dsw-alias-border-l2)}
/* Device management list */
.harm-devList{display:flex;flex-direction:column;gap:4px}
.harm-devRow{align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);padding:6px 10px;display:flex}
.harm-devType{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 8px;border-radius:999px;font-size:10px;font-weight:600;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.harm-devTypeNet{background:var(--dsw-alias-button-info-fill,#4a7dff);color:#fff}
.harm-devSerial{flex:1;min-width:0;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harm-devName{flex:none;max-width:40%;color:var(--dsw-alias-label-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.harm-devDiscard{flex:none;appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);padding:3px 10px;font-size:12px;line-height:1.5}
.harm-devDiscard:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#e5484d);border-color:var(--dsw-alias-state-error-primary,#e5484d)}
.harm-devDiscard:disabled{opacity:.4;cursor:default}
.harm-devDiscard:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.harm-ipRow .harm-cardSave{flex:none;height:34px;padding:0 14px}
.harm-cardDiscard,.harm-cardSave{appearance:none;font:inherit;cursor:pointer;border:1px solid transparent;border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5}
.harm-cardDiscard{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:0 0}
.harm-cardDiscard:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
.harm-cardSave{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}
.harm-cardDiscard:disabled,.harm-cardSave:disabled{opacity:.4;cursor:default}
.harm-cardDiscard:focus-visible,.harm-cardSave:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}

/* ArkTS syntax highlight */
.ark-line{display:flex;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:20px;padding:0 8px;white-space:pre}
.ark-line:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.04))}
.ark-lineno{flex:none;width:52px;color:var(--dsw-alias-label-tertiary);text-align:right;padding-right:14px;user-select:none;font-size:11px}
.ark-code{flex:1;color:var(--dsw-alias-label-primary);white-space:pre-wrap;word-break:break-word;min-width:0}
.ark-kw{color:var(--shiki-token-keyword,#c586c0);font-weight:600}.ark-str{color:var(--shiki-token-string,#ce9178)}.ark-num{color:var(--shiki-token-constant,#b5cea8)}.ark-com{color:var(--shiki-token-comment,#6a9955);font-style:italic}.ark-deco{color:var(--shiki-token-function,#dcdcaa)}.ark-fn{color:var(--shiki-token-function,#dcdcaa)}.ark-type{color:var(--shiki-token-link,#4ec9b0)}
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

    // ---- apply-scope service bindings ------------------------------------
    // Components below are defined at FACTORY scope (stable React identity),
    // so the services they need must also live at factory scope. apply()
    // assigns them during activation — every render happens after apply()
    // completes, so the values are always in place by first paint.
    let remote = null;
    let clientCtx = null;

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
        codec: { mode: "strict", typeSymbol: "dsh-deveco#HarmonyDevEco" + m + "Request", schema: passthrough(), create: () => passthrough() },
      })),
      result: { mode: "strict", typeSymbol: "dsh-deveco#HarmonyDevEco" + m + "Result", schema: passthrough(), create: () => passthrough() },
    });
    const CLIENT_REMOTE = {
      package: "dsh-deveco",
      descriptors: [
        method("getConfig", []),
        method("setStudioPath", ["request"]),
        method("setCltPath", ["request"]),
        method("readTextFile", ["request"]),
        method("rescan", []),
        method("deviceList", []),
        method("deviceInfo", ["request"]),
        method("deviceConnectIp", ["request"]),
        method("deviceDisconnectIp", ["request"]),
        method("hilogList", ["request"]),
        method("hilogStreamStart", ["request"]),
        method("hilogStreamRead", ["request"]),
        method("hilogStreamStop", ["request"]),
        method("uiDump", ["request"]),
        method("uiDevEcoTree", ["request"]),
        method("uiWindowList", ["request"]),
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

    // ---- dsh-resource://file address parsing --------------------------------
    // Mirror of the official address scheme: `dsh-resource://file/<scope>/...`
    // with URI-encoded segments. `session` scope carries
    // `<sessionId>/<workspace-relative path>`; `absolute` carries a host path
    // (drive segment `C:` → `C:/...`, leading empty segment → UNC `//...`).
    function parseFileAddress(address) {
      if (typeof address !== "string") return undefined;
      const prefix = "dsh-resource://file/";
      if (!address.startsWith(prefix)) return undefined;
      const raw = address.slice(prefix.length).split("/");
      const scope = raw.shift();
      const segs = raw.map((seg) => { try { return decodeURIComponent(seg); } catch (e) { return seg; } });
      if (scope === "session") {
        const sessionId = segs.shift() || "";
        return { scope: "session", sessionId: sessionId, path: segs.join("/") };
      }
      if (scope === "absolute") {
        let path;
        if (segs.length > 0 && segs[0] === "") {
          path = "//" + segs.slice(1).join("/");
        } else if (segs.length > 0 && /^[A-Za-z]:$/.test(segs[0])) {
          path = segs[0] + "/" + segs.slice(1).join("/");
        } else {
          path = "/" + segs.join("/");
        }
        return { scope: "absolute", sessionId: "", path: path };
      }
      return undefined;
    }

    function fileTitleOf(address) {
      const p = parseFileAddress(address);
      const path = p ? p.path : "";
      const segs = path.split("/").filter(Boolean);
      return segs.length > 0 ? segs[segs.length - 1] : "ArkTS";
    }

    // Page the official `workspaceFiles` Remote until EOF (pages are
    // line-aligned; `read(sessionId, path, {offset, limit})` returns
    // `{ text, lines, offset, eof, bytes?, ... }`). Total cap guards the viewer.
    //
    // 实测三个坑（2026-10）：① 官方命名空间由 dsh-api-remotes **异步** `$mount`，
    // 在 apply() 一次性 `ctx.get` 会竞态缓存 null——必须读取时懒解析 + 用
    // ctx.inject(["remote.workspaceFiles"]) 挂起等待（运行时的 blessed 机制，
    // 官方 consumer 就是靠 inject 挂起的）；② 官方 read() 解析出的是**裸 page
    // 对象**（documentpreview 直接用 page.text），不是 `{ok,value}` 包络——两种
    // 形态都要认；③ 命名空间对象的 read 可能是 accessor（取 typeof 会 throw），
    // 用 `"read" in ns` 判存在、try/catch 记探针，报错时带诊断信息。
    let parkedWorkspaceFiles = null;
    const wsProbe = { notes: [], keys: "" };
    function workspaceFilesRemote() {
      const inspect = (label, ns) => {
        if (!ns || typeof ns !== "object") { wsProbe.notes.push(label + ":∅"); return null; }
        try {
          if (!("read" in ns)) { wsProbe.notes.push(label + ":no-read"); return null; }
          const fn = ns.read;
          if (typeof fn !== "function") { wsProbe.notes.push(label + ":read-" + typeof fn); return null; }
          wsProbe.notes.push(label + ":ok");
          return ns;
        } catch (e) {
          wsProbe.notes.push(label + ":throw-" + String((e && e.message) || "").slice(0, 30));
          return null;
        }
      };
      if (parkedWorkspaceFiles) {
        const ns = inspect("parked", parkedWorkspaceFiles);
        if (ns) return ns;
      }
      try {
        if (clientCtx) {
          const carrier = clientCtx.remote || (typeof clientCtx.get === "function" ? clientCtx.get("remote") : null);
          if (carrier && !wsProbe.keys) {
            try { wsProbe.keys = Object.keys(carrier).filter((k) => typeof k === "string").slice(0, 12).join(","); } catch (e) { /* */ }
          }
          const viaProp = inspect("carrier", carrier && carrier.workspaceFiles);
          if (viaProp) return viaProp;
          const viaGet = inspect("get", typeof clientCtx.get === "function" ? clientCtx.get("remote.workspaceFiles") : null);
          if (viaGet) return viaGet;
        } else {
          wsProbe.notes.push("ctx:∅");
        }
      } catch (e) {
        wsProbe.notes.push("probe-throw-" + String((e && e.message) || "").slice(0, 30));
      }
      return null;
    }

    // read() 返回值归一化：裸 page 对象 / {ok,value} 包络 都接受。
    function normalizePage(res) {
      if (res && typeof res === "object") {
        if (typeof res.text === "string") return { ok: true, value: res };
        if (res.ok === true && res.value && typeof res.value.text === "string") return { ok: true, value: res.value };
        if (res.value && typeof res.value.text === "string") return { ok: true, value: res.value };
        if (res.ok === false) return res;
      }
      return { ok: false, error: (res && res.error) || { code: "read-failed", message: "workspaceFiles.read 返回了无法识别的形态" } };
    }

    const VIEWER_MAX_LINES = 20000;
    async function readWorkspaceFileText(sessionId, path) {
      const workspaceFiles = workspaceFilesRemote();
      if (!workspaceFiles) {
        throw new Error("workspaceFiles-remote-unavailable [" + wsProbe.notes.slice(-6).join(" ") + (wsProbe.keys ? " keys=" + wsProbe.keys : "") + "]");
      }
      const PAGE = 1000;
      let offset = 1;
      let text = "";
      let size = 0;
      for (;;) {
        const r = normalizePage(await workspaceFiles.read(sessionId, path, { offset: offset, limit: PAGE }));
        if (!r.ok) throw new Error((r.error && (r.error.message || r.error.code)) || "read-failed");
        const v = r.value || {};
        const pageText = typeof v.text === "string" ? v.text : "";
        const lines = typeof v.lines === "number" ? v.lines : 0;
        text += (text ? "\n" : "") + pageText;
        if (typeof v.bytes === "number") size = v.bytes;
        if (v.eof || lines === 0) return { content: text, bytes: size, truncated: false };
        if (offset + lines > VIEWER_MAX_LINES) return { content: text, bytes: size, truncated: true };
        offset += lines;
      }
    }

    // ---- ArkTS syntax highlight（参考 DevEco Studio 的着色项：注释/字符串/
    // 数字/装饰器/关键字/类型（含声明式 UI 组件名）。字符扫描状态机——字符串内
    // 的 // 不再被当注释、模板串与块注释跨行携带状态，build() { … } 声明式 UI
    // 里的 URL、Don't、`…${}…` 等不再打乱后续高亮）--------------------------
    const ARKTS_KEYWORDS = new Set([
      "component", "struct", "build", "function", "const", "let", "var", "if", "else", "for",
      "while", "do", "return", "import", "export", "from", "as", "class", "extends", "implements",
      "interface", "type", "enum", "public", "private", "protected", "static", "readonly",
      "async", "await", "this", "super", "new", "throw", "try", "catch", "finally",
      "true", "false", "null", "undefined", "in", "of", "instanceof", "typeof", "switch",
      "case", "break", "continue", "default", "yield", "delete",
    ]);
    // 基本类型注解按类型色显示（DevEco 同款）；大写 Promise/Array 等直接走 type
    const ARKTS_PRIM_TYPES = new Set([
      "string", "number", "boolean", "void", "symbol", "bigint", "object", "never", "unknown", "any",
    ]);

    // 全文扫描 → 每行一个 token 数组（{t:'kw'|'str'|'num'|'com'|'deco'|'type'|'plain', v}）。
    // 模板串 `…` 与块注释 /* … */ 跨行时状态延续，每行按段着色。
    function tokenizeArkts(content) {
      const out = [];
      let line = [];
      let buf = "";
      let bufKind = "plain";
      const endBuf = () => { if (buf) { line.push({ t: bufKind, v: buf }); buf = ""; bufKind = "plain"; } };
      const nl = () => { endBuf(); out.push(line); line = []; };
      const isIdStart = (c) => (c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_";
      const isId = (c) => isIdStart(c) || (c >= "0" && c <= "9");
      let state = "code"; // code | block | squote | dquote | template
      let i = 0;
      const n = content.length;
      while (i < n) {
        const c = content[i];
        if (c === "\r") { i++; continue; }
        if (c === "\n") { nl(); i++; continue; }
        if (state === "block") {
          bufKind = "com";
          if (c === "*" && content[i + 1] === "/") { buf += "*/"; i += 2; endBuf(); state = "code"; continue; }
          buf += c; i++; continue;
        }
        if (state === "squote" || state === "dquote" || state === "template") {
          bufKind = "str";
          const closer = state === "squote" ? "'" : state === "dquote" ? '"' : "`";
          if (c === "\\") { buf += c + (content[i + 1] !== undefined ? content[i + 1] : ""); i += 2; continue; }
          buf += c; i++;
          if (c === closer) { endBuf(); state = "code"; }
          continue;
        }
        // ---- code ----
        if (c === "/" && content[i + 1] === "/") {
          endBuf(); bufKind = "com"; buf = "//"; i += 2;
          while (i < n && content[i] !== "\n") buf += content[i++];
          endBuf(); continue;
        }
        if (c === "/" && content[i + 1] === "*") {
          endBuf(); bufKind = "com"; buf = "/*"; i += 2; state = "block"; continue;
        }
        if (c === "'" || c === '"' || c === "`") {
          endBuf(); bufKind = "str"; buf = c; i++;
          state = c === "'" ? "squote" : c === '"' ? "dquote" : "template";
          continue;
        }
        if (c >= "0" && c <= "9") {
          endBuf(); bufKind = "num";
          if (c === "0" && (content[i + 1] === "x" || content[i + 1] === "X")) {
            buf += content[i++] + content[i++];
            while (i < n && /[0-9a-fA-F]/.test(content[i])) buf += content[i++];
          } else {
            while (i < n && content[i] >= "0" && content[i] <= "9") buf += content[i++];
            if (content[i] === "." && content[i + 1] >= "0" && content[i + 1] <= "9") {
              buf += content[i++];
              while (i < n && content[i] >= "0" && content[i] <= "9") buf += content[i++];
            }
          }
          endBuf(); continue;
        }
        if (c === "@") {
          endBuf(); bufKind = "deco"; buf = "@"; i++;
          while (i < n && isId(content[i])) buf += content[i++];
          endBuf(); continue;
        }
        if (isIdStart(c)) {
          endBuf();
          let w = "";
          while (i < n && isId(content[i])) w += content[i++];
          if (ARKTS_KEYWORDS.has(w)) line.push({ t: "kw", v: w });
          else if (ARKTS_PRIM_TYPES.has(w)) line.push({ t: "type", v: w });
          else if (w[0] >= "A" && w[0] <= "Z") line.push({ t: "type", v: w }); // 类型与声明式 UI 组件名
          else {
            // 小写标识符紧邻 `(` → 方法声明/调用（DevEco 按函数色显示方法名）
            let j = i;
            while (j < n && (content[j] === " " || content[j] === "\t")) j++;
            if (content[j] === "(") line.push({ t: "fn", v: w });
            else line.push({ t: "plain", v: w });
          }
          continue;
        }
        buf += c; i++;
      }
      endBuf();
      out.push(line);
      return out;
    }

    function ArktsCodeView(props) {
      const content = props.content || "";
      // 全文一次扫描（模板串/块注释跨行状态正确携带），每行一个 token 数组。
      const allLines = tokenizeArkts(content);
      const maxLines = 2000;
      const truncated = allLines.length > maxLines;
      const view = truncated ? allLines.slice(0, maxLines) : allLines;
      const rows = [];
      for (let i = 0; i < view.length; i++) {
        const tokens = view[i];
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
        { className: "ark-root" },
        React.createElement(
          "div",
          { className: "ark-meta" },
          props.path || "",
          " · ",
          String(allLines.length),
          " 行",
          props.bytes !== undefined ? " · " + String(props.bytes) + " 字节" : "",
          truncated ? " · 已截断（前 " + maxLines + " 行）" : "",
        ),
        React.createElement("div", { className: "harm-scroll" }, rows),
      );
    }

    /**
     * Official `sidebar.right.pane.tab` body for `.ets` files. The tab's
     * navigation address (`dsh-resource://file/<scope>/...`) comes from the
     * bound `useTabInfo()` hook the slot contract provides. Content is paged
     * through the official `remote.workspaceFiles` namespace; for absolute
     * addresses it falls back to the plugin's own `readTextFile` Remote.
     */
    function ArkTSViewerTab(props) {
      const info = props.useTabInfo ? props.useTabInfo() : null;
      const address = info && info.tab && info.tab.navigation ? info.tab.navigation.address : "";
      const parsed = parseFileAddress(address);
      const [state, setState] = React.useState({ loading: true, content: "", bytes: 0, error: "" });
      const sessionId = (parsed && parsed.scope === "session" ? parsed.sessionId : "") || props.sessionId || "";
      const pathKey = parsed ? parsed.scope + ":" + parsed.path : "";

      React.useEffect(() => {
        let alive = true;
        setState({ loading: true, content: "", bytes: 0, error: "" });
        (async () => {
          if (!parsed || !parsed.path) {
            if (alive) setState({ loading: false, content: "", bytes: 0, error: "无法解析文件地址：" + (address || "(空)") });
            return;
          }
          const readOnce = () => readWorkspaceFileText(sessionId, parsed.path);
          try {
            let out;
            for (let attempt = 0; ; attempt++) {
              try {
                out = await readOnce();
                break;
              } catch (e1) {
                // 官方命名空间异步挂载：给挂起等待/重试留足窗口（3 次 × 2s）。
                if (attempt >= 2 || !/workspaceFiles-remote-unavailable/.test(String((e1 && e1.message) || ""))) throw e1;
                await new Promise((r2) => setTimeout(r2, 2000));
                if (!alive) return;
              }
            }
            if (alive) setState({ loading: false, content: out.content, bytes: out.bytes, error: "" });
          } catch (e) {
            // Absolute-scope fallback: the Host's own readTextFile Remote.
            if (parsed.scope === "absolute" && remote) {
              try {
                const r = unwrap(await remote.readTextFile({ path: parsed.path }));
                if (r.ok && r.value) {
                  if (alive) setState({ loading: false, content: r.value.content || "", bytes: r.value.bytes || 0, error: "" });
                  return;
                }
                if (alive) setState({ loading: false, content: "", bytes: 0, error: (r.error && (r.error.message || r.error.code)) || "读取失败" });
                return;
              } catch (e2) { /* fall through */ }
            }
            const msg = e instanceof Error ? e.message : String(e);
            if (alive) setState({ loading: false, content: "", bytes: 0, error: /workspaceFiles-remote-unavailable/.test(msg) ? "文件服务（remote.workspaceFiles）未就绪，请稍后重开此标签页 —— " + msg : msg });
          }
        })();
        return () => { alive = false; };
      }, [pathKey, sessionId]);

      if (state.loading) {
        return React.createElement("div", { className: "harm-page harm-pane" },
          React.createElement("p", { className: "harm-status" }, "加载中…"));
      }
      if (state.error) {
        return React.createElement("div", { className: "harm-page harm-pane" },
          React.createElement("div", { className: "harm-banner harm-banner-warn" }, "读取失败：" + state.error));
      }
      return React.createElement(ArktsCodeView, {
        path: parsed ? parsed.path : "",
        content: state.content,
        bytes: state.bytes,
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

    /**
     * One shared badge model for the toolchain resolution state. The label is
     * Chinese and self-explanatory (the raw `source` enum alone reads like an
     * error); DevEco Studio is a legitimate fallback, so it uses the info
     * tint — red is reserved for states that need action (no toolchain at
     * all, or a CLT below the 26.0.0 floor).
     */
    function toolchainBadgeFor(resolved) {
      if (!resolved) return { cls: "harm-badge-muted", label: "检测中…", title: "正在读取工具链状态" };
      const v = typeof resolved.version === "string" ? resolved.version
        : Array.isArray(resolved.version) ? resolved.version.join(".") : "";
      if (resolved.source === "devecocli") {
        return { cls: "harm-badge-ok", label: "devecocli（PATH）", title: resolved.message };
      }
      if (resolved.source === "clt") {
        return resolved.minVersionOk
          ? { cls: "harm-badge-ok", label: v ? "Command Line Tools " + v : "Command Line Tools", title: resolved.message }
          : { cls: "harm-badge-err", label: "CLT 版本过低（需 ≥ 26.0.0）", title: resolved.message };
      }
      if (resolved.source === "studio") {
        return { cls: "harm-badge-info", label: "DevEco Studio", title: resolved.message };
      }
      return { cls: "harm-badge-err", label: "未配置工具链", title: resolved.message };
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
      const badge = toolchainBadgeFor(resolved);
      return { resolved, cls: badge.cls, label: badge.label, title: badge.title };
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
        return React.createElement("div", { className: "harm-page harm-pane" },
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
            hilogLines.map((l, i) => {
              // hilog 原生格式为 domain/tag（如 0FFFF/AudioManager）——Host 的
              // parseHilogLine 一直返回 domain 字段，渲染层此前漏显示。
              const tagText = (l.domain ? l.domain + "/" : "") + (l.tag || "");
              return React.createElement(
                "div",
                { key: i, className: "harm-log-line" },
                l.level
                  ? React.createElement("span", { className: "harm-log-level harm-level-" + l.level }, l.level)
                  : React.createElement("span", { className: "harm-log-level" }, "?"),
                l.pid !== undefined ? React.createElement("span", { className: "harm-log-pid" }, "pid " + l.pid) : null,
                tagText ? React.createElement("span", { className: "harm-log-tag" }, tagText) : null,
                l.message
                  ? React.createElement("span", { className: "harm-log-msg" }, l.message)
                  : React.createElement("span", { className: "harm-log-raw" }, l.raw || ""),
              );
            }),
          );

      return React.createElement(
        "div", { className: "harm-page harm-pane" },
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

    /** boolean → 是/否（属性表用）。 */
    function yn(v) {
      return v ? "是" : "否";
    }

    // UI 树缩进：每层 8px，**不封顶**（真机 dump 实测深度到 36 层，绝大多数
    // 节点在 10 层以下；封顶会把它们全压平，等于缩进消失）。深层内容靠容器
    // 横向滚动访问，与 Chrome DevTools 一致。
    const INDENT_STEP = 8;
    const INDENT_BASE = 6;

    // ---- ArkUI Inspector tab（Chrome Elements 风格）--------------------------
    // 布局：左侧设备截图（可点选节点），右上 UI 树，右下节点属性 + 盒子模型。
    // 截图由 Host 以 data URL 内联返回（uiScreenshot.dataUrl + 像素尺寸），
    // overlay 用百分比定位，天然跟随图片缩放；点击截图按 device 像素命中节点。

    /** 命中测试：从后往前找 bounds 含点的最小节点（后序 = 更深/更小）。 */
    function hitNode(nodes, x, y) {
      let best = null;
      let bestArea = Infinity;
      for (const n of nodes) {
        const b = n.bounds;
        if (!b) continue;
        if (x < b.left || x > b.right || y < b.top || y > b.bottom) continue;
        const area = Math.max(0, b.right - b.left) * Math.max(0, b.bottom - b.top);
        if (area < bestArea) { best = n; bestArea = area; }
      }
      return best;
    }

    /**
     * 盒子模型：margin → border → padding → content。
     *
     * 研究结论（2026-10，已穷尽核对）：**margin / padding / border 的声明值在任何
     * 外部 dump 中都不存在**。已核对：uitest dumpLayout 全部开关（v7.0.0.1，30 个
     * 属性，`-e` 仅接受 uniqueId）、devecocli ui layout（3 种 --format + --id +
     * --mode full）、hidumper 服务表、devecocli serve mcp（只有 LSP 工具）、
     * uiRecord widget CSV。唯一返回样式声明值的是 `UIContext.getFilteredInspectorTree`
     * （应用内 API）/ DevEco Studio ArkUI Inspector 的调试连接，都要求 debug 包配合，
     * 第三方应用从外部拿不到。
     *
     * 但有**实测几何**可用：内容区 = 子节点矩形并集，它与 origBounds 的差即实测
     * 内缩。这里据实呈现（未填满/滚动溢出时标注出来），**绝不用内缩冒充声明值**。
     */
    function HarmonyBoxModel(props) {
      const n = props.node;
      if (!n) return null;
      const b = (n.origBounds || n.bounds) || {};
      const vb = n.bounds || b;
      const cb = n.contentBox || null;
      const hasInset = cb && [cb.left - b.left, b.right - cb.right, b.bottom - cb.bottom, cb.top - b.top]
        .every((v) => Number.isFinite(v) && v >= 0);
      const ins = cb ? {
        top: cb.top - b.top, right: b.right - cb.right,
        bottom: b.bottom - cb.bottom, left: cb.left - b.left,
      } : null;
      const fmtIns = (v) => (v < 0 ? "溢出 " + (-v) : String(v));

      // 图：外层＝组件区域（真实），内层＝内容区域（实测），环为示意非等比。
      const contentLayer = React.createElement(
        "div", { className: "harm-boxLayer harm-boxContent" },
        React.createElement("b", null, (cb ? cb.width : (b.width || 0)) + " × " + (cb ? cb.height : (b.height || 0))),
        React.createElement("span", null, cb ? "内容区域（实测）" : "组件区域"),
      );
      const insetLayer = hasInset
        ? React.createElement("div", { className: "harm-boxLayer harm-boxInset" },
            React.createElement("span", null, "内缩（实测） " + ins.top + " " + ins.right + " " + ins.bottom + " " + ins.left),
            contentLayer)
        : contentLayer;

      const row = (k, v, na) => React.createElement(React.Fragment, { key: k },
        React.createElement("span", { className: "harm-boxKey" }, k),
        React.createElement("span", { className: na ? "harm-boxNA" : "harm-boxNum" }, na ? "未提供" : v),
        React.createElement("span", { className: "harm-boxKey" }, ""));
      const fmtSides = (s) => [s.top, s.right, s.bottom, s.left].map((v) => (Math.round(v * 100) / 100)).join(" ");
      const rows = [];
      rows.push(row("组件区域", (b.width || 0) + " × " + (b.height || 0)));
      rows.push(row("位置", (b.left || 0) + ", " + (b.top || 0)));
      rows.push(row("内容区域", cb ? cb.width + " × " + cb.height : "（无子节点）"));
      if (ins) {
        rows.push(row("内缩 t r b l", ins.top + " " + ins.right + " " + ins.bottom + " " + ins.left + (hasInset ? "（实测）" : "（含溢出）")));
      }
      // 声明值：只有 DevEco 调试源（deveco）能拿到；其余源保持「未提供」。
      rows.push(row("padding", n.padding ? fmtSides(n.padding) + "（声明）" : "", !n.padding));
      rows.push(row("border", n.borderWidth !== undefined && n.borderWidth !== null
        ? String(n.borderWidth) + (n.borderColor ? " " + n.borderColor : "") + "（声明）" : "", n.borderWidth === undefined || n.borderWidth === null));
      rows.push(row("margin", n.margin ? fmtSides(n.margin) + "（声明）" : "", !n.margin));
      rows.push(row("圆角", n.borderRadius !== undefined && n.borderRadius !== null ? String(n.borderRadius) : "", n.borderRadius === undefined || n.borderRadius === null));
      if (vb !== b && (vb.width !== b.width || vb.height !== b.height)) {
        rows.push(row("可见尺寸", (vb.width || 0) + " × " + (vb.height || 0)));
      }

      return React.createElement(
        "div",
        null,
        React.createElement(
          "div", { className: "harm-boxWrap" },
          React.createElement("div", { className: "harm-box" },
            React.createElement("div", { className: "harm-boxLayer harm-boxOuter" },
              React.createElement("span", null, "组件区域 " + (b.width || 0) + " × " + (b.height || 0)),
              insetLayer),
          ),
        ),
        React.createElement("div", { className: "harm-boxTable" }, rows),
        React.createElement("div", { className: "harm-boxNote" },
          n.padding || n.margin || n.borderWidth !== undefined
            ? "声明值来自 DevEco 调试源（应用侧 inspector 树）；「内缩」是子节点几何实测值，两者可互相印证。"
            : "margin / border / padding 的**声明值**组件树/无障碍树 dump 不输出（已穷尽核对）；图中「内缩」是子节点几何实测值，容器未填满或滚动溢出时会偏离真实 padding。声明值请切到「DevEco 调试源」（需 debug 包）。"),
      );
    }

    function HarmonyArkUITab(props) {
      const { devices, device, setDevice, refresh: refreshDevices } = useDeviceList();
      const badge = useToolchainBadge();
      const [busy, setBusy] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState("");
      // 两套树源（用户定位）：deveco＝DevEco 开发调试源（ark socket，唯一带
      // padding/margin/border 声明值和组件/Builder 名，需 debug 应用 + aa attach，
      // 且 IDE Inspector 面板占用时不可用）；uitest＝无障碍树（适合已发布应用，属性更全）。
      // hidumper 通路已废弃删除（deveco 源全面取代）。
      const [treeSource, setTreeSource] = React.useState("deveco");
      const [trees, setTrees] = React.useState({ deveco: [], uitest: [] });
      const uiNodes = treeSource === "deveco" ? trees.deveco : trees.uitest;
      const [selected, setSelected] = React.useState(null);
      const [shot, setShot] = React.useState(null); // { dataUrl, imageWidth, imageHeight }
      const [windows, setWindows] = React.useState([]); // [{ id, name, focused }]
      const [windowId, setWindowId] = React.useState(""); // 选中的窗口 id（"" = 尚未选，随后自动选前台窗口）
      // 自动选中**前台窗口**（首次拿到窗口列表 / 前台窗口变化时跟随）。
      // Hooks 必须在任何 early return 之前调用，所以放在这里而不是渲染体中部。
      React.useEffect(() => {
        if (!windows.length) return;
        const focused = windows.find((w) => w.focused) || windows[0];
        setWindowId((cur) => (cur === "" || !windows.some((w) => String(w.id) === String(cur)) ? String(focused.id) : cur));
      }, [windows]);
      const [collapsed, setCollapsed] = React.useState(() => new Set()); // node indexes
      const [onlyComponents, setOnlyComponents] = React.useState(false); // 仅显示自定义组件
      const [propsQuery, setPropsQuery] = React.useState("");
      const [swipe, setSwipe] = React.useState({ x1: "", y1: "", x2: "", y2: "", speed: "" });
      const [textInput, setTextInput] = React.useState("");
      const frameRef = React.useRef(null);
      const imgRef = React.useRef(null);
      const treeRef = React.useRef(null);
      // Selecting by clicking the screenshot must reveal the row in the tree,
      // which may be collapsed or scrolled out of view — this bump asks the
      // scroll effect to run once for the given node index.
      const [reveal, setReveal] = React.useState(null);
      // Overlay geometry in CSS pixels, measured from the rendered <img> so the
      // highlight box and the click→hit-test path share one coordinate source.
      const [imgBox, setImgBox] = React.useState(null);

      // Measure the rendered image box whenever the shot or layout changes, and
      // on pane resize. This keeps the overlay pixel-exact at any scale.
      React.useLayoutEffect(() => {
        const measure = () => {
          const el = imgRef.current;
          const fr = frameRef.current;
          if (!el || !fr) { setImgBox(null); return; }
          const r = el.getBoundingClientRect();
          const fr_r = fr.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) { setImgBox(null); return; }
          // Store the image rect in frame-local coordinates so the overlay
          // (a child of the frame) is positioned identically to the hit test.
          setImgBox({
            offsetLeft: r.left - fr_r.left,
            offsetTop: r.top - fr_r.top,
            width: r.width,
            height: r.height,
          });
        };
        measure();
        if (typeof ResizeObserver !== "undefined" && imgRef.current) {
          const ro = new ResizeObserver(measure);
          ro.observe(imgRef.current);
          return () => ro.disconnect();
        }
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
      }, [shot]);

      const snapshot = React.useCallback(async (wid, source) => {
        // 只抓**当前树源 + 当前窗口**：全部窗口数量太多会卡顿（用户要求自动选
        // 前台窗口、禁掉「全部窗口」）。uitest 的 `-w` 对 app 窗口不生效，所以
        // 它仍抓全量、由客户端按窗口过滤；deveco 源按**应用**抓
        // （前台窗口 pid → ark socket），不按窗口过滤。
        const widNum = wid === "" || wid == null ? undefined : Number(wid);
        const treeCall = source === "deveco"
          ? remote.uiDevEcoTree({ device: device || undefined })
          : remote.uiDump({ device: device || undefined, windowId: widNum });
        const [treeRes, shotRes, winRes] = await Promise.all([
          treeCall,
          remote.uiScreenshot({ device: device || undefined, outPath: "~/.dsh/data/dsh-deveco/shot-" + Date.now() + ".png" }),
          remote.uiWindowList({ device: device || undefined, all: true }),
        ]);
        const tree = unwrap(treeRes);
        const cap = unwrap(shotRes);
        const wins = unwrap(winRes);
        const problems = [];
        const nodes = tree.ok ? (tree.value.nodes || []) : [];
        setTrees((prev) => Object.assign({}, prev, { [source === "deveco" ? "deveco" : "uitest"]: nodes }));
        if (!tree.ok) problems.push((tree.error && (tree.error.message || tree.error.code)) || (source === "deveco" ? "DevEco 调试树获取失败" : "dump 失败"));
        if (wins.ok) setWindows(Array.isArray(wins.value && wins.value.windows) ? wins.value.windows : []);
        if (cap.ok && cap.value && cap.value.dataUrl) {
          setShot({ dataUrl: cap.value.dataUrl, imageWidth: cap.value.imageWidth, imageHeight: cap.value.imageHeight });
        } else if (!cap.ok) {
          problems.push((cap.error && (cap.error.message || cap.error.code)) || "截图失败");
        }
        return problems;
      }, [remote, device]);

      const doDump = async (wid, source) => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const problems = await snapshot(wid, source);
          setSelected(null);
          // Node indexes are per-dump, so a stale collapse set would hide the
          // wrong subtrees — start fresh on every capture.
          setCollapsed(new Set());
          if (problems.length) setErrorMsg(problems.join("；"));
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doScreenshot = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const out = unwrap(await remote.uiScreenshot({ device: device || undefined, outPath: "~/.dsh/data/dsh-deveco/shot-" + Date.now() + ".png" }));
          if (out.ok && out.value && out.value.dataUrl) setShot({ dataUrl: out.value.dataUrl, imageWidth: out.value.imageWidth, imageHeight: out.value.imageHeight });
          else if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "截图失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      // The node list scoped to the selected window (all windows when "all").
      // deveco 源是「应用级」树（节点 windowId 全 0），不按窗口过滤。
      const windowNodes = React.useMemo(() => {
        if (treeSource === "deveco") return uiNodes;
        if (windowId === "") return [];
        return uiNodes.filter((n) => String(n.windowId) === String(windowId));
      }, [uiNodes, windowId, treeSource]);

      // 点击截图 → 映射到 device 像素 → 命中最深节点（与高亮框同一坐标系）
      const onShotClick = (e) => {
        if (!shot || !shot.imageWidth || !imgBox || !frameRef.current) return;
        const fr = frameRef.current.getBoundingClientRect();
        if (fr.width <= 0 || fr.height <= 0) return;
        // The image box is frame-local; add the frame's viewport origin to map
        // the click into the image's coordinate space.
        const imgLeft = fr.left + imgBox.offsetLeft;
        const imgTop = fr.top + imgBox.offsetTop;
        const x = ((e.clientX - imgLeft) / imgBox.width) * shot.imageWidth;
        const y = ((e.clientY - imgTop) / imgBox.height) * shot.imageHeight;
        const hit = hitNode(windowNodes, x, y);
        if (!hit) return;
        setSelected(hit.index);
        // Reveal it in the tree: expand every collapsed ancestor first, then
        // scroll the row into view (see the reveal effect below).
        const ancestors = [];
        let cur = uiNodes.find((n) => n.index === hit.index);
        while (cur && cur.parentIndex !== undefined && cur.parentIndex !== -1) {
          ancestors.push(cur.parentIndex);
          cur = uiNodes.find((n) => n.index === cur.parentIndex);
        }
        if (ancestors.length) {
          setCollapsed((prev) => {
            const next = new Set(prev);
            for (const a of ancestors) next.delete(a);
            return next;
          });
        }
        setReveal({ index: hit.index, at: Date.now() });
      };

      // Scroll the selected row into view after a screenshot pick. Runs after
      // the ancestor expansion has re-rendered, so the row actually exists.
      React.useEffect(() => {
        if (!reveal || !treeRef.current) return;
        const row = treeRef.current.querySelector('[data-node-index="' + reveal.index + '"]');
        if (row && typeof row.scrollIntoView === "function") {
          row.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }, [reveal, uiNodes, windowId, collapsed]);

      const selectNode = (n) => { setSelected(n.index); };

      const doTap = async () => {
        if (!remote) return;
        if (selected == null) { setErrorMsg("先在截图或 UI 树中选择一个节点"); return; }
        const n = uiNodes[selected];
        // Tap the centre of the *visible* rect: origBounds can sit partly (or
        // fully) outside the viewport for scrolled List items, and tapping an
        // off-screen point would miss.
        const b = n.bounds;
        const x = Math.round((b.left + b.right) / 2);
        const y = Math.round((b.top + b.bottom) / 2);
        setBusy(true); setErrorMsg("");
        try {
          const out = unwrap(await remote.uiTap({ device: device || undefined, x, y }));
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "tap 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doSwipe = async () => {
        if (!remote) return;
        const x1 = Number(swipe.x1), y1 = Number(swipe.y1), x2 = Number(swipe.x2), y2 = Number(swipe.y2);
        if ([x1, y1, x2, y2].some((v) => !Number.isFinite(v))) { setErrorMsg("swipe 坐标必须是数字"); return; }
        setBusy(true); setErrorMsg("");
        try {
          const req = { device: device || undefined, x1, y1, x2, y2 };
          const sp = Number(swipe.speed);
          if (Number.isFinite(sp)) req.speed = sp;
          const out = unwrap(await remote.uiSwipe(req));
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "swipe 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      const doText = async () => {
        if (!remote) return;
        if (!textInput) { setErrorMsg("text 不能为空"); return; }
        setBusy(true); setErrorMsg("");
        try {
          const out = unwrap(await remote.uiText({ device: device || undefined, text: textInput }));
          if (!out.ok) setErrorMsg((out.error && (out.error.message || out.error.code)) || "text 失败");
        } catch (e) { setErrorMsg(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
      };

      if (!remote) {
        return React.createElement("div", { className: "harm-page harm-pane" },
          React.createElement("div", { className: "harm-empty" }, "Remote 命名空间尚未挂载（请检查 console 报错）"));
      }

      // ---- 左侧：截图 + 选中高亮 ----
      // The selected node must belong to the active window, else no highlight.
      const selNode = (selected != null && windowNodes.some((n) => n.index === selected))
        ? uiNodes[selected]
        : null;
      let overlay = null;
      // Annotate with `origBounds` (true layout rect); `bounds` is only the
      // visible slice — clipped by scrolling parents and occluded by other
      // windows — so it under-reports scrolled List items. `rectOf` falls back
      // to `bounds` for the devecocli-only dump that carries no origBounds.
      const rectOf = (n) => (n && (n.origBounds || n.bounds)) || null;
      if (shot && shot.imageWidth && shot.imageHeight && imgBox && selNode) {
        const b = rectOf(selNode);
        if (b) {
          const sx = imgBox.width / shot.imageWidth;
          const sy = imgBox.height / shot.imageHeight;
          overlay = React.createElement("div", {
            className: "harm-shotOverlay",
            style: {
              left: imgBox.offsetLeft + b.left * sx + "px",
              top: imgBox.offsetTop + b.top * sy + "px",
              width: Math.max(0, b.width * sx) + "px",
              height: Math.max(0, b.height * sy) + "px",
            },
          });
        }
      }
      const shotPane = shot
        ? React.createElement(
            "div", { className: "harm-shot" },
            React.createElement(
              "div",
              { className: "harm-shotFrame", ref: frameRef, onClick: onShotClick, title: "点击选中节点" },
              React.createElement("img", { className: "harm-shotImg", ref: imgRef, src: shot.dataUrl, alt: "设备截图", draggable: false }),
              overlay,
            ),
          )
        : React.createElement("div", { className: "harm-shot" },
            React.createElement("div", { className: "harm-shotEmpty" }, busy ? "正在抓取截图…" : "点「Dump UI」自动截图，或点「截图」单独抓取。"));

      // ---- 右上：UI 树（按窗口过滤 + 可折叠 + 层级引导线 + 自定义组件标注）----
      // Children are contiguous in the flat list, so collapsing a node simply
      // skips its descendants until we pass the next node at the same-or-shallower
      // depth. No separate child index needed.
      const childCountOf = React.useMemo(() => {
        const counts = new Map();
        for (const n of windowNodes) {
          const p = n.parentIndex;
          if (p !== undefined && p !== -1) counts.set(p, (counts.get(p) || 0) + 1);
        }
        return counts;
      }, [windowNodes]);

      const visibleTree = [];
      let hideBelowDepth = -1;
      for (const n of windowNodes) {
        const d = n.depth || 0;
        if (hideBelowDepth >= 0) {
          if (d > hideBelowDepth) continue;
          hideBelowDepth = -1;
        }
        visibleTree.push(n);
        if (collapsed.has(n.index)) hideBelowDepth = d;
      }

      const toggle = (index) => {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(index)) next.delete(index); else next.add(index);
          return next;
        });
      };
      const collapseAll = () => {
        // Collapse every node that has children; leaves become leaves again.
        const next = new Set();
        for (const n of windowNodes) if (childCountOf.get(n.index)) next.add(n.index);
        setCollapsed(next);
      };
      const expandAll = () => setCollapsed(new Set());

      const caretSvg = React.createElement("svg", {
        viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
        strokeWidth: "3", strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true",
      }, React.createElement("polyline", { points: "9 18 15 12 9 6" }));

      // 「仅组件」过滤：只留能提取出组件名的行（保留缩进层级以便看出嵌套关系）。
      const isCompRow = (n) => !!n.componentName;
      const shownTree = onlyComponents ? visibleTree.filter(isCompRow) : visibleTree;
      const treeRows = shownTree.map((n) => {
        const depth = n.depth || 0;
        const kids = childCountOf.get(n.index) || 0;
        const isOpen = !collapsed.has(n.index);
        // One guide-line element per row (a repeating gradient) instead of one
        // DOM node per ancestor level — deep rows used to cost dozens of nodes.
        const guides = depth > 0
          ? React.createElement("span", {
              key: "g",
              className: "harm-nodeGuides",
              style: {
                // absolute 定位以行的 padding box 为参照：从行左缘起，每层一条
                left: INDENT_BASE + "px",
                width: depth * INDENT_STEP + "px",
                backgroundImage:
                  "repeating-linear-gradient(90deg, var(--dsw-alias-border-l1) 0 1px, transparent 1px " + INDENT_STEP + "px)",
              },
            })
          : null;
        const cls = "harm-node"
          + (selected === n.index ? " selected" : "")
          + (n.componentName ? " isComponent" : "")
          + (n.visible === false ? " isHidden" : "");
        // 组件名优先：能提取就只显示组件名（`ImageKnifePro_1447` → `ImageKnifePro`）；
        // 提取不到的 compid **照 DevEco 原样显示**（`left`、`linearGradient_bg`、
        // `task_title`……否则名字就"显示不出来"）；再没有才显示真实类型（含 `__Common__`）。
        const isComp = !!n.componentName;
        const label = n.componentName || n.devId || n.className || "Node";
        // 组件行补渲染类型（ImageKnifePro · Image）；其余直接是名字/类型。
        const subType = isComp && n.className ? n.className : "";
        return React.createElement(
          "div",
          {
            key: n.index,
            className: cls,
            // Lets the reveal effect scroll a screenshot pick into view.
            "data-node-index": n.index,
            style: { paddingLeft: INDENT_BASE + depth * INDENT_STEP + "px" },
            onClick: () => selectNode(n),
            title: n.componentName
              ? `自定义组件 ${n.componentName}（渲染为 ${n.className}）`
              : (n.className === "__Common__"
                  ? "自定义组件 / @Builder 包装节点（工具链生成）"
                  : (n.className || "")),
          },
          guides,
          kids > 0
            ? React.createElement("span", {
                key: "c",
                className: "harm-caret" + (isOpen ? " harm-caretOpen" : ""),
                role: "button",
                tabIndex: 0,
                title: isOpen ? "折叠" : "展开",
                onClick: (e) => { e.stopPropagation(); toggle(n.index); },
                onKeyDown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggle(n.index); } },
              }, caretSvg)
            : React.createElement("span", { key: "c", className: "harm-caret", style: { visibility: "hidden" } }),
          React.createElement("span", { key: "t", className: "harm-nodeTag" }, label),
          // 自定义组件徽标：组件名节点 + `__Common__` 包装节点。
          isComp
            ? React.createElement("span", { key: "badge", className: "harm-nodeBadge" }, "组件")
            : null,
          // 渲染类型放次要位置（DevEco 用图标，这里用淡色文字）。
          subType
            ? React.createElement("span", { key: "rt", className: "harm-nodeType" }, subType)
            : null,
          n.text ? React.createElement("span", { key: "x", className: "harm-nodeText" }, n.text) : null,
          // 与属性面板同一取值：`#accessibilityId`（每个节点都有、全局唯一）。
          // **不显示 id**（devId）—— DevEco 也只显示组件名。
          n.accessibilityId
            ? React.createElement("span", { key: "i", className: "harm-nodeId" }, "#" + n.accessibilityId)
            : null,
          React.createElement("span", { key: "f", className: "harm-nodeFlags" },
            n.clickable ? React.createElement("span", { className: "harm-nodeFlag harm-nodeFlag-hit" }, "tap") : null,
            n.scrollable ? React.createElement("span", { className: "harm-nodeFlag" }, "scroll") : null,
            kids > 0 ? React.createElement("span", { className: "harm-nodeFlag" }, kids) : null),
          React.createElement("span", { key: "b", className: "harm-nodeBounds" }, n.origBoundsStr || n.boundsStr || ""),
        );
      });
      const compCount = windowNodes.filter(isCompRow).length;
      const treePane = React.createElement(
        "div", { className: "harm-inspColTop" },
        React.createElement("div", { className: "harm-inspTitle" }, "UI 树",
          React.createElement("span", { className: "harm-inspCount" },
            shownTree.length + " / " + windowNodes.length + " 个节点" + (compCount ? " · " + compCount + " 个组件" : "")),
          React.createElement("button", {
            type: "button",
            className: "harm-btn" + (onlyComponents ? " harm-btnOn" : ""),
            style: { height: "22px", padding: "0 8px", fontSize: "11px" },
            disabled: !windowNodes.length,
            title: "只显示自定义组件（@Component struct 实例）",
            onClick: () => setOnlyComponents((v) => !v),
          }, onlyComponents ? "✓ 仅组件" : "仅组件"),
          React.createElement("button", { type: "button", className: "harm-btn", style: { height: "22px", padding: "0 8px", fontSize: "11px" }, disabled: !windowNodes.length, onClick: collapsed.size ? expandAll : collapseAll },
            collapsed.size ? "展开全部" : "折叠全部")),
        windowNodes.length
          ? React.createElement("div", { className: "harm-tree2", ref: treeRef }, treeRows)
          : React.createElement("div", { className: "harm-propsEmpty" }, busy ? "正在抓取…" : "点「Dump UI」获取节点树"),
      );

      // ---- 右下：属性（全部字段 + 搜索）+ 盒子模型 ----
      let propsPane;
      if (selNode) {
        const vb = selNode.bounds || {};                                  // 可见矩形
        const ob = (selNode.origBounds || selNode.bounds) || {};         // 真实矩形
        // Three groups so nothing from the dump is silently dropped:
        //   概览  — the fields we model explicitly
        //   设备原始属性 — every attribute the device reported, verbatim
        //   布局矩形 — both rects side by side
        const overview = [];
        if (selNode.componentName) overview.push(["自定义组件", selNode.componentName + "（渲染为 " + (selNode.className || "?") + "）"]);
        else if (selNode.ownerComponent) overview.push(["所属自定义组件", selNode.ownerComponent + "（内部节点）"]);
        overview.push(["类型 type", selNode.className || ""]);
        // `id` is the developer-assigned `.id('…')` — the same string the tree
        // renders as `#id`. accessibilityId is a different, always-numeric id.
        overview.push(["id", selNode.devId || "（未设置）"]);
        overview.push(["accessibilityId", selNode.accessibilityId || "—"]);
        overview.push(["树序号", String(selNode.index)]);
        if (selNode.text) overview.push(["text", selNode.text]);
        if (selNode.originalText && selNode.originalText !== selNode.text) overview.push(["originalText", selNode.originalText]);
        overview.push(["visible", yn(selNode.visible)]);
        overview.push(["enabled", yn(selNode.enabled)]);
        overview.push(["clickable", yn(selNode.clickable)]);
        overview.push(["longClickable", yn(selNode.longClickable)]);
        overview.push(["scrollable", yn(selNode.scrollable)]);
        overview.push(["focused", yn(selNode.focused)]);
        overview.push(["selected", yn(selNode.selected)]);
        overview.push(["checked", yn(selNode.checked)]);
        overview.push(["checkable", yn(selNode.checkable)]);
        overview.push(["clip", yn(selNode.clipped)]);
        overview.push(["opacity", String(selNode.opacity)]);
        overview.push(["zIndex", String(selNode.zIndex)]);
        if (selNode.hitTestBehavior) overview.push(["hitTestBehavior", selNode.hitTestBehavior]);
        overview.push(["windowId", String(selNode.windowId)]);
        if (selNode.bundleName) overview.push(["bundleName", selNode.bundleName]);
        if (selNode.abilityName) overview.push(["abilityName", selNode.abilityName]);
        if (selNode.pagePath) overview.push(["pagePath", selNode.pagePath]);

        const rectRows = [
          ["origBounds（真实）", selNode.origBoundsStr || selNode.boundsStr || ""],
          ["bounds（可见）", selNode.boundsStr || ""],
          ["真实位置 / 尺寸", ob.left + "," + ob.top + "  ·  " + ob.width + " × " + ob.height],
          ["可见位置 / 尺寸", vb.left + "," + vb.top + "  ·  " + vb.width + " × " + vb.height],
        ];

        // Every device-reported attribute, verbatim — including ones we model
        // explicitly, so the pane is a complete view of what the device said.
        const rawRows = Object.entries(selNode.rawAttrs || {}).map(([k, v]) => [k, v === "" ? "—" : v]);
        for (const [k, v] of Object.entries(selNode.attrs || {})) {
          if (!rawRows.some((r) => r[0] === k)) rawRows.push([k, v]);
        }

        const q = propsQuery.trim().toLowerCase();
        const match = (k, v) => !q || String(k).toLowerCase().includes(q) || String(v).toLowerCase().includes(q);
        const allRows = overview.concat(rectRows, rawRows);
        const shown = allRows.filter(([k, v]) => match(k, v));
        const highlight = (text) => {
          const s = String(text);
          if (!q) return s;
          const i = s.toLowerCase().indexOf(q);
          if (i < 0) return s;
          return React.createElement(React.Fragment, null,
            s.slice(0, i),
            React.createElement("mark", { key: "m" }, s.slice(i, i + q.length)),
            s.slice(i + q.length));
        };
        const table = React.createElement(
          "div", { className: "harm-propsTable" },
          shown.flatMap(([k, v], i) => [
            React.createElement("span", { key: "k" + i, className: "harm-propsKey" }, highlight(k)),
            React.createElement("span", { key: "v" + i, className: "harm-propsVal" }, highlight(v)),
          ]),
        );
        propsPane = React.createElement(
          "div", { className: "harm-inspColBot" },
          React.createElement("div", { className: "harm-inspTitle" }, "节点属性",
            React.createElement("span", { className: "harm-inspCount" },
              q ? shown.length + " / " + allRows.length : allRows.length + " 项")),
          React.createElement(
            "div", { className: "harm-props" },
            React.createElement(
              "div", { className: "harm-propsSearch" },
              React.createElement("input", {
                className: "harm-propsSearchInput", value: propsQuery,
                placeholder: "搜索属性名或值（如 bounds、opacity、tv_stock）",
                spellCheck: false, autoComplete: "off",
                onChange: (e) => setPropsQuery(e.target.value),
              }),
              propsQuery
                ? React.createElement("button", { type: "button", className: "harm-btn", style: { height: "24px", padding: "0 8px", fontSize: "11px" }, onClick: () => setPropsQuery("") }, "清除")
                : null,
            ),
            React.createElement("div", { className: "harm-propsHead" },
              // 与 UI 树同一取值：`#` + accessibilityId（设备无障碍 id，每节点唯一）。
              // 曾经这里用 `index`（扁平数组下标）而树用 accessibilityId，两个 `#数字`
              // 对不上——同一个节点必须在两处显示同一个数。
              "#" + (selNode.accessibilityId || selNode.devId || selNode.index) + " " + (selNode.componentName || selNode.className || "Node")),
            React.createElement(HarmonyBoxModel, { node: selNode }),
            q && shown.length === 0
              ? React.createElement("div", { className: "harm-propsEmpty" }, "没有匹配「" + propsQuery + "」的属性")
              : table,
          ),
        );
      } else {
        propsPane = React.createElement(
          "div", { className: "harm-inspColBot" },
          React.createElement("div", { className: "harm-inspTitle" }, "节点属性"),
          React.createElement("div", { className: "harm-props" },
            React.createElement("div", { className: "harm-propsEmpty" }, "在左侧截图或右上 UI 树中选择一个节点，查看属性与盒子模型")),
        );
      }

      // ---- 操作区 ----
      const ops = React.createElement(
        "div", { className: "harm-ops" },
        React.createElement(
          "div", { className: "harm-opsRow" },
          React.createElement("span", { className: "harm-opsLabel" }, "Tap"),
          React.createElement("button", { className: "harm-btn", disabled: busy || !selNode, onClick: doTap }, "点击选中节点"),
        ),
        React.createElement(
          "div", { className: "harm-opsRow" },
          React.createElement("span", { className: "harm-opsLabel" }, "Swipe"),
          ["x1", "y1", "x2", "y2", "speed"].map((k) =>
            React.createElement("input", {
              key: k, className: "harm-input", value: swipe[k], placeholder: k,
              onChange: (e) => setSwipe({ ...swipe, [k]: e.target.value }),
            })),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doSwipe }, "执行"),
        ),
        React.createElement(
          "div", { className: "harm-opsRow" },
          React.createElement("span", { className: "harm-opsLabel" }, "Text"),
          React.createElement("input", { className: "harm-input", style: { maxWidth: "240px" }, value: textInput, placeholder: "输入文本", onChange: (e) => setTextInput(e.target.value) }),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doText }, "输入"),
        ),
      );

      // ---- 窗口选择器 ----
      // 窗口选项来自 `ui window list`（有名字 + focused 标记）。**不提供「全部窗口」**
      // —— 全量渲染数量太多会卡顿，必须固定选中一个窗口（默认前台）。
      const windowOptions = windows.map((w) => ({
        id: w.id,
        label: (w.name || "窗口 " + w.id) + (w.focused ? "（前台）" : ""),
        focused: !!w.focused,
      }));
      // 树源切换：DevEco 调试源（ark socket，带盒模型声明值与组件名；需 debug
      // 应用且 IDE Inspector 面板未占用）/ 无障碍树（uitest，适合已发布应用）。
      // 切换即重抓。（hidumper 通路已废弃删除。）
      const treeSourceSelect = React.createElement(
        "label", { className: "harm-winSel", title: "DevEco 调试源＝应用侧 ark 调试 socket（唯一带 padding/margin/border 声明值与组件名，需 debug 包 + aa attach，且 DevEco Studio 的 Inspector 面板开着时会占用唯一连接）；无障碍树＝uitest（适合已发布应用，属性最全）" },
        React.createElement("span", { className: "harm-winSelLabel" }, "树源"),
        React.createElement(
          "select",
          {
            className: "harm-winSelSelect", value: treeSource, disabled: busy,
            onChange: (e) => { const v = e.target.value; setTreeSource(v); doDump(windowId, v); },
          },
          React.createElement("option", { value: "deveco" }, "DevEco 调试源（盒模型+组件名）"),
          React.createElement("option", { value: "uitest" }, "无障碍树（uitest · 已发布）"),
        ),
      );
      const windowSelect = React.createElement(
        "label", { className: "harm-winSel", title: treeSource === "deveco" ? "DevEco 调试源按应用抓取，不区分窗口" : undefined },
        React.createElement("span", { className: "harm-winSelLabel" }, "窗口"),
        React.createElement(
          "select",
          {
            className: "harm-winSelSelect", value: windowId, disabled: busy || treeSource === "deveco",
            onChange: (e) => { const v = e.target.value; setWindowId(v); doDump(v, treeSource); },
          },
          windowOptions.map((o) =>
            React.createElement("option", { value: String(o.id), key: o.id }, o.label)),
        ),
      );

      return React.createElement(
        "div", { className: "harm-page harm-pane" },
        React.createElement(
          "div", { className: "harm-head" },
          React.createElement("h3", { className: "harm-head-title" }, "ArkUI Inspector"),
          React.createElement("span", { className: "harm-badge " + badge.cls }, badge.label),
        ),
        React.createElement(
          "div", { className: "harm-row" },
          React.createElement(DevicePicker, { devices, device, setDevice, refresh: refreshDevices, busy }),
          treeSourceSelect,
          windowSelect,
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: () => doDump(windowId, treeSource) }, busy ? "抓取中…" : "Dump UI"),
          React.createElement("button", { className: "harm-btn", disabled: busy, onClick: doScreenshot }, "截图"),
        ),
        React.createElement(
          "div", { className: "harm-insp" },
          React.createElement(
            "div", { className: "harm-inspCol" },
            React.createElement("div", { className: "harm-inspTitle" }, "设备截图"),
            shotPane,
            React.createElement("div", { className: "harm-shotHint" }, shot ? "点击截图可选中对应节点（蓝框）" : ""),
          ),
          React.createElement(
            "div", { className: "harm-inspCol" },
            treePane,
            propsPane,
          ),
        ),
        ops,
        errorMsg ? React.createElement("div", { className: "harm-error" }, errorMsg) : null,
      );
    }

    // ---- settings sections（设置页分区 + 设备管理） --------------------------
    /** Section header: small title + hairline rule. */
    function HarmonySectionHeader(props) {
      return React.createElement(
        "div", { className: "harm-secHead" },
        React.createElement("span", { className: "harm-secTitle" }, props.title),
        React.createElement("div", { className: "harm-secRule" }),
      );
    }

    /** hdc 的 TCP 目标以 `ip:port` 形式出现在设备列表里（USB 是串号）。 */
    function isNetworkSerial(serial) {
      return /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(String(serial || "").trim());
    }

    /**
     * Settings-page device management card: live device list (devecocli device
     * list) with per-row disconnect for network (ip:port) targets, plus the IP
     * connect form (`hdc tconn`). Connect/disconnect refresh the list.
     */
    function HarmonyDevicesCard() {
      const [devices, setDevices] = React.useState([]);
      const [loading, setLoading] = React.useState(false);
      const [busyKey, setBusyKey] = React.useState("");
      const [notice, setNotice] = React.useState(null); // { ok, text }
      const [ip, setIp] = React.useState("");
      const [port, setPort] = React.useState("");

      const refresh = React.useCallback(async () => {
        if (!remote) return;
        setLoading(true);
        try {
          const out = unwrap(await remote.deviceList());
          if (out.ok) {
            setDevices(Array.isArray(out.value && out.value.devices) ? out.value.devices : []);
          } else {
            setNotice({ ok: false, text: (out.error && (out.error.message || out.error.code)) || "获取设备列表失败" });
          }
        } catch (e) {
          setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
        } finally {
          setLoading(false);
        }
      }, []);

      React.useEffect(() => { refresh(); }, [refresh]);

      const disconnect = async (serial) => {
        const m = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d+)$/.exec(serial.trim());
        if (!m) return;
        setBusyKey(serial); setNotice(null);
        try {
          const out = unwrap(await remote.deviceDisconnectIp({ ip: m[1], port: Number(m[2]) }));
          if (out.ok) {
            setNotice({ ok: true, text: "已断开 " + ((out.value && out.value.address) || serial) });
          } else {
            setNotice({ ok: false, text: (out.error && (out.error.message || out.error.code)) || "断开失败" });
          }
          await refresh();
        } catch (e) {
          setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
        } finally {
          setBusyKey("");
        }
      };

      const connect = async () => {
        const ipTrim = ip.trim();
        if (!ipTrim) { setNotice({ ok: false, text: "请输入设备 IP 地址" }); return; }
        const portText = port.trim();
        // HarmonyOS hdc 无默认端口 —— 端口必填，须与设备开启的调试端口一致。
        if (!portText) { setNotice({ ok: false, text: "请输入端口号（设备开启调试时使用的端口）" }); return; }
        const portNum = Number(portText);
        if (!Number.isFinite(portNum) || portNum <= 0 || portNum > 65535 || Math.floor(portNum) !== portNum) {
          setNotice({ ok: false, text: "端口必须是 1–65535 的整数" });
          return;
        }
        setBusyKey("__connect__"); setNotice(null);
        try {
          const out = unwrap(await remote.deviceConnectIp({ ip: ipTrim, port: portNum }));
          if (out.ok) {
            setNotice({ ok: true, text: "已连接 " + ((out.value && out.value.address) || ipTrim) });
            setIp(""); setPort("");
          } else {
            setNotice({ ok: false, text: (out.error && (out.error.message || out.error.code)) || "连接失败" });
          }
          await refresh();
        } catch (e) {
          setNotice({ ok: false, text: e instanceof Error ? e.message : String(e) });
        } finally {
          setBusyKey("");
        }
      };

      const rows = devices.map((d, i) => {
        const net = isNetworkSerial(d.serial);
        return React.createElement(
          "div", { key: d.serial || i, className: "harm-devRow" },
          React.createElement("span", { className: "harm-devType" + (net ? " harm-devTypeNet" : "") }, net ? "网络" : "USB"),
          React.createElement("span", { className: "harm-devSerial", title: d.serial }, d.serial),
          d.name && d.name !== d.serial ? React.createElement("span", { className: "harm-devName" }, d.name) : null,
          net ? React.createElement("button", {
            type: "button", className: "harm-devDiscard", disabled: busyKey === d.serial,
            onClick: () => disconnect(d.serial),
          }, busyKey === d.serial ? "断开中…" : "断开") : null,
        );
      });

      const busy = busyKey !== "";

      return React.createElement(
        "div", { className: "harm-fieldRow" },
        React.createElement(
          "div", { className: "harm-fieldHead" },
          React.createElement("label", { className: "harm-fieldLabel" }, "设备列表"),
          loading ? React.createElement("span", { className: "harm-fieldHint" }, "获取中…") : null,
          React.createElement("button", { type: "button", className: "harm-btn", disabled: busy, onClick: refresh }, "刷新"),
        ),
        rows.length > 0
          ? React.createElement("div", { className: "harm-devList" }, rows)
          : React.createElement("p", { className: "harm-fieldHint" }, "未发现设备。USB 连接后点「刷新」；或用下方 IP 连接。"),
        React.createElement(
          "div", { className: "harm-fieldHead", style: { marginTop: "4px" } },
          React.createElement("label", { className: "harm-fieldLabel" }, "IP 网络连接（hdc tconn）"),
        ),
        React.createElement(
          "div", { className: "harm-ipRow" },
          React.createElement("input", {
            className: "harm-fieldInput", placeholder: "设备 IP，如 192.168.0.100",
            value: ip, disabled: busy, spellCheck: false, autoComplete: "off",
            onChange: (e) => setIp(e.target.value),
          }),
          React.createElement("input", {
            className: "harm-fieldInput harm-ipPort", placeholder: "端口（必填）",
            value: port, disabled: busy, spellCheck: false, autoComplete: "off", inputMode: "numeric",
            onChange: (e) => setPort(e.target.value),
          }),
          React.createElement("button", {
            type: "button", className: "harm-cardSave", disabled: busy, onClick: connect,
          }, busyKey === "__connect__" ? "连接中…" : "连接"),
        ),
        React.createElement("p", { className: "harm-fieldHint" },
          "通过局域网 TCP 连接设备。需先在设备「设置 → 开发者选项」中开启调试，再填写设备的 IP 和端口（hdc 无默认端口，须与设备上的一致）；连接成功后上方列表会出现 ip:port 目标，可直接「断开」。"),
        notice ? React.createElement("p", { className: notice.ok ? "harm-ipOk" : "harm-cardError" }, notice.text) : null,
      );
    }

    function HarmonySettingsPage(props) {
      const [resolved, setResolved] = React.useState(null);
      const [discovery, setDiscovery] = React.useState(null);
      // Saved values (mirrored from the Host config) and staged drafts.
      const [savedStudio, setSavedStudio] = React.useState("");
      const [savedClt, setSavedClt] = React.useState("");
      const [studioDraft, setStudioDraft] = React.useState("");
      const [cltDraft, setCltDraft] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [errorMsg, setErrorMsg] = React.useState("");

      // Single source of truth: the Host config.json via the harmonyDevEco
      // Remote. `getConfig` returns `{ config, resolved, discovery }`.
      const loadToolchainState = React.useCallback(async () => {
        if (!remote) return;
        try {
          const r = await remote.getConfig();
          const out = unwrap(r);
          if (out.ok && out.value) {
            const cfg = out.value.config || {};
            const s = typeof cfg.studioPath === "string" ? cfg.studioPath : "";
            const c = typeof cfg.cltPath === "string" ? cfg.cltPath : "";
            setSavedStudio(s);
            setSavedClt(c);
            setStudioDraft(s);
            setCltDraft(c);
            setResolved(out.value.resolved || null);
            setDiscovery(out.value.discovery || null);
          }
        } catch (e) { /* */ }
      }, []);

      React.useEffect(() => { loadToolchainState(); }, [loadToolchainState]);

      const dirty = studioDraft !== savedStudio || cltDraft !== savedClt;

      const discard = () => {
        setStudioDraft(savedStudio);
        setCltDraft(savedClt);
        setErrorMsg("");
      };

      // Single save point: CLT wins over Studio; an empty draft clears its
      // field; the Host enforces the mutual exclusion on every write.
      const save = async () => {
        if (!remote) return;
        setBusy(true); setErrorMsg("");
        try {
          const c = cltDraft.trim();
          const s = studioDraft.trim();
          let out;
          if (c) {
            // Host mutex: writing CLT clears studioPath.
            out = unwrap(await remote.setCltPath({ path: c }));
          } else if (s) {
            // Host mutex: writing Studio clears cltPath.
            out = unwrap(await remote.setStudioPath({ path: s }));
          } else {
            // Both drafts empty → clear both fields.
            out = unwrap(await remote.setStudioPath({ path: "" }));
            if (out.ok) out = unwrap(await remote.setCltPath({ path: "" }));
          }
          if (!out || !out.ok) {
            setErrorMsg((out && out.error && (out.error.message || out.error.code)) || "保存失败");
            return;
          }
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

      const badge = toolchainBadgeFor(resolved);

      const studios = discovery && Array.isArray(discovery.studios) ? discovery.studios : [];
      const clts = discovery && Array.isArray(discovery.clts) ? discovery.clts : [];

      const studioField = React.createElement(
        "div", { className: "harm-fieldRow" },
        React.createElement("div", { className: "harm-fieldHead" },
          React.createElement("label", { className: "harm-fieldLabel" }, "DevEco Studio 路径"),
        ),
        React.createElement("input", {
          className: "harm-fieldInput", type: "text", value: studioDraft,
          placeholder: "C:\\Program Files\\Huawei\\DevEco Studio",
          onChange: (e) => setStudioDraft(e.target.value),
        }),
        studios.length > 0
          ? React.createElement("div", { className: "harm-discovery" },
              studios.map((s, i) =>
                React.createElement("button", {
                  key: i, type: "button", className: "harm-discoveryItem",
                  title: s.path, disabled: busy,
                  onClick: () => setStudioDraft(s.path),
                }, s.path),
              ),
            )
          : React.createElement("p", { className: "harm-fieldHint" }, "暂无自发现结果；可手动填写，或点下方「重新扫描」。"),
      );

      const cltField = React.createElement(
        "div", { className: "harm-fieldRow" },
        React.createElement("div", { className: "harm-fieldHead" },
          React.createElement("label", { className: "harm-fieldLabel" }, "HarmonyOS Command Line Tools（≥ 26.0.0）"),
        ),
        React.createElement("input", {
          className: "harm-fieldInput", type: "text", value: cltDraft,
          placeholder: "C:\\Program Files\\Huawei\\Command Line Tools\\26.0.0",
          onChange: (e) => setCltDraft(e.target.value),
        }),
        clts.length > 0
          ? React.createElement("div", { className: "harm-discovery" },
              clts.map((c, i) =>
                React.createElement("button", {
                  key: i, type: "button", className: "harm-discoveryItem",
                  title: c.path, disabled: busy,
                  onClick: () => setCltDraft(c.path),
                }, c.path + "  ·  " + c.version),
              ),
            )
          : React.createElement("p", { className: "harm-fieldHint" }, "暂无自发现结果；可手动填写，或点下方「重新扫描」。"),
      );

      return React.createElement(
        "div", { className: "harm-page" },
        React.createElement(
          "div", { className: "harm-head" },
          React.createElement("h2", { className: "harm-head-title" }, "HarmonyOS Suite"),
          React.createElement("span", {
            className: "harm-cardBadge " + badge.cls,
            title: badge.title,
          }, badge.label),
        ),
        React.createElement(HarmonySectionHeader, { title: "工具链" }),
        React.createElement("p", { className: "harm-cardDescription" },
          "DevEco Studio / Command Line Tools 路径、三平台自发现与互斥规则"),
        React.createElement(
          "p", { className: "harm-cardNote" },
          "两者互斥：保存 CLT 会清空 Studio，反之亦然；同时配置时优先 CLT（最低 26.0.0）。PATH 中存在 devecocli 时优先使用并忽略以下路径。",
        ),
        studioField,
        cltField,
        React.createElement(
          "div", { className: "harm-cardActions" },
          React.createElement("button", { type: "button", className: "harm-btn", disabled: busy, onClick: rescan }, "重新扫描"),
          React.createElement("span", { style: { flex: 1 } }),
          dirty ? React.createElement("span", { className: "harm-cardPending" }, "未保存") : null,
          errorMsg ? React.createElement("span", { className: "harm-cardError" }, errorMsg) : null,
          React.createElement("button", { type: "button", className: "harm-cardDiscard", disabled: !dirty || busy, onClick: discard }, "放弃"),
          React.createElement("button", { type: "button", className: "harm-cardSave", disabled: (!dirty && !busy) || busy, onClick: save }, busy ? "保存中…" : "保存"),
        ),
        React.createElement(HarmonySectionHeader, { title: "设备管理" }),
        React.createElement(HarmonyDevicesCard, null),
      );
    }

    // ---- guide artworks ----------------------------------------------------
    // Built-in guide entries (terminal/files/…) use flat, chunky, brand-color
    // artwork glyphs (36×36 viewBox, fill-based, ~3.5 stroke). Plain
    // currentColor Lucide strokes look washed out next to them, so our entries
    // follow the same visual language and the same #679EFE/#658EFF/#4561EE +
    // #A797FC/#A23AE7 palette as dsh-client-ui-primitives' PluginArtwork*.
    /** HiLog tab artwork: three log rows (dot + line) in descending blues. */
    function HarmonyLogArtwork(props) {
      const size = props.size || 36;
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 36 36", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("circle", { cx: 8.5, cy: 11, r: 2.6, fill: "#679EFE" }),
        React.createElement("path", { d: "M15 11H28", stroke: "#679EFE", strokeWidth: 3.4, strokeLinecap: "round" }),
        React.createElement("circle", { cx: 8.5, cy: 18, r: 2.6, fill: "#658EFF" }),
        React.createElement("path", { d: "M15 18H28", stroke: "#658EFF", strokeWidth: 3.4, strokeLinecap: "round" }),
        React.createElement("circle", { cx: 8.5, cy: 25, r: 2.6, fill: "#4561EE" }),
        React.createElement("path", { d: "M15 25H23.5", stroke: "#4561EE", strokeWidth: 3.4, strokeLinecap: "round" }),
      );
    }

    /** ArkUI tab artwork: UI containment tree (one root, two children). */
    function HarmonyTreeArtwork(props) {
      const size = props.size || 36;
      return React.createElement(
        "svg",
        { width: size, height: size, viewBox: "0 0 36 36", fill: "none", xmlns: "http://www.w3.org/2000/svg" },
        React.createElement("path", {
          d: "M18 13.5v3.5M18 17H11v3.5M18 17h7v3.5",
          stroke: "#A797FC", strokeWidth: 3, strokeLinecap: "round", strokeLinejoin: "round",
        }),
        React.createElement("rect", { x: 12.5, y: 6.5, width: 11, height: 7, rx: 2, fill: "#A23AE7" }),
        React.createElement("rect", { x: 5.5, y: 22.5, width: 11, height: 7, rx: 2, fill: "#A797FC" }),
        React.createElement("rect", { x: 19.5, y: 22.5, width: 11, height: 7, rx: 2, fill: "#658EFF" }),
      );
    }

    // ---- apply() ----------------------------------------------------------
    // Official right-sidebar tab ids (tab definition id == body slot key).
    const TAB_HILOG_ID = "dsh-deveco:hilog";
    const TAB_ARKUI_ID = "dsh-deveco:arkui";
    const VIEWER_ARKTS_ID = "dsh-deveco:arkts";

    async function apply(ctx) {
      // Mount the harmonyDevEco namespace before anything touches it.
      // The browser-side `ctx.remote.harmonyDevEco` is a Proxy namespace created
      // by $mount; reading the same key on the bundle's own ctx via ctx.get()
      // resolves the namespace object.
      await ctx.remote.$mount(CLIENT_REMOTE);
      // Bind the services into the FACTORY-scope variables declared above (the
      // components are defined at factory scope for stable React identity, so
      // a closure declared inside apply() would never be visible to them).
      remote = ctx.get("remote.harmonyDevEco");
      // The official workspace-files Remote (mounted asynchronously by
      // dsh-api-remotes) pages UTF-8 content for the .ets viewer. Capture the
      // ctx and resolve the namespace LAZILY at read time (workspaceFilesRemote)
      // — a one-shot ctx.get() here races the official $mount and caches null.
      clientCtx = ctx;
      // 挂起等待官方命名空间（blessed 机制：服务出现时回调；未出现则不阻塞）。
      try {
        if (typeof ctx.inject === "function") {
          ctx.inject(["remote.workspaceFiles"], (injected) => {
            try {
              const ns = injected.get ? injected.get("remote.workspaceFiles") : null;
              if (ns) parkedWorkspaceFiles = ns;
            } catch (e) { /* 读取时再兜底 */ }
          });
        }
      } catch (e) { /* 读取时懒解析兜底 */ }

      const styleTag = document.createElement("style");
      styleTag.textContent = CSS;
      document.head.appendChild(styleTag);
      ctx.effect(() => () => styleTag.remove());

      ctx.effect(() => registerSettingsNavIcon(SETTINGS_LABEL));

      // ---- Official right sidebar (DSH 0.2.0 sidebarRightTabs) -------------
      // Two-stage registration, mirroring the proven pattern:
      //   stage 1 — `tabs.register({id, kind, ...})` declares the tab type;
      //   stage 2 — a keyed `sidebar.right.pane.tab` slot binds the body
      //             component to that id. A slot registration can fail after
      //             the type registration succeeded (context disposal races),
      //             so disposers are collected as handed out and the partial
      //             set is rolled back on error.
      const seat = ctx.inject(["sidebarRightTabs"], (injected) => {
        const tabs = injected.get("sidebarRightTabs");
        if (tabs === undefined) return undefined;
        const disposers = [];
        const registerBodySlot = (id, component) => {
          disposers.push(ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
            name: "sidebar.right.pane.tab",
            key: id,
            inject: (sessionId) => ({ sessionId: sessionId }),
          }, component)));
        };
        try {
          disposers.push(tabs.register({
            id: TAB_HILOG_ID,
            kind: "harmony-hilog",
            priority: "extension",
            title: () => "HiLog 检查器",
            guide: [{
              id: "harmony-hilog",
              order: 50,
              title: () => "HiLog 检查器",
              description: () => "HarmonyOS 设备实时日志流（hdc hilog -f），支持级别 / 包名 / 关键词过滤。",
              icon: (p) => React.createElement(HarmonyLogArtwork, { size: (p && p.size) || 36 }),
            }],
          }));
          registerBodySlot(TAB_HILOG_ID, HarmonyHiLogTab);

          disposers.push(tabs.register({
            id: TAB_ARKUI_ID,
            kind: "harmony-arkui",
            priority: "extension",
            title: () => "ArkUI Inspector",
            guide: [{
              id: "harmony-arkui",
              order: 51,
              title: () => "ArkUI Inspector",
              description: () => "UI 树 dump（点节点自动填充 tap 坐标）、截图、Tap / Swipe / 文本输入。",
              icon: (p) => React.createElement(HarmonyTreeArtwork, { size: (p && p.size) || 36 }),
            }],
          }));
          registerBodySlot(TAB_ARKUI_ID, HarmonyArkUITab);

          // .ets file viewer: one tab per file, preferred over the built-in
          // text editor by the extension priority band.
          disposers.push(tabs.register({
            id: VIEWER_ARKTS_ID,
            kind: "arkts-source",
            multiple: true,
            patterns: ["dsh-resource://file/**"],
            canOpen: (address) => {
              const file = parseFileAddress(address);
              return file !== undefined && /\.ets$/i.test(file.path);
            },
            priority: "extension",
            title: (address) => fileTitleOf(address),
          }));
          registerBodySlot(VIEWER_ARKTS_ID, ArkTSViewerTab);
        } catch (error) {
          for (let i = disposers.length - 1; i >= 0; i--) {
            try { disposers[i](); } catch (e) { /* best effort rollback */ }
          }
          throw error;
        }
        return () => {
          for (let i = disposers.length - 1; i >= 0; i--) {
            try { disposers[i](); } catch (e) { /* best effort dispose */ }
          }
        };
      });
      ctx.effect(() => seat);

      // Settings page (DSH 0.2.0 `settings.section`, list scope root): an own
      // entry in the settings navigation labeled "HarmonyOS Suite" (the
      // registerSettingsNavIcon observer above restyles its gear icon).
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "harmony-deveco",
        order: 40,
        label: () => "HarmonyOS Suite",
      }, HarmonySettingsPage));
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});