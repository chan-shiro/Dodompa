import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import fs from 'fs'
import { app } from 'electron'

const execFileAsync = promisify(execFile)

function getAxBinaryPath(): string {
  const devPath = path.join(app.getAppPath(), 'resources', 'bin', 'dodompa-ax')
  if (fs.existsSync(devPath)) return devPath
  const prodPath = path.join(process.resourcesPath, 'bin', 'dodompa-ax')
  if (fs.existsSync(prodPath)) return prodPath
  throw new Error('dodompa-ax binary not found')
}

async function runAx(args: string[]): Promise<void> {
  await execFileAsync(getAxBinaryPath(), args, { timeout: 5000 })
}

export async function click(x: number, y: number): Promise<void> {
  await runAx(['click', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
}

export async function doubleClick(x: number, y: number): Promise<void> {
  await click(x, y)
  await new Promise(r => setTimeout(r, 50))
  await click(x, y)
}

export async function rightClick(x: number, y: number): Promise<void> {
  await runAx(['right-click', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
}

export async function drag(
  fromX: number, fromY: number,
  toX: number, toY: number
): Promise<void> {
  await runAx([
    'drag',
    '--from-x', String(Math.round(fromX)),
    '--from-y', String(Math.round(fromY)),
    '--to-x', String(Math.round(toX)),
    '--to-y', String(Math.round(toY)),
  ])
}

export async function moveTo(x: number, y: number): Promise<void> {
  await runAx(['move', '--x', String(Math.round(x)), '--y', String(Math.round(y))])
}
