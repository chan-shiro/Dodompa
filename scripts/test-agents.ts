#!/usr/bin/env npx tsx
/**
 * エージェント単体テストスクリプト（開発用、後で消すかも）
 *
 * 使い方:
 *   npx tsx scripts/test-agents.ts <agent-name> [options]
 *
 * 例:
 *   npx tsx scripts/test-agents.ts planning --instruction "Googleで甲府市を検索"
 *   npx tsx scripts/test-agents.ts exploratory --instruction "..." --goal "..." --url "https://..."
 *   npx tsx scripts/test-agents.ts recon --url "https://www.city.kofu.yamanashi.jp/..." --deep
 *   npx tsx scripts/test-agents.ts scan --url "https://example.com"
 *   npx tsx scripts/test-agents.ts verify --description "..." --shared '{"key":"val"}'
 *   npx tsx scripts/test-agents.ts actionplan --description "..." --url "https://..." --html "<html>..."
 *
 * 環境変数:
 *   ANTHROPIC_API_KEY — Anthropic APIキー（必須）
 *   DODOMPA_MODEL — モデル名（default: claude-sonnet-4-20250514）
 */

import { chromium, type Page, type BrowserContext } from 'playwright-core'

// ─── AI Config helper ───

function getConfig() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY が設定されていません')
    process.exit(1)
  }
  return {
    id: 'test',
    name: 'Test Anthropic',
    type: 'anthropic' as const,
    apiKey,
    model: process.env.DODOMPA_MODEL ?? 'claude-sonnet-4-20250514',
    isActive: true,
  }
}

// ─── Arg parser ───

function getArg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return process.argv[idx + 1]
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

// ─── Browser helper ───

async function withBrowser<T>(fn: (page: Page, context: BrowserContext) => Promise<T>): Promise<T> {
  const browser = await chromium.launch({ headless: false })
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    return await fn(page, context)
  } finally {
    await context.close()
    await browser.close()
  }
}

// ─── Fake BrowserWindow (sends to console) ───

const fakeWin = {
  webContents: {
    send: (_channel: string, event: unknown) => {
      const e = event as { phase?: string; message?: string }
      if (e.message) console.log(`  [${e.phase ?? '?'}] ${e.message}`)
    },
  },
  isDestroyed: () => false,
} as unknown as import('electron').BrowserWindow

// ─── Test: planSteps ───

async function testPlanning() {
  const { planSteps } = await import('../src/main/ipc/agents/planningAgent')
  const config = getConfig()
  const instruction = getArg('instruction') ?? 'Googleでplaywright公式サイトを検索して最初の結果をクリック'
  const goal = getArg('goal')

  console.log('\n=== planSteps() テスト ===')
  console.log(`指示: ${instruction}`)
  if (goal) console.log(`目的: ${goal}`)

  const result = await planSteps(config, fakeWin, 'test-task', instruction, [], goal)

  console.log('\n--- 結果 ---')
  console.log(`ステップ数: ${result.plan.length}`)
  for (const step of result.plan) {
    console.log(`  [${step.type}] ${step.name}: ${step.description.slice(0, 100)}...`)
  }
  console.log(`変数: ${JSON.stringify(result.detectedVariables, null, 2)}`)
  console.log(`トークン: ${result.planResult.usage?.totalTokens ?? 'N/A'}`)
}

// ─── Test: exploratoryPlan ───

async function testExploratory() {
  const { exploratoryPlan } = await import('../src/main/ipc/agents/exploratoryPlanAgent')
  const config = getConfig()
  const instruction = getArg('instruction') ?? 'https://www.city.kofu.yamanashi.jp にアクセスして公募情報を確認'
  const goal = getArg('goal') ?? '甲府市の公募案件一覧をCSVにまとめる'

  console.log('\n=== exploratoryPlan() テスト ===')
  console.log(`指示: ${instruction}`)
  console.log(`目的: ${goal}`)

  await withBrowser(async (page) => {
    const result = await exploratoryPlan(config, fakeWin, 'test-task', instruction, goal, page, [])

    console.log('\n--- 結果 ---')
    console.log(`ステップ数: ${result.plan.length}`)
    for (const step of result.plan) {
      console.log(`  [${step.type}] ${step.name}: ${step.description.slice(0, 120)}...`)
    }
    console.log(`変数: ${JSON.stringify(result.detectedVariables, null, 2)}`)
    console.log(`トークン: ${result.planResult.usage?.totalTokens ?? 'N/A'}`)
  })
}

