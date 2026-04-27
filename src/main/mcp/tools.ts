/**
 * Tool registrations for the in-process MCP server.
 *
 * Tool set is 1:1 with the old `mcp/src/production.ts`; the difference is
 * that handlers now use `invokeIpc` / `emitIpc` / `dbQuery` (direct in-process
 * calls) instead of fetch() round-trips, since this runs inside the Electron
 * main process itself.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { invokeIpc, emitIpc, dbQuery } from './bridge'

function text(t: string) {
  return { content: [{ type: 'text' as const, text: t }] }
}

function json(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }] }
}

export function registerDodompaTools(server: McpServer): void {
  // ─── Task Management ───

  server.tool(
    'task_list',
    'タスク一覧を取得。各タスクのID、名前、説明、instruction（何をするか）、goal（最終成果物）、ステップ数、変数、最終更新日を返す。ユーザーの要求に合うタスクがあるか判断するため、毎回最初に呼ぶこと。',
    {},
    async () => {
      const tasks = await invokeIpc('task:list') as Array<{
        id: string; name: string; description?: string; instruction?: string;
        initialInstruction?: string; goal?: string; steps: unknown[];
        variables?: Array<{ key: string; label?: string; type?: string; required?: boolean }>;
        updatedAt: string;
      }>
      const summary = tasks.map(t => ({
        id: t.id,
        name: t.name,
        description: t.description || undefined,
        instruction: t.initialInstruction || t.instruction || undefined,
        goal: t.goal || undefined,
        stepCount: Array.isArray(t.steps) ? t.steps.length : 0,
        variables: t.variables?.map(v => ({
          key: v.key,
          label: v.label,
          required: v.required,
        })) ?? [],
        updatedAt: t.updatedAt,
      }))
      return json(summary)
    }
  )

  server.tool(
    'task_create',
    '新規タスクを作成する。名前を指定して空のタスクを作成。',
    { name: z.string().describe('タスク名') },
    async ({ name }) => {
      const task = await invokeIpc('task:create', name)
      return json(task)
    }
  )

  server.tool(
    'task_get',
    'タスクの詳細を取得（ステップ一覧、変数、instruction、goal を含む）。',
    { taskId: z.string().describe('タスクID') },
    async ({ taskId }) => {
      const task = await invokeIpc('task:get', taskId)
      return json(task)
    }
  )

  server.tool(
    'task_update',
    'タスクのメタデータを更新（name, description, instruction, goal, variables 等）。',
    {
      taskId: z.string().describe('タスクID'),
      data: z.record(z.string(), z.unknown()).describe('更新するフィールド（例: {"instruction": "...", "goal": "..."}）'),
    },
    async ({ taskId, data }) => {
      const task = await invokeIpc('task:update', taskId, data)
      return json(task)
    }
  )

  server.tool(
    'task_delete',
    'タスクとその全ステップファイルを削除する。',
    { taskId: z.string().describe('タスクID') },
    async ({ taskId }) => {
      await invokeIpc('task:delete', taskId)
      return text(`タスク ${taskId} を削除しました`)
    }
  )

  // ─── AI Generation (async: start → poll status) ───

  server.tool(
    'task_generate',
    'AI でタスクのステップを自動生成する(非同期)。**開始要求**して即座に返るので、必ず task_generation_status で完了 (phase="done") を確認すること。完了確認なしに「成功」と判断してはいけない。',
    {
      taskId: z.string().describe('タスクID'),
      instruction: z.string().describe('生成指示(ステップの説明)'),
    },
    async ({ taskId, instruction }) => {
      const startedAt = new Date().toISOString()
      emitIpc('ai:startAutonomousGeneration', { taskId, instruction })

      await new Promise(r => setTimeout(r, 1000))
      const rows = dbQuery(
        `SELECT phase, message, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' AND created_at >= '${startedAt}' ORDER BY created_at DESC LIMIT 1`
      ) as Array<{ phase: string; message: string; created_at: string }>

      if (rows.length === 0) {
        throw new Error(
          `task_generate リクエストは送信されたが、generation_step_logs に新規エントリがありません (${startedAt} 以降)。\n` +
          `生成プロセスが起動していない可能性があります。Dodompa アプリのログを確認してください。`
        )
      }

      return text(
        `⏳ 生成 *リクエスト* を送信しました (まだ完了していません)。\n` +
        `taskId: ${taskId}\n` +
        `since: ${startedAt}\n` +
        `最新フェーズ: [${rows[0].phase}] ${rows[0].message}\n\n` +
        `★ 必ず task_generation_status で完了 (phase="done" or "error") を確認してください。\n` +
        `★ 上の since の値を task_generation_status の since 引数に渡すこと (古い生成ログを誤参照しないため)。\n` +
        `★ task_generation_status を呼ぶまで「成功した」と判断してはいけません。`
      )
    }
  )

  server.tool(
    'task_list_pending_questions',
    '生成/実行中のステップが「ユーザーに問い合わせ」をしている場合、その質問一覧を取得する。' +
    'task_generation_status の結果が "⏳ 実行中" のまま進まない場合、質問で止まっている可能性がある。',
    { taskId: z.string().optional().describe('特定タスクの質問だけ取得する場合に指定。省略で全タスク。') },
    async ({ taskId }) => {
      const questions = await invokeIpc('ai:listPendingQuestions', taskId ?? undefined) as Array<{
        id: string; taskId: string; text: string; infoKey?: string; askedAt: string
      }>
      if (questions.length === 0) return text('待機中の質問はありません。')
      return json({
        count: questions.length,
        questions,
        _hint: '各質問の text をユーザーに見せ、回答を task_answer_question(questionId, answer) で返してください。',
      })
    }
  )

  server.tool(
    'task_answer_question',
    'タスク生成/実行中にAIがユーザーに問い合わせた質問に回答する。questionId は task_generation_status または task_list_pending_questions のレスポンスに含まれる。',
    {
      questionId: z.string().describe('質問ID (task_generation_status などのレスポンスから取得)'),
      answer: z.string().describe('ユーザーの回答文字列'),
    },
    async ({ questionId, answer }) => {
      const result = await invokeIpc('ai:answerQuestion', questionId, answer) as { ok: boolean; error?: string; taskId?: string }
      if (!result.ok) {
        throw new Error(result.error ?? '回答の送信に失敗しました')
      }
      return text(`✅ 回答を送信しました (taskId: ${result.taskId ?? '?'})。生成は続行されます。task_generation_status で進捗確認してください。`)
    }
  )

  server.tool(
    'task_generation_wait',
    'AI 生成の完了を待つ (サーバー側で定期ポーリング)。phase="done"/"error" になるか、ユーザー質問が出現するか、timeout に達するまでブロックする。' +
    '単発呼び出しで完了が待てるので、task_generation_status を手動でポーリングする代わりに使える。',
    {
      taskId: z.string().describe('タスクID'),
      since: z.string().optional().describe('task_generate のレスポンスで返ってきた since 値。必ず指定すること (指定しないと別セッションの古い生成を誤認する)。'),
      timeoutSec: z.number().optional().default(300).describe('最大待機秒数 (デフォルト 300 = 5分)'),
      pollIntervalMs: z.number().optional().default(2000).describe('ポーリング間隔 (デフォルト 2000ms)'),
    },
    async ({ taskId, since, timeoutSec, pollIntervalMs }) => {
      const sinceFilter = since ? `AND created_at >= '${since.replace(/'/g, "''")}'` : ''
      const deadline = Date.now() + timeoutSec * 1000
      let lastPhase = ''
      let lastMessage = ''

      while (Date.now() < deadline) {
        const pending = await invokeIpc('ai:listPendingQuestions', taskId) as Array<{
          id: string; taskId: string; text: string; infoKey?: string; askedAt: string
        }>
        if (pending.length > 0) {
          return json({
            status: '❓ ユーザー質問待ち',
            pendingQuestions: pending,
            lastPhase, lastMessage,
            _hint: 'task_answer_question(questionId, answer) で回答すると続行します。',
          })
        }

        const logs = dbQuery(
          `SELECT phase, message, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ${sinceFilter} ORDER BY created_at DESC LIMIT 1`
        ) as Array<{ phase: string; message: string; created_at: string }>

        if (logs.length > 0) {
          lastPhase = logs[0].phase
          lastMessage = logs[0].message
          if (lastPhase === 'done') {
            const recent = dbQuery(
              `SELECT phase, message, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ${sinceFilter} ORDER BY created_at DESC LIMIT 20`
            )
            return json({ status: '✅ 完了', lastPhase, lastMessage, recentLogs: recent })
          }
          if (lastPhase === 'error') {
            const recent = dbQuery(
              `SELECT phase, message, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ${sinceFilter} ORDER BY created_at DESC LIMIT 20`
            )
            return json({ status: '❌ エラー', lastPhase, lastMessage, recentLogs: recent })
          }
        }

        await new Promise(r => setTimeout(r, pollIntervalMs))
      }

      return json({
        status: '⏱️ タイムアウト',
        lastPhase, lastMessage,
        _hint: `${timeoutSec}秒以内に完了しませんでした。task_generation_status で最新状態を確認するか、timeoutSec を延ばして task_generation_wait を再度呼んでください。`,
      })
    }
  )

  server.tool(
    'task_cancel_generation',
    '実行中のAI生成をキャンセルする。',
    { taskId: z.string().describe('タスクID') },
    async ({ taskId }) => {
      await invokeIpc('ai:cancelGeneration', taskId)
      return text(`タスク ${taskId} の生成をキャンセルしました`)
    }
  )

  server.tool(
    'task_generation_status',
    'AI 生成の進捗を確認する。生成ログのエントリを返す。phase が "done" なら完了、"error" ならエラー。' +
    'task_generate のレスポンスで返ってきた since (ISO timestamp) を必ず指定すること。' +
    '指定しないと task_id の全期間ログから「最新」を返してしまい、別セッションで動かした古い生成を誤参照する。',
    {
      taskId: z.string().describe('タスクID'),
      since: z.string().optional().describe('ISO timestamp (task_generate のレスポンスで返ってきた since 値)。指定推奨。'),
      limit: z.number().optional().default(10).describe('取得するログ件数(デフォルト10)'),
    },
    async ({ taskId, since, limit }) => {
      const sinceFilter = since
        ? `AND created_at >= '${since.replace(/'/g, "''")}'`
        : ''
      const logs = dbQuery(
        `SELECT phase, message, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ${sinceFilter} ORDER BY created_at DESC LIMIT ${limit}`
      )
      if (!Array.isArray(logs) || logs.length === 0) {
        if (since) {
          return text(`since=${since} 以降の生成ログがありません。生成プロセスが起動していない可能性があります。`)
        }
        return text('生成ログがありません(まだ開始されていないか、タスクIDが間違っています)')
      }
      const latest = logs[0] as { phase: string; message: string }

      const pendingQuestions = await invokeIpc('ai:listPendingQuestions', taskId) as Array<{
        id: string; taskId: string; text: string; infoKey?: string; askedAt: string
      }>

      const status = pendingQuestions.length > 0 ? '❓ ユーザー質問待ち'
        : latest.phase === 'done' ? '✅ 完了'
        : latest.phase === 'error' ? '❌ エラー'
        : '⏳ 実行中'

      return json({
        status, latestPhase: latest.phase, latestMessage: latest.message, recentLogs: logs,
        pendingQuestions: pendingQuestions.length > 0 ? pendingQuestions : undefined,
        _hint: pendingQuestions.length > 0
          ? '★ ユーザーに質問が出ています。text をユーザーに見せ、回答を task_answer_question(questionId, answer) で返してください。'
          : !since
            ? '★ 警告: since を指定せずに呼ばれました。task_id の全期間から最新ログを返しているため、別セッションで動かした古い生成を誤参照する可能性があります。task_generate のレスポンスから since を取得して必ず指定してください。'
            : undefined,
      })
    }
  )

  // ─── Task Refactor ───

  server.tool(
    'task_refactor',
    'AIでタスクのステップコードを修正する。修正指示を送ると修正案（operations）を返す。',
    {
      taskId: z.string().describe('タスクID'),
      instruction: z.string().describe('修正指示（例: "タイムアウトを長くして"）'),
    },
    async ({ taskId, instruction }) => {
      const result = await invokeIpc('ai:refactorTask', { taskId, instruction, referenceTaskIds: [] })
      return json(result)
    }
  )

  // ─── Task Execution (async: start → poll status) ───

  server.tool(
    'task_run',
    'タスクを実行する(非同期)。実行を**開始要求**して即座に返るので、必ず task_run_status で完了を確認すること。完了確認なしに「成功」と判断してはいけない。',
    {
      taskId: z.string().describe('タスクID'),
      variables: z.record(z.string(), z.string()).optional().default({}).describe('実行変数(例: {"companyName": "株式会社xxx"})'),
    },
    async ({ taskId, variables }) => {
      let taskName = ''
      try {
        const task = await invokeIpc('task:get', taskId) as { id?: string; name?: string; steps?: unknown[] } | null
        if (!task || !task.id) {
          throw new Error(`taskId="${taskId}" のタスクが見つかりません。task_list で確認してください。`)
        }
        if (!Array.isArray(task.steps) || task.steps.length === 0) {
          throw new Error(`taskId="${taskId}" にはステップがありません。先に task_generate でステップを作成してください。`)
        }
        taskName = task.name ?? ''
      } catch (e) {
        throw new Error(`タスク取得に失敗: ${(e as Error).message}`)
      }

      const startedAt = new Date().toISOString()
      const execPromise = invokeIpc('runner:execute', taskId, variables)
      const earlyError = await Promise.race([
        execPromise.then(() => null as null | string).catch(e => `runner:execute が失敗: ${(e as Error).message}`),
        new Promise<null>(r => setTimeout(() => r(null), 1200)),
      ])
      execPromise.catch(e => {
        console.error(`[MCP] runner:execute eventually failed for ${taskId}:`, e)
      })

      if (earlyError) {
        throw new Error(earlyError)
      }

      const recentRows = dbQuery(
        `SELECT id, status, started_at FROM execution_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' AND started_at >= '${startedAt}' ORDER BY started_at DESC LIMIT 1`
      ) as Array<{ id: string; status: string; started_at: string }>

      if (recentRows.length === 0) {
        throw new Error(
          `task_run リクエストは送信されたが、execution_logs に新規エントリが見つかりません (${startedAt} 以降)。\n` +
          `runner:execute が起動していない可能性があります。Dodompa アプリのログを確認してください。`
        )
      }

      return text(
        `⏳ 実行 *リクエスト* を送信しました (まだ完了していません)。\n` +
        `タスク名: ${taskName}\n` +
        `taskId: ${taskId}\n` +
        `execution_id: ${recentRows[0].id}\n` +
        `started_at: ${recentRows[0].started_at}\n\n` +
        `★ 必ず task_run_status で完了 (status="success" or "failed") を確認してください。\n` +
        `★ task_run_status を呼ぶまで「成功した」と判断してはいけません。`
      )
    }
  )

  server.tool(
    'task_run_status',
    '指定した execution_id の実行進捗を確認する。task_run のレスポンスで返ってきた execution_id を必ず渡すこと。' +
    'execution_id を省略すると task_id の最新 execution を返すが、それは別のセッションで動かした古い実行を誤って参照してしまうことがあるため非推奨。',
    {
      taskId: z.string().describe('タスクID'),
      executionId: z.string().optional().describe('execution_id (task_run のレスポンスで返ってきた値)。指定推奨。'),
      limit: z.number().optional().default(10).describe('取得するステップログ件数'),
    },
    async ({ taskId, executionId, limit }) => {
      let exec: { id: string; status: string; started_at: string; finished_at: string | null; error: string | null } | undefined

      if (executionId) {
        const rows = dbQuery(
          `SELECT id, status, started_at, finished_at, error FROM execution_logs WHERE id = '${executionId.replace(/'/g, "''")}' LIMIT 1`
        ) as Array<typeof exec>
        exec = rows[0]
        if (!exec) {
          throw new Error(
            `execution_id="${executionId}" が見つかりません。\n` +
            `task_run のレスポンスから正しい execution_id を取得して再度呼んでください。`
          )
        }
      } else {
        const rows = dbQuery(
          `SELECT id, status, started_at, finished_at, error FROM execution_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ORDER BY started_at DESC LIMIT 1`
        ) as Array<typeof exec>
        exec = rows[0]
        if (!exec) return text('このタスクの実行ログがありません')
      }

      const steps = dbQuery(
        `SELECT step_id, status, error, started_at, finished_at FROM step_logs WHERE execution_id = '${exec.id.replace(/'/g, "''")}' ORDER BY started_at DESC LIMIT ${limit}`
      )

      const status = exec.status === 'success' ? '✅ 成功'
        : exec.status === 'failed' ? '❌ 失敗'
        : exec.status === 'running' ? '⏳ 実行中'
        : exec.status

      return json({
        status,
        execution: exec,
        recentSteps: steps,
        _hint: !executionId
          ? '★ 警告: execution_id を指定せずに呼ばれました。これは task_id の最新 execution を返すだけで、別セッションで動かした過去の実行を誤って参照する可能性があります。task_run のレスポンスから取得した execution_id を必ず指定してください。'
          : undefined,
      })
    }
  )

  // ─── Logs ───

  server.tool(
    'execution_logs',
    'タスクの実行履歴一覧を取得する。',
    {
      taskId: z.string().optional().describe('タスクID（省略で全タスク）'),
      limit: z.number().optional().default(20),
    },
    async ({ taskId, limit }) => {
      const result = await invokeIpc('log:listExecutions', taskId ?? undefined)
      const logs = Array.isArray(result) ? result.slice(0, limit) : result
      return json(logs)
    }
  )

  server.tool(
    'generation_logs',
    'AI生成ログを取得する（生成パイプラインの各フェーズの詳細）。',
    {
      taskId: z.string().describe('タスクID'),
      limit: z.number().optional().default(30),
    },
    async ({ taskId, limit }) => {
      const logs = dbQuery(
        `SELECT phase, message, substr(detail, 1, 500) as detail_preview, created_at FROM generation_step_logs WHERE task_id = '${taskId.replace(/'/g, "''")}' ORDER BY created_at DESC LIMIT ${limit}`
      )
      return json(logs)
    }
  )

  // ─── Utility ───

  server.tool(
    'dodompa_health',
    'Dodompaアプリが起動中か確認する。',
    {},
    async () => {
      return json({ connected: true, pid: process.pid })
    }
  )
}

export const DODOMPA_MCP_INSTRUCTIONS = `Dodompa は「AIのためのRPA」です。ユーザーがあらかじめ作成したタスク（Webブラウザ・macOSアプリの自動化）を実行できます。

## いつ使うか
1. **既存タスクの実行**: ユーザーが「〜のタスクを実行して」「〜を自動でやって」と言った時
   → まず task_list でタスク一覧と各タスクの instruction/goal を確認し、マッチするタスクがあれば task_run
2. **新規タスクの作成**: ユーザーが「〜を自動化したい」「〜のタスクを作って」と言った時
   → task_create → task_generate(AI が自動でステップ生成、非同期) → **task_generation_wait で完了待ち** (推奨) または task_generation_status をポーリング
   → 生成中に AI がユーザーに質問してきたら pendingQuestions が返るので、ユーザーに尋ねて task_answer_question で回答する
3. **既存タスクの修正**: ユーザーが「タスクの〜を変えて」と言った時
   → task_refactor で修正指示を送る
4. **ログ確認**: ユーザーが「前回の実行はどうなった？」と聞いた時
   → execution_logs / generation_logs

## 重要 (絶対に守ること)
- **task_list は毎回呼んで、ユーザーの要求に合うタスクがあるかを最初に確認すること**。各タスクの instruction/goal で何ができるかが分かる。
- タスク実行と生成は時間がかかる（数分〜）。task_run / task_generate は**開始要求**だけで即座に返る。
- **★ task_run / task_generate のレスポンスを「成功した」と解釈してはいけない**。これは「リクエストを送信した」だけ。
- **★ 必ず完了確認してから「完了」と報告すること**:
  - task_generate の後: **task_generation_wait** で完了まで待つ (推奨)、または task_generation_status (since 必須) をポーリング
  - task_run の後: task_run_status (executionId 必須) をポーリング、status が "success" or "failed" を確認
- **★ 生成中に pendingQuestions が返ったら**: ユーザーに text を見せて回答をもらい、task_answer_question(questionId, answer) で送信する。そうしないと生成が 5 分で自動タイムアウト (空文字で回答扱い) する。
- **★ ステップ数や所要時間を勝手に作って「✅ 全N ステップが正常完了、約N秒で完了」のように報告するのは禁止**。実際の status / step ログから取得した値だけ使うこと。`
