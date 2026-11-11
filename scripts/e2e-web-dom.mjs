// dsh-deveco — ArkWeb Web DOM 端到端探针（不依赖设备/DSH）。
//
// 用 scripts/cdp-fixture.mjs 起一个真实 HTTP + RFC6455 服务端，跑通插件实际
// 使用的链路：/json → /devtools/page/<id> 标准 WebSocket → DOM.getDocument →
// DOM.querySelector / describeNode / getOuterHTML → 归一化 → 关闭。
//
// 用法：node scripts/e2e-web-dom.mjs

import assert from 'node:assert/strict'
import { startCdpFixture } from './cdp-fixture.mjs'
import {
  fetchDevToolsJson,
  parseDevToolsTargets,
  selectWebTarget,
  readWebDom,
  WebDevToolsSession,
} from '../harmony-webdevtools.mjs'

async function main () {
  const fixture = await startCdpFixture()
  try {
    const payload = await fetchDevToolsJson(fixture.port, '/json')
    const targets = parseDevToolsTargets(payload)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].id, 'TARGET-A')
    assert.equal(targets[0].type, 'page')
    const selected = selectWebTarget(targets, 'TARGET-A')
    assert.ok(selected)

    const all = await readWebDom({
      port: fixture.port,
      targetId: selected.id,
      depth: 8,
      maxNodes: 100,
      includeAttrs: true,
      includeHtml: true,
      timeoutMs: 5000,
    })
    assert.equal(all.nodeCount, 7)
    assert.equal(all.nodes.length, 7)
    const app = all.nodes.find((node) => node.tag === 'div')
    assert.ok(app)
    assert.equal(app.id, 'app')
    assert.deepEqual(app.classes, ['classA'])
    assert.equal(app.attributes['data-x'], '1')
    assert.match(all.html, /<div id="app" class="classA" data-x="1">/)
    assert.match(all.html, /Hello/)

    const subtree = await readWebDom({
      port: fixture.port,
      targetId: selected.id,
      selector: 'div#app',
      depth: 2,
      maxNodes: 100,
      includeHtml: true,
      timeoutMs: 5000,
    })
    assert.equal(subtree.nodes[0].tag, 'div')
    assert.equal(subtree.nodes[0].depth, 0)
    assert.ok(subtree.nodes.some((node) => node.tag === 'p'))
    assert.ok(subtree.nodes.some((node) => node.tag === '#text'))
    assert.match(subtree.html, /<div id="app" class="classA" data-x="1">/)

    await assert.rejects(
      readWebDom({
        port: fixture.port,
        targetId: selected.id,
        selector: '#missing',
        timeoutMs: 5000,
      }),
      (error) => error.code === 'selector-not-found',
    )

    const session = new WebDevToolsSession({
      port: fixture.port,
      targetId: selected.id,
      timeoutMs: 5000,
    })
    await session.connect()
    await assert.rejects(
      session.request('DOM.notSupported'),
      (error) => error.code === 'cdp-error' && /method not found/.test(error.message),
    )
    await session.close()

    assert.ok(fixture.calls.some((call) => call.method === 'DOM.getDocument'))
    assert.ok(fixture.calls.some((call) => call.method === 'DOM.querySelector'))
    assert.ok(fixture.calls.some((call) => call.method === 'DOM.describeNode'))
    assert.ok(fixture.calls.some((call) => call.method === 'DOM.getOuterHTML'))
    assert.equal(fixture.handshakes[0].path, '/devtools/page/TARGET-A')
    assert.equal(fixture.handshakes[0].headers.host, `127.0.0.1:${fixture.port}`)
    assert.equal(fixture.handshakes[0].headers.origin, undefined, '不得发送 Origin（Chromium CDP 默认拒绝非白名单来源）')
    assert.equal(fixture.handshakes[0].headers['sec-websocket-key'].length > 0, true)
    assert.equal(fixture.httpRequests[0].path, '/json')

    console.log('Web DOM e2e: PASS')
    console.log(`  targets=${targets.length} nodes=${all.nodes.length} subtree=${subtree.nodes.length}`)
    console.log(`  CDP methods=${fixture.calls.map((call) => call.method).join(', ')}`)
    console.log(`  WS path=${fixture.handshakes[0].path} Origin=absent`)
  } finally {
    await fixture.close()
  }
}

main().catch((error) => {
  console.error('Web DOM e2e: FAIL')
  console.error(error)
  process.exitCode = 1
})