// ─── Test: reconBrowserPage ───

async function testRecon() {
  const { reconBrowserPage } = await import('../src/main/ipc/agents/reconAgent')
  const config = getConfig()
  const url = getArg('url') ?? 'https://www.city.kofu.yamanashi.jp/keyaku/business/nyusatsu/nyusatsu-sonota-kobogata.html'
  const deep = hasFlag('deep')

  console.log('\n=== reconBrowserPage() テスト ===')
  console.log(`URL: ${url}`)
  console.log(`深層偵察: ${deep ? 'ON' : 'OFF'}`)

  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })

    const siteMap = await reconBrowserPage(config, page, fakeWin, 'test-task', 0,
      { name: 'テスト', description: '公募情報を取得', type: 'browser' },
      { deepRecon: deep, forceRefresh: true },
    )

    console.log('\n--- 結果 ---')
    console.log(`URL: ${siteMap.url}`)
    console.log(`タイトル: ${siteMap.title}`)
    console.log(`リンク数: ${siteMap.linkCount}`)
    console.log(`要約: ${siteMap.summary}`)
    console.log(`URLパターン: ${siteMap.urlPatterns?.join('\n  ')}`)
    console.log(`候補: ${siteMap.candidatesForGoal?.map(c => `[${c.kind}] ${c.label}`).join(', ')}`)
    if (siteMap.subPages) {
      console.log(`\nサブページ (${siteMap.subPages.length}件):`)
      for (const sp of siteMap.subPages) {
        console.log(`  [${sp.contentType}] ${sp.sourceLabel} → ${sp.url}`)
      }
    }
    if (siteMap.deepScanReport) {
      console.log(`\n深層偵察レポート:\n${siteMap.deepScanReport}`)
    }
  })
}

// ─── Test: scanBrowserPage (deterministic, no AI) ───

async function testScan() {
  const { scanBrowserPage, deriveUrlPatterns } = await import('../src/main/ipc/agents/reconAgent')
  const url = getArg('url') ?? 'https://example.com'

  console.log('\n=== scanBrowserPage() テスト (AI不要) ===')
  console.log(`URL: ${url}`)

  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const facts = await scanBrowserPage(page)
    const patterns = deriveUrlPatterns(facts)

    console.log('\n--- 結果 ---')
    console.log(`タイトル: ${facts.title}`)
    console.log(`リンク: ${facts.linkCount}件`)
    console.log(`ボタン: ${facts.buttonCount}件`)
    console.log(`フォーム: ${facts.forms.length}件`)
    console.log(`見出し: ${facts.headings.map(h => `h${h.level}:${h.text}`).join(' | ')}`)
    console.log(`URLパターン: ${patterns.join('\n  ')}`)
    console.log(`PDFリンク: ${facts.links.filter(l => /\.pdf/i.test(l.href)).length}件`)

    // Show first 10 links
    console.log(`\n先頭10リンク:`)
    for (const l of facts.links.slice(0, 10)) {
      console.log(`  "${l.text.slice(0, 50)}" → ${l.href}`)
    }
  })
}

// ─── Test: verifyAgent ───

async function testVerify() {
  const { programmaticVerify } = await import('../src/main/ipc/agents/verifyAgent')
  const description = getArg('description') ?? 'データを取得して ctx.shared.items に格納する。post-condition: ctx.shared.items が非空の配列'
  const sharedStr = getArg('shared') ?? '{"items": [{"title": "test", "url": "https://example.com"}]}'
  const goal = getArg('goal')

  console.log('\n=== programmaticVerify() テスト (AI不要) ===')
  console.log(`description: ${description}`)
  console.log(`shared: ${sharedStr}`)
  if (goal) console.log(`goal: ${goal}`)

  const shared = JSON.parse(sharedStr)
  const result = programmaticVerify(description, shared, goal)

  console.log('\n--- 結果 ---')
  console.log(JSON.stringify(result, null, 2))
}

// ─── Test: actionPlan ───

