#!/usr/bin/env node

/**
 * Extract exactly one released version from CHANGELOG.md for GitHub Releases.
 * Accepted headings: `## [0.6.0] - ...`, `## 0.6.0 - ...`, or their v-prefixed forms.
 * The next level-two heading terminates the section, so older releases never leak in.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const tag = String(process.argv[2] || '').trim()
if (!tag) {
  console.error('用法：node scripts/extract-release-notes.mjs <vX.Y.Z>')
  process.exit(1)
}

const version = tag.replace(/^v/, '')
const changelogPath = resolve(process.cwd(), 'CHANGELOG.md')
let markdown
try {
  markdown = readFileSync(changelogPath, 'utf8')
} catch (error) {
  console.error(`无法读取 ${changelogPath}：${error.message}`)
  process.exit(1)
}

function headingVersion (line) {
  const match = line.match(/^##\s+(?:\[v?([0-9][^\]]*)\]|v?([0-9]\S*))(?:\s|$)/)
  return match ? (match[1] || match[2]) : ''
}

const lines = markdown.replace(/^﻿/, '').split(/\r?\n/)
const matches = lines
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => headingVersion(line) === version)

if (matches.length !== 1) {
  console.error(matches.length === 0
    ? `CHANGELOG.md 中找不到标签 ${tag} 对应的版本 ${version}。请先添加 \"## [${version}] - YYYY-MM-DD\" 段落再发布。`
    : `CHANGELOG.md 中版本 ${version} 出现了 ${matches.length} 次，请保留唯一发布段落。`)
  process.exit(1)
}

const start = matches[0].index
let end = lines.length
for (let index = start + 1; index < lines.length; index++) {
  if (/^##\s+/.test(lines[index])) {
    end = index
    break
  }
}

const notes = lines.slice(start, end).join('\n').trim()
if (!notes || notes === lines[start].trim()) {
  console.error(`CHANGELOG.md 的 ${version} 段落没有发布说明。`)
  process.exit(1)
}

process.stdout.write(`${notes}\n`)
