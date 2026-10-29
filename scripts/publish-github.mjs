/*
 * 把本目录推上 GitHub（无需 git / gh）。
 * 用法：node scripts/publish-github.mjs <token-file> [--repo name] [--private]
 * token 只从文件读，绝不打印。已有仓库则更新文件（按 sha 覆盖）。
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const API = 'https://api.github.com'
const UA = 'dsh-cookie-meter-publisher'

const FILES = [
  'package.json',
  'index.js',
  'probe.js',
  'client.js',
  'cordis.patch.yml',
  'README.md',
  'LICENSE',
  '.gitignore',
  'scripts/smoke.mjs',
  'scripts/smoke-client.mjs',
  'scripts/smoke-boot.mjs',
  'scripts/publish-github.mjs',
]

const DESCRIPTION =
  'DSH 桌面版登录 cookie 百分表：浮窗显示请求头占用百分比（过半变红），带一键清理按钮，防止启动 72 次后被 431 挡住。'
const TOPICS = ['dsh-plugin', 'deepseek-harness', 'cookie', '431', 'windows', 'overlay']

function arg(name, fallback = '') {
  const index = process.argv.indexOf(name)
  if (index > 0 && process.argv[index + 1] !== undefined) return process.argv[index + 1]
  return fallback
}

const tokenFile = process.argv[2]
if (tokenFile === undefined) {
  console.error('usage: node scripts/publish-github.mjs <token-file> [--repo name] [--private]')
  process.exit(2)
}

const token = readFileSync(tokenFile, 'utf8').trim()
if (token === '') {
  console.error('token 文件是空的')
  process.exit(2)
}

const repoName = arg('--repo', 'dsh-cookie-meter')
const isPrivate = process.argv.includes('--private')

async function call(method, path, body, accept = 'application/vnd.github+json') {
  const res = await fetch(API + path, {
    method,
    headers: {
      authorization: 'Bearer ' + token,
      accept,
      'user-agent': UA,
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = text === '' ? null : JSON.parse(text)
  } catch {
    data = text
  }
  if (!res.ok) {
    const message = data !== null && typeof data === 'object' && data.message !== undefined ? data.message : text
    const error = new Error(`${method} ${path} -> ${res.status} ${message}`)
    error.status = res.status
    throw error
  }
  return data
}

const me = await call('GET', '/user')
const owner = me.login
console.log(`token 属于 ${owner}`)

let repo
try {
  repo = await call('GET', `/repos/${owner}/${repoName}`)
  console.log(`仓库已存在：${repo.html_url}（将更新文件）`)
} catch (err) {
  if (err.status !== 404) throw err
  repo = await call('POST', '/user/repos', {
    name: repoName,
    description: DESCRIPTION,
    homepage: '',
    private: isPrivate,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  })
  console.log(`仓库已创建：${repo.html_url}`)
}

if (repo.default_branch !== 'main') {
  try {
    await call('PATCH', `/repos/${owner}/${repoName}`, { default_branch: 'main' })
  } catch {
    /* 空仓库时忽略 */
  }
}

for (const file of FILES) {
  const absolute = join(root, ...file.split('/'))
  const content = readFileSync(absolute, 'utf8')
  const encoded = Buffer.from(content, 'utf8').toString('base64')
  const path = `/repos/${owner}/${repoName}/contents/${file.split('/').map(encodeURIComponent).join('/')}`

  let sha
  try {
    const existing = await call('GET', path + '?ref=main')
    sha = existing.sha
  } catch (err) {
    if (err.status !== 404) throw err
  }

  await call('PUT', path, {
    message: sha === undefined ? `add ${file}` : `update ${file}`,
    content: encoded,
    branch: 'main',
    ...(sha === undefined ? {} : { sha }),
  })
  console.log(`  ${sha === undefined ? '+' : '~'} ${file} (${Buffer.byteLength(content)} B)`)
}

try {
  await call('PUT', `/repos/${owner}/${repoName}/topics`, { names: TOPICS }, 'application/vnd.github+json')
  console.log('topics: ' + TOPICS.join(', '))
} catch (err) {
  console.log('topics 设置失败（可忽略）：' + err.message)
}

await call('PATCH', `/repos/${owner}/${repoName}`, { description: DESCRIPTION, homepage: `${repo.html_url}#readme` })

console.log('\n完成：' + repo.html_url)
console.log('仓库相对路径：' + relative(process.cwd(), root).split(sep).join('/') || basename(root))