async function testActionPlan() {
  const { generateActionPlan } = await import('../src/main/ipc/agents/actionPlanAgent')
  const config = getConfig()
  const description = getArg('description') ?? 'ページ内の案件リンクを全て取得して ctx.shared.items に格納する'
  const url = getArg('url') ?? 'https://example.com'
  const goal = getArg('goal')

  console.log('\n=== generateActionPlan() テスト ===')
  console.log(`description: ${description}`)
  console.log(`URL: ${url}`)

  await withBrowser(async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    const html = await page.content()
    const screenshot = (await page.screenshot()).toString('base64')

    const result = await generateActionPlan(config, fakeWin, 'test-task',
      { name: 'テスト', description, type: 'browser' },
      0, url, screenshot, '', html.slice(0, 6000), [],
      [], undefined, undefined, [], undefined, undefined, goal,
    )

    console.log('\n--- 結果 ---')
    console.log(`アクション数: ${result.actions.length}`)
    for (const a of result.actions) {
      console.log(`  [${a.action}] ${a.description.slice(0, 100)}`)
    }
    if (result.question) console.log(`質問: ${result.question.question}`)
    if (result.alreadyDone) console.log(`alreadyDone: true`)
  })
}

// ─── Test: diagnosis ───

async function testDiagnosis() {
  const { diagnoseFailure, suggestUntriedStrategies } = await import('../src/main/ipc/agents/failureDiagnosis')
  const error = getArg('error') ?? 'Failed to extract any item links from the page'
  const stage = (getArg('stage') ?? 'execute') as 'compile' | 'execute' | 'verify'

  console.log('\n=== diagnoseFailure() テスト (AI不要) ===')
  console.log(`error: ${error}`)
  console.log(`stage: ${stage}`)

  const diagnosis = diagnoseFailure({
    attempt: 1,
    rawError: error,
    stage,
    stepType: 'browser',
  })

  console.log('\n--- 診断結果 ---')
  console.log(`カテゴリ: ${diagnosis.category}`)
  console.log(`場所: ${diagnosis.where}`)
  console.log(`仮説: ${diagnosis.hypothesis}`)
  console.log(`証拠: ${diagnosis.evidence.join(', ')}`)

  const untried = suggestUntriedStrategies(diagnosis, [])
  console.log(`\n未試行戦略:`)
  for (const s of untried) console.log(`  - ${s}`)
}

// ─── Main ───

const agent = process.argv[2]

if (!agent) {
  console.log(`
使い方: npx tsx scripts/test-agents.ts <agent-name> [options]

利用可能なテスト:
  planning     — planSteps() (AI必要)
  exploratory  — exploratoryPlan() (AI + ブラウザ必要)
  recon        — reconBrowserPage() (AI + ブラウザ必要)
  scan         — scanBrowserPage() (ブラウザのみ、AI不要)
  verify       — programmaticVerify() (ローカルのみ、AI不要)
  actionplan   — generateActionPlan() (AI + ブラウザ必要)
  diagnosis    — diagnoseFailure() (ローカルのみ、AI不要)

共通オプション:
  --instruction "..."  タスク指示文
  --goal "..."         タスク目的
  --url "..."          対象URL
  --description "..."  ステップ説明
  --deep               深層偵察を有効化 (recon用)
  --error "..."        エラーメッセージ (diagnosis用)
  --shared '{"k":"v"}' ctx.shared (verify用)

環境変数:
  ANTHROPIC_API_KEY    APIキー (AI使うテスト用)
  DODOMPA_MODEL         モデル名 (default: claude-sonnet-4-20250514)
`)
  process.exit(0)
}

const tests: Record<string, () => Promise<void>> = {
  planning: testPlanning,
  exploratory: testExploratory,
  recon: testRecon,
  scan: testScan,
  verify: testVerify,
  actionplan: testActionPlan,
  diagnosis: testDiagnosis,
}

const testFn = tests[agent]
if (!testFn) {
  console.error(`❌ 不明なテスト: ${agent}`)
  console.error(`利用可能: ${Object.keys(tests).join(', ')}`)
  process.exit(1)
}

testFn().then(() => {
  console.log('\n✅ テスト完了')
  process.exit(0)
}).catch((err) => {
  console.error('\n❌ テスト失敗:', err)
  process.exit(1)
})
