import { ipcMain, app } from 'electron'
import { v4 as uuid } from 'uuid'
import fs from 'fs'
import path from 'path'
import os from 'os'
import type { BrowserProfile } from '../../shared/types'

async function getChromium() {
  const pw = await import(/* @vite-ignore */ 'playwright-core')
  return pw.chromium
}

function getProfilesDir(): string {
  const dir = path.join(app.getPath('userData'), 'profiles')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getProfilePath(profileId: string): string {
  return path.join(getProfilesDir(), `${profileId}.json`)
}

function getProfileStoragePath(profileId: string): string {
  return path.join(getProfilesDir(), `${profileId}_storage.json`)
}

/**
 * Get an isolated user data dir for Playwright persistent context.
 * Each profile gets its own directory — the persistent context retains
 * all cookies, localStorage, and session data automatically.
 *
 * IMPORTANT: We use a path under the home directory WITHOUT spaces.
 * macOS "Application Support" contains a space which can cause issues
 * with Chrome's SingletonLock mechanism when launched from Electron.
 */
function getPlaywrightUserDataDir(profileId: string): string {
  // Prefer the new ~/.dodompa path. For continuity with pre-rebrand installs,
  // fall back to ~/.todone if it already exists — keeps existing logged-in
  // Chromium profiles working without migration.
  const newDir = path.join(os.homedir(), '.dodompa', 'pw-profiles', profileId)
  const legacyDir = path.join(os.homedir(), '.todone', 'pw-profiles', profileId)
  const dir = fs.existsSync(legacyDir) && !fs.existsSync(newDir) ? legacyDir : newDir
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function readAllProfiles(): BrowserProfile[] {
  const dir = getProfilesDir()
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.includes('_storage'))
  return files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')))
}

/**
 * Default shared profile ID used when a task doesn't specify its own profileId.
 * All tasks share this single persistent browser profile so that user logins
 * are preserved across tasks and sessions.
 */
const DEFAULT_SHARED_PROFILE_ID = '_shared_default'

/**
 * Find the Chrome executable path on the system.
 */
function findChromeExecutable(): string | undefined {
  const platform = process.platform
  if (platform === 'darwin') {
    const paths = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    ]
    return paths.find((p) => fs.existsSync(p))
  }
  if (platform === 'win32') {
    const paths = [
      path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
    ]
    return paths.find((p) => fs.existsSync(p))
  }
  if (platform === 'linux') {
    const paths = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium-browser']
    return paths.find((p) => fs.existsSync(p))
  }
  return undefined
}

/**
 * Resolve which Chrome executable to use.
 * Priority: general-settings.json > system Chrome > bundled Chromium (Chrome for Testing).
 *
 * System Chrome is preferred over bundled Chromium because:
 * - Session cookies and login state are more reliably persisted
 * - Less likely to be detected as bot by websites
 * - Better compatibility with modern auth flows (OAuth, passkeys, etc.)
 */
async function resolveExecutablePath(): Promise<string | undefined> {
  // 1. User-configured path in general-settings.json
  const generalSettingsPath = path.join(app.getPath('userData'), 'general-settings.json')
  try {
    const gs = JSON.parse(fs.readFileSync(generalSettingsPath, 'utf-8'))
    if (gs.playwrightExecutablePath && fs.existsSync(gs.playwrightExecutablePath)) {
      return gs.playwrightExecutablePath
    }
  } catch { /* */ }

  // 2. System Chrome (preferred over bundled Chromium for session persistence)
  const systemChrome = findChromeExecutable()
  if (systemChrome) {
    return systemChrome
  }

  // 3. Fall back to bundled Chromium (Chrome for Testing)
  return undefined
}

/**
 * Launch a persistent browser context for a profile.
 * The persistent context automatically retains cookies/localStorage/sessions
 * across launches without needing explicit storageState import/export.
 *
 * When profileId is empty or starts with '_auto_', the shared default profile
 * is used instead — this preserves user logins across all tasks.
 */
async function launchProfileBrowser(profileId: string) {
  const chromium = await getChromium()

  // Use shared default profile for auto-generated profile IDs.
  // This ensures user logins are preserved across tasks.
  const effectiveProfileId = (!profileId || profileId.startsWith('_auto_'))
    ? DEFAULT_SHARED_PROFILE_ID
    : profileId
  const userDataDir = getPlaywrightUserDataDir(effectiveProfileId)

  // Clean up stale lock files left by crashed/force-killed browser processes.
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(userDataDir, lockFile)
    try { fs.unlinkSync(lockPath) } catch { /* */ }
  }

  const executablePath = await resolveExecutablePath()

  // Check profile compatibility: if the profile was created by a different
  // Chrome major version, the data format may be incompatible (SIGTRAP crash).
  // Compare saved "Last Version" against bundled Chromium's known version.
  const lastVersionPath = path.join(userDataDir, 'Last Version')
  if (fs.existsSync(lastVersionPath)) {
    try {
      const savedVersion = fs.readFileSync(lastVersionPath, 'utf-8').trim()
      const savedMajor = parseInt(savedVersion.split('.')[0], 10)

      const pw = await import(/* @vite-ignore */ 'playwright-core')
      const browserPath = executablePath ?? pw.chromium.executablePath()
      const versionMatch = browserPath?.match(/(\d+)\.\d+\.\d+\.\d+/)
      const launchMajor = versionMatch ? parseInt(versionMatch[1], 10) : null

      if (savedMajor && launchMajor && savedMajor !== launchMajor) {
        console.warn(
          `Profile "${effectiveProfileId}" was created by Chrome ${savedMajor}, ` +
          `but current Chromium is ${launchMajor}. Resetting profile.`
        )
        fs.rmSync(userDataDir, { recursive: true, force: true })
        fs.mkdirSync(userDataDir, { recursive: true })
      }
    } catch {
      // Version check failed — continue anyway
    }
  }

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(executablePath ? { executablePath } : {}),
    // Playwright disables the Chromium sandbox by default (chromiumSandbox defaults to false),
    // which surfaces the "サポートされていないコマンドライン フラグ --no-sandbox を使用しています"
    // yellow warning bar at the top of the window. We don't need the sandbox disabled on
    // macOS user-land, so re-enable it.
    chromiumSandbox: true,
    args: [
      '--disable-session-crashed-bubble',   // Suppress "profile error" dialog
      '--hide-crash-restore-bubble',        // Suppress restore session bubble
    ],
    ignoreDefaultArgs: ['--enable-automation'],  // Hide "controlled by automation" bar
  })

  return context
}

// ─── IPC Handlers ───

export function registerProfileHandlers(): void {
  ipcMain.handle('profile:list', async () => {
    return readAllProfiles()
  })

  ipcMain.handle('profile:create', async (_event, name: string) => {
    const id = uuid()
    const now = new Date().toISOString()
    const profile: BrowserProfile = {
      id,
      name,
      storagePath: getProfileStoragePath(id),
      createdAt: now,
      updatedAt: now,
    }
    fs.writeFileSync(getProfilePath(id), JSON.stringify(profile, null, 2))
    return profile
  })

  ipcMain.handle('profile:delete', async (_event, profileId: string) => {
    const profileFile = getProfilePath(profileId)
    const storagePath = getProfileStoragePath(profileId)
    if (fs.existsSync(profileFile)) fs.unlinkSync(profileFile)
    if (fs.existsSync(storagePath)) fs.unlinkSync(storagePath)
    // Clean up persistent user data dir
    const userDataDir = getPlaywrightUserDataDir(profileId)
    if (fs.existsSync(userDataDir)) {
      fs.rmSync(userDataDir, { recursive: true, force: true })
    }
  })

  ipcMain.handle('profile:openBrowser', async (_event, profileId: string) => {
    const profileFile = getProfilePath(profileId)
    if (!fs.existsSync(profileFile)) {
      throw new Error(`Profile not found: ${profileId}`)
    }
    const profile: BrowserProfile = JSON.parse(fs.readFileSync(profileFile, 'utf-8'))

    const context = await launchProfileBrowser(profileId)

    const pages = context.pages()
    const page = pages.length > 0 ? pages[0] : await context.newPage()
    if (page.url() === 'about:blank') {
      await page.goto('https://www.google.com')
    }

    // Wait for user to close the browser, then save
    await new Promise<void>((resolve) => {
      context.on('close', () => resolve())
    })

    // Also save storageState as backup
    try {
      await context.storageState({ path: profile.storagePath })
    } catch {
      // Browser already closed
    }

    profile.updatedAt = new Date().toISOString()
    fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2))
  })
}

export {
  DEFAULT_SHARED_PROFILE_ID,
  getProfilesDir,
  getProfilePath,
  getProfileStoragePath,
  getPlaywrightUserDataDir,
  launchProfileBrowser,
}
